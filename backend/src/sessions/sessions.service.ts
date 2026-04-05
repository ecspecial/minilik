import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Express } from 'express';
import { AgentsService } from '../openai/agents.service';
import {
  type SalesChannel,
  type Scenario,
} from '../constants/economy-stubs';
import { calculateLine } from '../economy/economy-calculator';
import { normalizeIntakeAnalysis } from '../openai/analysis-normalize';
import { splitPurchasingResponse } from '../openai/parsing-helpers';
import type { AnalysisPatchDto } from './dto/analysis-patch.dto';
import type {
  IntakeContext,
  PipelineResult,
  SessionState,
} from './sessions.types';
import { SessionsPersistenceService } from './sessions-persistence.service';

const CHANNELS: SalesChannel[] = ['wb', 'ozon', 'site'];
const SCENARIOS: Scenario[] = ['pessimistic', 'base', 'optimistic'];

function bufferToDataUrl(mime: string, buf: Buffer): string {
  const m = mime || 'image/jpeg';
  return `data:${m};base64,${buf.toString('base64')}`;
}

/**
 * Данные для vision API: либо legacy dataUrl, либо чтение файла с диска (без хранения base64 в JSON).
 */
async function visionDataUrlsFromSession(
  sessionId: string,
  images: SessionState['images'],
  persistence: SessionsPersistenceService,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const im = images[i];
    if (im.dataUrl) {
      out.push(im.dataUrl);
      continue;
    }
    if (im.url) {
      const buf = await persistence.readSessionImage(sessionId, i);
      if (!buf) {
        throw new BadRequestException(`Файл фото ${i} не найден на сервере`);
      }
      out.push(bufferToDataUrl(im.mimeType, buf));
      continue;
    }
    throw new BadRequestException('Сессия содержит изображение без url и без dataUrl');
  }
  return out;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Промпт для генерации изображения: тип изделия + контент из photo / marketing brief.
 */
export function buildProductImagePrompt(
  analysis: Record<string, unknown>,
  photoStudio: unknown,
  marketer?: unknown,
): string {
  const vs = analysis.vision_summary as Record<string, unknown> | undefined;
  const typeRu = String(
    analysis.productType ?? vs?.product_type ?? 'одежда',
  ).trim();
  const season = String(analysis.season ?? vs?.season ?? '').trim();
  const details = String(analysis.details ?? '').trim();
  const materials = String(analysis.materials ?? '').trim();
  const silhouette = String(analysis.silhouette ?? vs?.silhouette ?? '').trim();

  const extraPrompts: string[] = [];
  if (typeof photoStudio === 'string' && photoStudio.trim()) {
    extraPrompts.push(photoStudio.trim().slice(0, 1200));
  } else if (photoStudio && typeof photoStudio === 'object') {
    const p = photoStudio as Record<string, unknown>;
    const pick = (k: string) => {
      const v = p[k];
      if (Array.isArray(v) && v.length)
        extraPrompts.push(String(v[0]).slice(0, 800));
    };
    pick('photo_prompts');
    pick('white_background_prompts');
    const vm = p.visualMood;
    if (typeof vm === 'string' && vm.trim()) extraPrompts.push(vm.trim().slice(0, 500));
  }

  if (typeof marketer === 'string' && marketer.trim()) {
    extraPrompts.push(marketer.trim().slice(0, 800));
  } else if (marketer && typeof marketer === 'object') {
    const m = marketer as Record<string, unknown>;
    const brief = m.photoshoot_brief as Record<string, unknown> | undefined;
    if (brief) {
      for (const k of ['angles', 'detail_shots', 'frames'] as const) {
        const v = brief[k];
        if (Array.isArray(v) && v.length) {
          extraPrompts.push(String(v[0]).slice(0, 400));
          break;
        }
      }
    }
  }

  const lines = [
    `CRITICAL: The product MUST be a "${typeRu}" (Russian garment category). Do NOT depict a jacket, coat, blazer, or unrelated category if the type is jumpsuit/overall/комбинезон — show a one-piece jumpsuit suitable for that type.`,
    `Garment type (required): ${typeRu}.`,
    season ? `Season: ${season}.` : '',
    silhouette ? `Silhouette: ${silhouette}.` : '',
    details ? `Construction/details: ${details.slice(0, 600)}` : '',
    materials ? `Materials/look: ${materials.slice(0, 400)}` : '',
    ...extraPrompts.map((s) => `Visual direction: ${s}`),
    'Single clean catalog product shot, neutral background, no text, no logo, photorealistic.',
  ];

  return lines.filter(Boolean).join('\n');
}

