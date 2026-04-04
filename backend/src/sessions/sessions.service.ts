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
import type { PipelineResult, SessionState } from './sessions.types';

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
 * Промпт для генерации изображения: жёстко фиксирах тип изделия из анализа,
 * чтобы не путать с другими категориями (напр. куртка вместо комбинезона).
 */
export function buildProductImagePrompt(
  analysis: Record<string, unknown>,
  photoStudio: unknown,
): string {
  const typeRu = String(analysis.productType ?? 'одежда').trim();
  const season = String(analysis.season ?? '').trim();
  const details = String(analysis.details ?? '').trim();
  const materials = String(analysis.materials ?? '').trim();
  const silhouette = String(analysis.silhouette ?? '').trim();

  let mood = '';
  if (photoStudio && typeof photoStudio === 'object') {
    const vm = (photoStudio as { visualMood?: string }).visualMood;
    if (typeof vm === 'string' && vm.length > 0) mood = vm.trim();
  }

  const lines = [
    `CRITICAL: The product MUST be a "${typeRu}" (Russian garment category). Do NOT depict a jacket, coat, blazer, or unrelated category if the type is jumpsuit/overall/комбинезон — show a one-piece jumpsuit suitable for that type.`,
    `Garment type (required): ${typeRu}.`,
    season ? `Season: ${season}.` : '',
    silhouette ? `Silhouette: ${silhouette}.` : '',
    details ? `Construction/details: ${details.slice(0, 600)}` : '',
    materials ? `Materials/look: ${materials.slice(0, 400)}` : '',
    mood ? `Shoot mood (secondary): ${mood.slice(0, 500)}` : '',
    'Single clean catalog product shot, neutral background, no text, no logo, photorealistic.',
  ];

  return lines.filter(Boolean).join('\n');
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
    };
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): SessionState {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundException('Сессия не найдена');
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
    s.analysis = await this.agents.analyzeProduct(urls);
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
   * Один шаг цепочки (1…5). Шаг 1 сбрасывает предыдущий pipeline.
   */
  async runPipelineStep(id: string, step: number): Promise<SessionState> {
    if (step < 1 || step > 5 || !Number.isInteger(step)) {
      throw new BadRequestException('Шаг должен быть целым от 1 до 5');
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
    this.log.log(`[${id}] pipeline (full): последовательные шаги 1–5`);
    s.pipeline = {};
    s.pipelineMaxStep = 0;
    for (let i = 1; i <= 5; i++) {
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
      this.log.log(`[${id}] pipeline step 1/5: конструктор + технолог (сброс предыдущего отчёта)`);
      s.pipeline = {};
      s.pipelineMaxStep = 0;

      const step1Start = performance.now();
      const [constructorJson, technologistJson] = await Promise.all([
        this.agents.runConstructor(analysis),
        this.agents.runTechnologist(analysis),
      ]);
      s.pipeline.constructor = constructorJson;
      s.pipeline.technologist = technologistJson;
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
      this.log.log(`[${id}] pipeline step 2/5: закупщик`);
      const t0 = performance.now();
      const purchasingJson = await this.agents.runPurchasing(analysis);
      s.pipeline.purchasing = purchasingJson;
      s.pipelineMaxStep = 2;
      this.log.log(
        `[${id}] pipeline step 2 готов за ${Math.round(performance.now() - t0)}ms`,
      );
      return;
    }

    if (step === 3) {
      this.log.log(`[${id}] pipeline step 3/5: расчёт сеток + AI-финансист`);
      const p = s.pipeline.purchasing as Record<string, unknown> | undefined;
      if (!p) {
        throw new BadRequestException('Нет данных закупщика (шаг 2)');
      }

      const tCalc0 = performance.now();
      const fabricCost = num(p.estimatedFabricCostRub, 1200);
      const hardwareCost = num(p.estimatedHardwareCostRub, 450);
      const productionCost = num(p.estimatedProductionCostRub, 2800);

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
      s.pipelineMaxStep = 3;
      return;
    }

    if (step === 4) {
      this.log.log(`[${id}] pipeline step 4/5: маркетолог + фото-студия`);
      const t0 = performance.now();
      const [marketerJson, photoStudioJson] = await Promise.all([
        this.agents.runMarketer(analysis),
        this.agents.runPhotoStudio(analysis),
      ]);
      s.pipeline.marketer = marketerJson;
      s.pipeline.photoStudio = photoStudioJson;
      s.pipelineMaxStep = 4;
      this.log.log(
        `[${id}] pipeline step 4 готов за ${Math.round(performance.now() - t0)}ms`,
      );
      return;
    }

    if (step === 5) {
      this.log.log(`[${id}] pipeline step 5/5: генерация изображения`);
      const photoStudio = s.pipeline.photoStudio;
      const t0 = performance.now();
      const prompt = buildProductImagePrompt(analysis, photoStudio);
      this.log.log(
        `[${id}] image prompt length=${prompt.length}, type=${String(analysis.productType)}`,
      );
      const generatedImageUrl = await this.agents.generateGalleryImage(prompt);
      s.pipeline.generatedImageUrl = generatedImageUrl;
      s.pipelineMaxStep = 5;
      this.log.log(
        `[${id}] pipeline step 5 готов за ${Math.round(performance.now() - t0)}ms, hasImage=${Boolean(generatedImageUrl)}`,
      );
    }
  }
}
