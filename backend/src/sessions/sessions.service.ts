import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Express } from 'express';
import { AgentsService } from '../openai/agents.service';
import {
  type SalesChannel,
  type Scenario,
} from '../constants/economy-stubs';
import { calculateLine } from '../economy/economy-calculator';
import type {
  IntakeContext,
  PipelineResult,
  SessionState,
} from './sessions.types';

const CHANNELS: SalesChannel[] = ['wb', 'ozon', 'site'];
const SCENARIOS: Scenario[] = ['pessimistic', 'base', 'optimistic'];

function toDataUrl(file: Express.Multer.File): { mimeType: string; dataUrl: string } {
  const mime = file.mimetype || 'image/jpeg';
  const b64 = file.buffer.toString('base64');
  return { mimeType: mime, dataUrl: `data:${mime};base64,${b64}` };
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
  if (photoStudio && typeof photoStudio === 'object') {
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

  if (marketer && typeof marketer === 'object') {
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

@Injectable()
export class SessionsService {
  private readonly log = new Logger(SessionsService.name);
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly agents: AgentsService) {}

  create(): SessionState {
    const id = randomUUID();
    this.log.log(`[${id}] создана новая сессия`);
    const s: SessionState = {
      id,
      images: [],
      analysis: null,
      analysisApproved: null,
      pipeline: null,
      pipelineMaxStep: 0,
      createdAt: new Date().toISOString(),
      intakeContext: {},
      artifactVersions: null,
    };
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): SessionState {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundException('Сессия не найдена');
    return s;
  }

  setIntakeContext(id: string, ctx: IntakeContext): SessionState {
    const s = this.get(id);
    s.intakeContext = { ...s.intakeContext, ...ctx };
    this.log.log(`[${id}] обновлён intakeContext`);
    return s;
  }

  attachImages(id: string, files: Express.Multer.File[]) {
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
    s.images = files.map((f) => {
      const { mimeType, dataUrl } = toDataUrl(f);
      return { mimeType, dataUrl };
    });
    s.analysis = null;
    s.analysisApproved = null;
    s.pipeline = null;
    s.pipelineMaxStep = 0;
    return s;
  }

  async runAnalysis(id: string): Promise<SessionState> {
    const s = this.get(id);
    if (!s.images.length) {
      throw new BadRequestException('Сначала загрузите изображения');
    }
    const urls = s.images.map((i) => i.dataUrl);
    this.log.log(
      `[${id}] анализ изделия: старт (фото=${urls.length}), смотрите логи AI_TIMING`,
    );
    const t0 = performance.now();
    s.artifactVersions = this.agents.snapshotArtifactVersions();
    s.analysis = await this.agents.analyzeProduct(urls, s.intakeContext);
    const ms = Math.round(performance.now() - t0);
    this.log.log(
      `[${id}] анализ изделия: готово за ${ms}ms, productType=${String(s.analysis?.productType ?? '?')}`,
    );
    s.analysisApproved = null;
    s.pipeline = null;
    s.pipelineMaxStep = 0;
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
    }
    this.log.log(
      `[${id}] pipeline (full): ВСЁ ГОТОВО за ${Math.round(performance.now() - pipelineStart)}ms`,
    );
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
      const constructorJson = await this.agents.runConstructor(analysis);
      s.pipeline.constructor = constructorJson;
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
      const c = s.pipeline.constructor as Record<string, unknown> | undefined;
      if (!c) {
        throw new BadRequestException('Нет данных конструктора (шаг 1)');
      }
      const t0 = performance.now();
      const technologistJson = await this.agents.runTechnologist(analysis, c);
      s.pipeline.technologist = technologistJson;
      s.pipelineMaxStep = 2;
      this.log.log(
        `[${id}] pipeline step 2 готов за ${Math.round(performance.now() - t0)}ms`,
      );
      return;
    }

    if (step === 3) {
      this.log.log(`[${id}] pipeline step 3/8: закупщик / материалы`);
      const c = s.pipeline.constructor as Record<string, unknown> | undefined;
      const tch = s.pipeline.technologist as Record<string, unknown> | undefined;
      if (!c || !tch) {
        throw new BadRequestException('Нужны конструктор и технолог (шаги 1–2)');
      }
      const t0 = performance.now();
      const purchasingJson = await this.agents.runPurchasing(
        analysis,
        c,
        tch,
        s.intakeContext,
      );
      s.pipeline.purchasing = purchasingJson;
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

      let ai_calculation_doc: unknown = null;
      try {
        ai_calculation_doc = await this.agents.runFinanceCalculationDoc({
          master_json: analysis,
          buyer_json: p,
          material_cost_summary: {
            fabricCost,
            hardwareCost,
            productionCost,
          },
          economy_by_channel: lines as unknown as Record<string, unknown>,
        });
      } catch (e) {
        this.log.warn(`[${id}] runFinanceCalculationDoc: ${String(e)}`);
      }

      s.pipeline.finance = { lines, narrative, ai_calculation_doc };
      s.pipelineMaxStep = 4;
      return;
    }

    if (step === 5) {
      this.log.log(`[${id}] pipeline step 5/8: маркетолог`);
      const c = s.pipeline.constructor as Record<string, unknown> | undefined;
      const tch = s.pipeline.technologist as Record<string, unknown> | undefined;
      const p = s.pipeline.purchasing as Record<string, unknown> | undefined;
      const fin = s.pipeline.finance;
      if (!c || !tch || !p || !fin) {
        throw new BadRequestException('Нужны шаги 1–4 перед маркетингом');
      }
      const financePayload = {
        lines: fin.lines,
        narrative: fin.narrative,
        ai_calculation_doc: fin.ai_calculation_doc,
      };
      const t0 = performance.now();
      const marketerJson = await this.agents.runMarketer(
        analysis,
        c,
        tch,
        p,
        financePayload as unknown as Record<string, unknown>,
      );
      s.pipeline.marketer = marketerJson;
      s.pipelineMaxStep = 5;
      this.log.log(
        `[${id}] pipeline step 5 готов за ${Math.round(performance.now() - t0)}ms`,
      );
      return;
    }

    if (step === 6) {
      this.log.log(`[${id}] pipeline step 6/8: фото / визуальные промпты`);
      const m = s.pipeline.marketer as Record<string, unknown> | undefined;
      if (!m) {
        throw new BadRequestException('Нет маркетинга (шаг 5)');
      }
      const t0 = performance.now();
      const photoStudioJson = await this.agents.runPhotoStudio(analysis, m);
      s.pipeline.photoStudio = photoStudioJson;
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
      this.log.log(`[${id}] pipeline step 8/8: Final Package Assembly`);
      const fin = s.pipeline.finance;
      if (!fin) {
        throw new BadRequestException('Нет финансового блока (шаг 4)');
      }
      const t0 = performance.now();
      // ai_calculation_doc дублирует сетки и раздувает запрос; в сессии он уже в pipeline.finance
      const finance_for_assembly = {
        lines: fin.lines,
        narrative: fin.narrative,
      };
      const img = s.pipeline.generatedImageUrl;
      const imgHint =
        typeof img === 'string' && img.startsWith('data:')
          ? `(data URL ~${Math.round(img.length / 1024)} KiB — не уходит в OpenAI)`
          : String(img ?? 'none').slice(0, 120);
      this.log.log(
        `[${id}] final package: finance_doc omitted from LLM payload; image ref: ${imgHint}`,
      );
      const finalPackage = await this.agents.runFinalPackageAssembly({
        master_json: analysis,
        constructor_json: s.pipeline.constructor,
        technologist_json: s.pipeline.technologist,
        buyer_json: s.pipeline.purchasing,
        finance_json: finance_for_assembly,
        marketing_json: s.pipeline.marketer,
        photo_json: s.pipeline.photoStudio,
        generated_image_url: s.pipeline.generatedImageUrl ?? null,
      });
      s.pipeline.finalPackage = finalPackage;
      s.pipelineMaxStep = 8;
      this.log.log(
        `[${id}] final package за ${Math.round(performance.now() - t0)}ms`,
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
    return s;
  }

  /** §12 draft-лекала → инструкции рендера */
  async runPatternRender(id: string): Promise<unknown> {
    const s = this.get(id);
    if (!s.analysis || !s.pipeline?.constructor) {
      throw new BadRequestException('Нужны анализ и блок конструктора');
    }
    const result = await this.agents.runPatternRenderInterpreter(
      s.analysis,
      s.pipeline.constructor as Record<string, unknown>,
    );
    if (!s.pipeline) s.pipeline = {};
    s.pipeline.patternRender = result;
    return result;
  }

  /** §13 рыночные ориентиры цен */
  async runMarketPriceHelp(id: string): Promise<unknown> {
    const s = this.get(id);
    if (!s.pipeline?.purchasing) {
      throw new BadRequestException('Нужен buyer_json (шаг 3)');
    }
    const p = s.pipeline.purchasing as Record<string, unknown>;
    return this.agents.runMarketPriceEstimate({
      fabric_candidates: p.fabric_options ?? [],
      trim_candidates: p.trim_list ?? [],
      market_context: p.price_sources ?? {},
    });
  }
}