/** Извлекает три слоя себестоимости для калькулятора из buyer_json (client-update или legacy). */
function extractPurchasingCosts(p: Record<string, unknown>): {
  fabricCost: number;
  hardwareCost: number;
  productionCost: number;
} {
  const mcb = (p.material_cost_base as Record<string, unknown>) ?? {};
  const fabricCost = num(
    mcb.fabric_cost_per_unit,
    num(p.estimatedFabricCostRub, 1200),
  );
  const trimCost = num(
    mcb.trim_cost_per_unit,
    num(p.estimatedHardwareCostRub, 450),
  );
  const packagingCost = num(mcb.packaging_cost_per_unit, 0);
  const productionCost = num(
    p.manufacturing_cost_per_unit,
    num(p.estimatedProductionCostRub, 2800),
  );
  return {
    fabricCost,
    hardwareCost: trimCost + packagingCost,
    productionCost,
  };
}

/** Полный текст конструктора (этап 1 + опционально этап 2). */
function getConstructorContext(pipeline: PipelineResult | null | undefined): string {
  if (!pipeline) return '';
  const a = typeof pipeline.constructor === 'string' ? pipeline.constructor : '';
  const b =
    typeof pipeline.constructorStage2 === 'string' ? pipeline.constructorStage2 : '';
  if (a && b) {
    return `${a}\n\n---\nЭтап 2. Точные лекала\n---\n\n${b}`;
  }
  return a || b;
}

/** Шаг 8: сводный текст без JSON. */
function buildFinalPackageText(
  sessionId: string,
  analysis: Record<string, unknown>,
  pipeline: NonNullable<PipelineResult>,
  analysisReport?: string | null,
): string {
  const blocks: string[] = [];
  blocks.push('ИТОГОВЫЙ ПАКЕТ «УМНЫЙ АССОРТИМЕНТ»');
  blocks.push(`Сессия: ${sessionId}`);
  blocks.push(`Собрано: ${new Date().toISOString()}`);
  blocks.push('');
  if (analysisReport?.trim()) {
    blocks.push('=== 1. INTAKE / SKU ===');
    blocks.push(analysisReport.trim());
    blocks.push('');
  }
  blocks.push('=== Карточка (поля для_confirm) ===');
  blocks.push(
    `Тип: ${String(analysis.productType ?? '—')}; сезон: ${String(analysis.season ?? '—')}; силуэт: ${String(analysis.silhouette ?? '—')}`,
  );
  blocks.push(`Детали: ${String(analysis.details ?? '—')}`);
  blocks.push(`Материалы: ${String(analysis.materials ?? '—')}`);
  blocks.push('');
  if (typeof pipeline.constructor === 'string' && pipeline.constructor.trim()) {
    blocks.push('=== 2. КОНСТРУКТОР, этап 1 ===');
    blocks.push(pipeline.constructor.trim());
    blocks.push('');
  }
  if (typeof pipeline.constructorStage2 === 'string' && pipeline.constructorStage2.trim()) {
    blocks.push('=== 3. КОНСТРУКТОР, этап 2 (лекала) ===');
    blocks.push(pipeline.constructorStage2.trim());
    blocks.push('');
  }
  if (typeof pipeline.technologist === 'string' && pipeline.technologist.trim()) {
    blocks.push('=== 4. ТЕХНОЛОГ ===');
    blocks.push(pipeline.technologist.trim());
    blocks.push('');
  }
  if (typeof pipeline.purchasingReport === 'string' && pipeline.purchasingReport.trim()) {
    blocks.push('=== 5. ЗАКУПЩИК ===');
    blocks.push(pipeline.purchasingReport.trim());
    blocks.push('');
  }
  if (typeof pipeline.finance?.narrative === 'string' && pipeline.finance.narrative.trim()) {
    blocks.push('=== 6. ФИНАНСИСТ ===');
    blocks.push(pipeline.finance.narrative.trim());
    blocks.push('');
  }
  if (typeof pipeline.marketer === 'string' && pipeline.marketer.trim()) {
    blocks.push('=== 7. МАРКЕТОЛОГ ===');
    blocks.push(pipeline.marketer.trim());
    blocks.push('');
  }
  if (typeof pipeline.photoStudio === 'string' && pipeline.photoStudio.trim()) {
    blocks.push('=== 8. ФОТО / ВИЗУАЛ ===');
    blocks.push(pipeline.photoStudio.trim());
    blocks.push('');
  }
  const img = pipeline.generatedImageUrl;
  blocks.push('=== Медиа ===');
  blocks.push(
    img
      ? typeof img === 'string' && img.startsWith('data:')
        ? `Изображение изделия: data-url (~${Math.round(img.length / 1024)} KiB)`
        : `Изображение изделия: ${String(img).slice(0, 200)}`
      : 'Изображение изделия: нет',
  );
  blocks.push(
    pipeline.patternLayoutImageUrl
      ? `Лекала (картинка): ${String(pipeline.patternLayoutImageUrl).slice(0, 200)}`
      : 'Лекала (картинка): нет',
  );
  blocks.push(
    pipeline.technicalFlatImageUrl
      ? `Технический рисунок: ${String(pipeline.technicalFlatImageUrl).slice(0, 200)}`
      : 'Технический рисунок: нет',
  );
  blocks.push(
    pipeline.kidStudioImageUrl
      ? `Студия (lookbook): ${String(pipeline.kidStudioImageUrl).slice(0, 200)}`
      : 'Студия (lookbook): нет',
  );
  blocks.push('');
  blocks.push('=== Примечание ===');
  blocks.push(
    'Сводка собрана на бэкенде из текстов модулей. Противоречия между блоками не проверялись автоматически.',
  );
  return blocks.join('\n');
}

function resolvePipelineKey(
  moduleName: string,
): keyof Omit<PipelineResult, 'finance'> | 'finance' {
  const t = moduleName.trim().toLowerCase().replace(/-/g, '');
  if (t === 'constructor') return 'constructor';
  if (t === 'technologist') return 'technologist';
  if (t === 'buyer' || t === 'purchasing') return 'purchasing';
  if (t === 'marketer' || t === 'marketing') return 'marketer';
  if (t === 'photo' || t === 'photostudio' || t === 'visual')
    return 'photoStudio';
  if (t === 'finance') return 'finance';
  throw new BadRequestException(
    `Неизвестный модуль: ${moduleName}. Допустимо: constructor, technologist, purchasing, finance, marketer, photoStudio`,
  );
}

function sessionListLabel(s: SessionState): string {
  const pt =
    s.analysis && typeof (s.analysis as { productType?: unknown }).productType === 'string'
      ? String((s.analysis as { productType: string }).productType).trim()
      : '';
  if (pt) return pt;
  const brand = s.intakeContext?.brand?.trim();
  if (brand) return brand;
  return `Сессия ${s.id.slice(0, 8)}…`;
}

@Injectable()
export class SessionsService implements OnModuleInit {
  private readonly log = new Logger(SessionsService.name);
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly agents: AgentsService,
    private readonly persistence: SessionsPersistenceService,
  ) {}

  async onModuleInit(): Promise<void> {
    const loaded = await this.persistence.loadAll();
    for (const s of loaded) {
      if (!s.updatedAt) s.updatedAt = s.createdAt;
      this.sessions.set(s.id, s);
    }
    this.log.log(`из файлов загружено сессий: ${loaded.length}`);
  }

  /** Запись полной сессии в JSON (фото — ссылки url + файлы в images/, legacy — dataUrl). */
  private scheduleSave(s: SessionState): void {
    s.updatedAt = new Date().toISOString();
    void this.persistence.save(s).catch((e) =>
      this.log.error(`[${s.id}] ошибка сохранения сессии: ${String(e)}`),
    );
  }

  listSummaries(): {
    id: string;
    createdAt: string;
    updatedAt: string;
    pipelineMaxStep: number;
    analysisApproved: boolean | null;
    label: string;
    imageCount: number;
  }[] {
    return Array.from(this.sessions.values())
      .map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt ?? s.createdAt,
        pipelineMaxStep: s.pipelineMaxStep,
        analysisApproved: s.analysisApproved,
        label: sessionListLabel(s),
        imageCount: s.images?.length ?? 0,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  create(): SessionState {
    const id = randomUUID();
    this.log.log(`[${id}] создана новая сессия`);
    const now = new Date().toISOString();
    const s: SessionState = {
      id,
      images: [],
      analysis: null,
      analysisReport: null,
      analysisApproved: null,
      pipeline: null,
      pipelineMaxStep: 0,
      createdAt: now,
      updatedAt: now,
      intakeContext: {},
      artifactVersions: null,
    };
    this.sessions.set(id, s);
    this.scheduleSave(s);
    return s;
  }

  get(id: string): SessionState {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundException('Сессия не найдена');
    return s;
  }

  /** Байты превью для GET /sessions/:id/images/:index (файл на диске или legacy dataUrl). */
  async getSessionImageBytes(
    id: string,
    index: number,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const s = this.get(id);
    if (!Number.isInteger(index) || index < 0 || index >= s.images.length) {
      throw new NotFoundException('Изображение не найдено');
    }
    const meta = s.images[index];
    if (meta.url) {
      const buf = await this.persistence.readSessionImage(id, index);
      if (!buf) throw new NotFoundException('Файл изображения отсутствует');
      return {
        buffer: buf,
        mimeType: meta.mimeType || 'image/jpeg',
      };
    }
    if (meta.dataUrl) {
      const m = /^data:([^;,]+);base64,(.+)$/.exec(meta.dataUrl);
      if (!m) throw new NotFoundException('Повреждённое изображение в сессии');
      return {
        buffer: Buffer.from(m[2], 'base64'),
        mimeType: m[1],
      };
    }
    throw new NotFoundException('Изображение не найдено');
  }

  setIntakeContext(id: string, ctx: IntakeContext): SessionState {
    const s = this.get(id);
    s.intakeContext = { ...s.intakeContext, ...ctx };
    this.log.log(`[${id}] обновлён intakeContext`);
    this.scheduleSave(s);
    return s;
  }

  async attachImages(id: string, files: Express.Multer.File[]) {
    const s = this.get(id);
    if (!files?.length) {
      throw new BadRequestException('Загрузите хотя бы одно изображение');
    }
    if (files.length > 3) {
      throw new BadRequestException('Не более 3 изображений');
    }
    const sizes = files.map((f) => f.size);
    this.log.log(
      `[${id}] загрузка изображений: count=${files.length}, bytes=${sizes.join(', ')}`,
    );
    await this.persistence.clearSessionImages(id);
    s.images = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const mimeType = f.mimetype || 'image/jpeg';
      await this.persistence.writeSessionImage(id, i, f.buffer, mimeType);
      s.images.push({
        mimeType,
        url: `/sessions/${id}/images/${i}`,
      });
    }
    s.analysis = null;
    s.analysisReport = null;
    s.analysisApproved = null;
    s.pipeline = null;
    s.pipelineMaxStep = 0;
    this.scheduleSave(s);
    return s;
  }

  async runAnalysis(id: string): Promise<SessionState> {
    const s = this.get(id);
    if (!s.images.length) {
      throw new BadRequestException('Сначала загрузите изображения');
    }
    const urls = await visionDataUrlsFromSession(id, s.images, this.persistence);
    this.log.log(
      `[${id}] анализ изделия: старт (фото=${urls.length}), смотрите логи AI_TIMING`,
    );
    const t0 = performance.now();
    s.artifactVersions = this.agents.snapshotArtifactVersions();
    const { analysis, report } = await this.agents.analyzeProduct(
      urls,
      s.intakeContext,
    );
    s.analysis = analysis;
    s.analysisReport = report;
    const ms = Math.round(performance.now() - t0);
    this.log.log(
      `[${id}] анализ изделия: готово за ${ms}ms, productType=${String(s.analysis?.productType ?? '?')}`,
    );
    s.analysisApproved = null;
    s.pipeline = null;
    s.pipelineMaxStep = 0;
    this.scheduleSave(s);
    return s;
  }

  patchAnalysis(id: string, patch: AnalysisPatchDto): SessionState {
    const s = this.get(id);
    if (!s.analysis) {
      throw new BadRequestException('Нет результата анализа');
    }
    const prev = { ...s.analysis } as Record<string, unknown>;
    if (patch.productType !== undefined) prev.productType = patch.productType;
    if (patch.season !== undefined) prev.season = patch.season;
    if (patch.silhouette !== undefined) prev.silhouette = patch.silhouette;
    if (patch.details !== undefined) prev.details = patch.details;
    if (patch.materials !== undefined) prev.materials = patch.materials;
    if (patch.confidenceNotes !== undefined) {
      prev.confidenceNotes = patch.confidenceNotes;
    }

    const hadVs =
      prev.vision_summary !== null &&
      typeof prev.vision_summary === 'object' &&
      !Array.isArray(prev.vision_summary);
    const touchVs =
      patch.productType !== undefined ||
      patch.season !== undefined ||
      patch.silhouette !== undefined;
    if (hadVs || touchVs) {
      const vs = {
        ...(hadVs
          ? { ...(prev.vision_summary as Record<string, unknown>) }
          : {}),
      };
      if (patch.productType !== undefined) {
        vs.product_type = patch.productType;
      }
      if (patch.season !== undefined) {
        vs.season = patch.season;
      }
      if (patch.silhouette !== undefined) {
        vs.silhouette = patch.silhouette;
      }
      prev.vision_summary = vs;
    }

    s.analysis = normalizeIntakeAnalysis(prev);
    if (patch.analysisReport !== undefined) {
      s.analysisReport = patch.analysisReport;
    }
    this.log.log(`[${id}] карточка анализа обновлена вручную (patch)`);
    this.scheduleSave(s);
    return s;
  }

  setAnalysisDecision(id: string, approved: boolean): SessionState {
    const s = this.get(id);
    if (!s.analysis) {
      throw new BadRequestException('Нет результата анализа');
    }
    s.analysisApproved = approved;
    this.log.log(`[${id}] решение по анализу: approved=${approved}`);
    if (!approved) {
      s.pipeline = null;
      s.pipelineMaxStep = 0;
    }
    this.scheduleSave(s);
    return s;
  }

  /**
   * Один шаг цепочки (1…8). Шаг 1 сбрасывает pipeline.
   * … → image (7) → final package (8).
   */
  async runPipelineStep(id: string, step: number): Promise<SessionState> {
    if (step < 1 || step > 8 || !Number.isInteger(step)) {
      throw new BadRequestException('Шаг должен быть целым от 1 до 8');
    }
    const s = this.get(id);
    if (!s.analysis) {
      throw new BadRequestException('Сначала выполните анализ');
    }
    if (s.analysisApproved !== true) {
      throw new ForbiddenException(
        'Подтвердите анализ изделия перед запуском цепочки',
      );
    }

    await this.runPipelineStepInternal(s, step);
    this.scheduleSave(s);
    return s;
  }

  /** Полная цепочка одним запросом (для совместимости). */
  async runPipeline(id: string): Promise<SessionState> {
    const s = this.get(id);
    if (!s.analysis) {
      throw new BadRequestException('Сначала выполните анализ');
    }
    if (s.analysisApproved !== true) {
      throw new ForbiddenException(
        'Подтвердите анализ изделия перед запуском цепочки',
      );
    }

    const pipelineStart = performance.now();
    this.log.log(`[${id}] pipeline (full): последовательные шаги 1–8`);
    s.pipeline = {};
    s.pipelineMaxStep = 0;
    for (let i = 1; i <= 8; i++) {
      await this.runPipelineStepInternal(s, i);
      if (
        i === 1 &&
        s.pipeline &&
        typeof s.pipeline.constructor === 'string' &&
        s.pipeline.constructor.trim()
      ) {
        try {
          const s2 = await this.agents.runConstructorStage2Text(
            s.analysis!,
            s.pipeline.constructor,
          );
          s.pipeline.constructorStage2 = s2;
          this.log.log(`[${s.id}] full pipeline: точные лекала готовы`);
          await this.tryAttachPatternLayoutImage(s);
        } catch (e) {
          this.log.warn(`[${s.id}] точные лекала пропущены: ${String(e)}`);
        }
      }
    }
    this.log.log(
      `[${id}] pipeline (full): ВСЁ ГОТОВО за ${Math.round(performance.now() - pipelineStart)}ms`,
    );
    this.scheduleSave(s);
    return s;
  }

  private async runPipelineStepInternal(
    s: SessionState,
    step: number,
  ): Promise<void> {
    const id = s.id;
    const analysis = s.analysis!;

    if (step === 1) {
      this.log.log(`[${id}] pipeline step 1/8: конструктор + draft patterns (сброс отчёта)`);
      s.pipeline = {};
      s.pipelineMaxStep = 0;
      s.artifactVersions = this.agents.snapshotArtifactVersions();

      const step1Start = performance.now();
      const constructorText = await this.agents.runConstructorStage1Text(
        analysis,
      );
      s.pipeline.constructor = constructorText;
      s.pipelineMaxStep = 1;
      this.log.log(
        `[${id}] pipeline step 1 готов за ${Math.round(performance.now() - step1Start)}ms`,
      );
      return;
    }

    if (s.pipelineMaxStep !== step - 1) {
      throw new BadRequestException(
        `Сначала выполните шаг ${s.pipelineMaxStep + 1} цепочки`,
      );
    }

    if (!s.pipeline) {
      s.pipeline = {};
    }

    if (step === 2) {
      this.log.log(`[${id}] pipeline step 2/8: технолог`);
      const c = getConstructorContext(s.pipeline);
      if (!c.trim()) {
        throw new BadRequestException('Нет данных конструктора (шаг 1)');
      }
      const t0 = performance.now();
      const technologistText = await this.agents.runTechnologistText(
        analysis,
        c,
      );
      s.pipeline.technologist = technologistText;
      s.pipelineMaxStep = 2;
      this.log.log(
        `[${id}] pipeline step 2 готов за ${Math.round(performance.now() - t0)}ms`,
      );
      return;
    }

    if (step === 3) {
      this.log.log(`[${id}] pipeline step 3/8: закупщик / материалы`);
      const c = getConstructorContext(s.pipeline);
      const tch =
        typeof s.pipeline.technologist === 'string'
          ? s.pipeline.technologist
          : '';
      if (!c.trim() || !tch.trim()) {
        throw new BadRequestException('Нужны конструктор и технолог (шаги 1–2)');
      }
      const t0 = performance.now();
      const purchasingRaw = await this.agents.runPurchasingText(
        analysis,
        c,
        tch,
        s.intakeContext,
      );
      const { report, costing } = splitPurchasingResponse(purchasingRaw);
      s.pipeline.purchasingReport = report;
      s.pipeline.purchasing = costing;
      s.pipelineMaxStep = 3;
      this.log.log(
        `[${id}] pipeline step 3 готов за ${Math.round(performance.now() - t0)}ms`,
      );
      return;
    }

    if (step === 4) {
      this.log.log(`[${id}] pipeline step 4/8: расчёт сеток + AI-финансист`);
      const p = s.pipeline.purchasing as Record<string, unknown> | undefined;
      if (!p) {
        throw new BadRequestException('Нет данных закупщика (шаг 3)');
      }

      const tCalc0 = performance.now();
      const { fabricCost, hardwareCost, productionCost } =
        extractPurchasingCosts(p);

      const lines = {} as NonNullable<PipelineResult['finance']>['lines'];
      for (const ch of CHANNELS) {
        lines[ch] = {} as Record<Scenario, ReturnType<typeof calculateLine>>;
        for (const sc of SCENARIOS) {
          lines[ch][sc] = calculateLine({
            fabricCost,
            hardwareCost,
            productionCost,
            channel: ch,
            scenario: sc,
          });
        }
      }
      this.log.log(
        `[${id}] локальный расчёт 9 сеток занял ${Math.round(performance.now() - tCalc0)}ms`,
      );

      const tNarr = performance.now();
      const narrative = await this.agents.runFinanceNarrative({
        analysis,
        purchasing: p,
        economyByChannel: lines as Record<
          SalesChannel,
          Record<string, Record<string, unknown>>
        >,
      });
      this.log.log(
        `[${id}] narrative финансиста за ${Math.round(performance.now() - tNarr)}ms, len=${narrative.length}`,
      );

      s.pipeline.finance = { lines, narrative };
      s.pipelineMaxStep = 4;
      return;
    }

    if (step === 5) {
      this.log.log(`[${id}] pipeline step 5/8: маркетолог`);
      const c = getConstructorContext(s.pipeline);
      const tch =
        typeof s.pipeline.technologist === 'string'
          ? s.pipeline.technologist
          : '';
      const buyerRep = s.pipeline.purchasingReport ?? '';
      const p = s.pipeline.purchasing as Record<string, unknown> | undefined;
      const fin = s.pipeline.finance;
      if (!c.trim() || !tch.trim() || !p || !fin) {
        throw new BadRequestException('Нужны шаги 1–4 перед маркетингом');
      }
      const t0 = performance.now();
      const economyJson = JSON.stringify(fin.lines, null, 2);
      const costingJson = JSON.stringify(p, null, 2);
      const marketerText = await this.agents.runMarketerText(
        analysis,
        c,
        tch,
        buyerRep,
        costingJson,
        fin.narrative,
        economyJson,
      );
      s.pipeline.marketer = marketerText;
      s.pipelineMaxStep = 5;
      this.log.log(
        `[${id}] pipeline step 5 готов за ${Math.round(performance.now() - t0)}ms`,
      );
      return;
    }

    if (step === 6) {
      this.log.log(`[${id}] pipeline step 6/8: фото / визуальные промпты`);
      const m =
        typeof s.pipeline.marketer === 'string' ? s.pipeline.marketer : '';
      if (!m.trim()) {
        throw new BadRequestException('Нет маркетинга (шаг 5)');
      }
      const t0 = performance.now();
      const photoStudioText = await this.agents.runPhotoStudioText(analysis, m);
      s.pipeline.photoStudio = photoStudioText;
      s.pipelineMaxStep = 6;
      this.log.log(
        `[${id}] pipeline step 6 готов за ${Math.round(performance.now() - t0)}ms`,
      );
      return;
    }

    if (step === 7) {
      this.log.log(`[${id}] pipeline step 7/8: генерация изображения`);
      const photoStudio = s.pipeline.photoStudio;
      const marketer = s.pipeline.marketer;
      const t0 = performance.now();
      const prompt = buildProductImagePrompt(analysis, photoStudio, marketer);
      this.log.log(
        `[${id}] image prompt length=${prompt.length}, type=${String(analysis.productType)}`,
      );
      const generatedImageUrl = await this.agents.generateGalleryImage(prompt);
      s.pipeline.generatedImageUrl = generatedImageUrl;
      s.pipelineMaxStep = 7;
      this.log.log(
        `[${id}] pipeline step 7 готов за ${Math.round(performance.now() - t0)}ms, hasImage=${Boolean(generatedImageUrl)}`,
      );
      return;
    }

    if (step === 8) {
      this.log.log(`[${id}] pipeline step 8/8: Final Package (локальная сборка, без LLM)`);
      if (!s.pipeline.finance) {
        throw new BadRequestException('Нет финансового блока (шаг 4)');
      }
      const t0 = performance.now();
      s.pipeline.finalPackage = buildFinalPackageText(
        id,
        analysis,
        s.pipeline,
        s.analysisReport,
      );
      s.pipelineMaxStep = 8;
      this.log.log(
        `[${id}] final package (local) за ${Math.round(performance.now() - t0)}ms`,
      );
    }
  }

  /** §9 пересчёт одного модуля (возвращает ответ ИИ + обновлённую сессию). */
  async recalculateModule(
    id: string,
    targetModule: string,
    updatedInputs?: Record<string, unknown>,
  ): Promise<SessionState> {
    const s = this.get(id);
    if (s.analysisApproved !== true || !s.analysis) {
      throw new ForbiddenException('Подтвердите анализ и имейте активную сессию');
    }
    if (!s.pipeline) {
      throw new BadRequestException('Сначала запустите цепочку хотя бы до нужного модуля');
    }
    const key = resolvePipelineKey(targetModule);
    if (key === 'finance') {
      throw new BadRequestException(
        'Пересчёт finance через этот эндпоинт не поддержан — перезапустите шаг 4 цепочки',
      );
    }
    const currentModuleJson = s.pipeline[key];
    const dependency_context: Record<string, unknown> = {
      has_constructor: Boolean(s.pipeline.constructor),
      has_technologist: Boolean(s.pipeline.technologist),
      has_purchasing: Boolean(s.pipeline.purchasing),
    };
    const res = await this.agents.runModuleRecalculation({
      target_module: key,
      current_master_json: s.analysis,
      current_module_json: currentModuleJson ?? {},
      updated_inputs: updatedInputs ?? {},
      dependency_context,
    });
    const out =
      (res.new_module_output as unknown) ??
      (res.new_output as unknown) ??
      res;
    if (out && typeof out === 'object' && s.pipeline) {
      if (!('parseError' in out && (out as { parseError?: boolean }).parseError)) {
        (s.pipeline as Record<string, unknown>)[key] = out;
      }
    }
    this.scheduleSave(s);
    return s;
  }

  /** §11 слияние ручных правок с JSON модуля */
  async mergeHumanEdits(
    id: string,
    moduleName: string,
    userEdits: Record<string, unknown>,
  ): Promise<SessionState> {
    const s = this.get(id);
    if (!s.pipeline) {
      throw new BadRequestException('Нет данных pipeline');
    }
    const key = resolvePipelineKey(moduleName);
    if (key === 'finance') {
      throw new BadRequestException('merge для finance не поддержан в MVP');
    }
    const prev = s.pipeline[key];
    const res = await this.agents.runHumanEditMerge({
      module_name: key,
      previous_ai_json: prev ?? {},
      user_edits: userEdits,
    });
    const merged = res.merged_result ?? res;
    if (merged && typeof merged === 'object' && s.pipeline) {
      if (!('parseError' in merged && (merged as { parseError?: boolean }).parseError)) {
        (s.pipeline as Record<string, unknown>)[key] = merged;
      }
    }
    this.scheduleSave(s);
    return s;
  }

  /** Схема лекал: только по тексту «точные лекала» (этап 2), иначе размеры на рисунке ненадёжны. */
  async runPatternLayoutImage(id: string): Promise<SessionState> {
    const s = this.get(id);
    const stage2 = s.pipeline?.constructorStage2;
    if (typeof stage2 !== 'string' || !stage2.trim()) {
      throw new BadRequestException(
        'Сначала выполните этап «точные лекала» (конструктор, этап 2). Схема строится только по нему — без этого значения на изображении будут приблизительными.',
      );
    }
    const stage1 = s.pipeline?.constructor;
    if (typeof stage1 !== 'string' || !stage1.trim()) {
      throw new BadRequestException('Нужен черновой конструктор (шаг 1 цепочки)');
    }
    const t0 = performance.now();
    const sheet = await this.agents.runLekalaLayoutSheetText(
      s.analysis!,
      stage1.trim(),
      stage2.trim(),
    );
    if (!s.pipeline) s.pipeline = {};
    s.pipeline.lekalaLayoutSheetText = sheet;
    s.pipeline.patternTechPackSheetText = sheet;
    const url = await this.agents.generatePatternLayoutImage(stage2.trim(), {
      usePreciseStage2: true,
      techPackSheetText: sheet,
    });
    s.pipeline.patternLayoutImageUrl = url;
    this.log.log(
      `[${id}] pattern layout image: ${url ? 'ok' : 'пусто'} за ${Math.round(performance.now() - t0)}ms`,
    );
    this.scheduleSave(s);
    return s;
  }

  /** Технический рисунок изделия (спереди/сзади) — отдельно от лекал. */
  async runTechnicalFlatImage(id: string): Promise<SessionState> {
    const s = this.get(id);
    const ctx = s.pipeline ? getConstructorContext(s.pipeline) : '';
    if (!ctx.trim()) {
      throw new BadRequestException(
        'Нужен конструктор (этап 1 или 1+2), чтобы построить технический рисунок',
      );
    }
    const t0 = performance.now();
    const url = await this.agents.generateTechnicalFlatSketchImage(ctx);
    if (!s.pipeline) s.pipeline = {};
    s.pipeline.technicalFlatImageUrl = url;
    this.log.log(
      `[${id}] technical flat image: ${url ? 'ok' : 'пусто'} за ${Math.round(performance.now() - t0)}ms`,
    );
    this.scheduleSave(s);
    return s;
  }

  /** Студийный lookbook на модели (детской или взрослой — по карточке изделия). */
  async runKidStudioImage(id: string): Promise<SessionState> {
    const s = this.get(id);
    if (!s.analysis) {
      throw new BadRequestException('Нужен анализ изделия');
    }
    const a = s.analysis;
    const bits: string[] = [];
    for (const k of [
      'productType',
      'season',
      'silhouette',
      'details',
      'materials',
    ] as const) {
      const v = a[k];
      if (v != null && String(v).trim()) bits.push(String(v));
    }
    if (s.analysisReport?.trim()) {
      bits.push(s.analysisReport.trim().slice(0, 1500));
    }
    const c =
      typeof s.pipeline?.constructor === 'string'
        ? s.pipeline.constructor.slice(0, 2500)
        : '';
    if (c.trim()) bits.push(`Техлист: ${c.trim()}`);
    const garmentDescription = bits.join('. ');
    if (!garmentDescription.trim()) {
      throw new BadRequestException('Недостаточно данных для описания образа');
    }
    const t0 = performance.now();
    const url = await this.agents.generateStudioLookbookImage(
      garmentDescription,
    );
    if (!s.pipeline) s.pipeline = {};
    s.pipeline.kidStudioImageUrl = url;
    this.log.log(
      `[${id}] kid studio image: ${url ? 'ok' : 'пусто'} за ${Math.round(performance.now() - t0)}ms`,
    );
    this.scheduleSave(s);
    return s;
  }

  private async tryAttachPatternLayoutImage(s: SessionState): Promise<void> {
    const stage2 = s.pipeline?.constructorStage2;
    if (typeof stage2 !== 'string' || !stage2.trim()) return;
    const id = s.id;
    try {
      const t0 = performance.now();
      const stage1 = typeof s.pipeline?.constructor === 'string' ? s.pipeline.constructor : '';
      if (!stage1.trim() || !s.analysis) {
        this.log.warn(`[${id}] полный прогон: техкарта пропущена — нет этапа 1 или анализа`);
        return;
      }
      const sheet = await this.agents.runLekalaLayoutSheetText(
        s.analysis,
        stage1.trim(),
        stage2.trim(),
      );
      if (!s.pipeline) s.pipeline = {};
      s.pipeline.lekalaLayoutSheetText = sheet;
      s.pipeline.patternTechPackSheetText = sheet;
      const url = await this.agents.generatePatternLayoutImage(stage2.trim(), {
        usePreciseStage2: true,
        techPackSheetText: sheet,
      });
      s.pipeline.patternLayoutImageUrl = url;
      this.log.log(
        `[${id}] full pipeline: схема лекал за ${Math.round(performance.now() - t0)}ms`,
      );
    } catch (e) {
      this.log.warn(
        `[${id}] полный прогон: схема лекал пропущена (${String(e)})`,
      );
    }
  }

  /** §12 draft-лекала → инструкции рендера */
  async runPatternRender(id: string): Promise<unknown> {
    const s = this.get(id);
    const ctx = s.pipeline ? getConstructorContext(s.pipeline) : '';
    if (!s.analysis || !ctx.trim()) {
      throw new BadRequestException('Нужны анализ и блок конструктора');
    }
    const result = await this.agents.runPatternRenderInterpreterText(
      s.analysis,
      ctx,
    );
    if (!s.pipeline) s.pipeline = {};
    s.pipeline.patternRender = result;
    this.scheduleSave(s);
    return result;
  }

  /** §13 рыночные ориентиры цен */
  async runMarketPriceHelp(id: string): Promise<unknown> {
    const s = this.get(id);
    if (!s.pipeline?.purchasing) {
      throw new BadRequestException('Нужен блок закупщика (шаг 3)');
    }
    const p = s.pipeline.purchasing as Record<string, unknown>;
    return this.agents.runMarketPriceEstimateText({
      fabric_candidates: p.fabric_options ?? [],
      trim_candidates: p.trim_list ?? [],
      market_context: p.price_sources ?? {},
    });
  }

  /** Конструктор этап 2 (точные лекала) — между шагом 1 и 2, без смены pipelineMaxStep */
  async runConstructorStage2(id: string): Promise<SessionState> {
    const s = this.get(id);
    if (s.pipelineMaxStep < 1) {
      throw new BadRequestException('Сначала выполните шаг 1 (конструктор)');
    }
    const stage1 = s.pipeline?.constructor;
    if (typeof stage1 !== 'string' || !stage1.trim()) {
      throw new BadRequestException('Нет текста этапа 1 конструктора');
    }
    const t0 = performance.now();
    const stage2 = await this.agents.runConstructorStage2Text(
      s.analysis!,
      stage1,
    );
    if (!s.pipeline) s.pipeline = {};
    s.pipeline.constructorStage2 = stage2;
    this.log.log(
      `[${id}] конструктор этап 2 готов за ${Math.round(performance.now() - t0)}ms`,
    );
    this.scheduleSave(s);
    return s;
  }
}
