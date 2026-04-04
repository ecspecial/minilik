import type {
  ArtifactVersions,
  IntakeContext,
} from '../common/artifact-meta';
import type { SalesChannel, Scenario } from '../constants/economy-stubs';
import type { EconomyLine } from '../economy/economy-calculator';

export type SessionImage = {
  mimeType: string;
  dataUrl: string;
};

/** Результат цепочки; поля по мере шагов 1–8 (8 — финальный пакет). */
export type PipelineResult = {
  constructor?: unknown;
  technologist?: unknown;
  purchasing?: unknown;
  finance?: {
    lines: Record<
      SalesChannel,
      Record<Scenario, EconomyLine>
    >;
    narrative: string;
    /** §5 структурированный слой поверх тех же цифр */
    ai_calculation_doc?: unknown;
  };
  marketer?: unknown;
  photoStudio?: unknown;
  /** null = шаг 7 выполнен, картинки нет */
  generatedImageUrl?: string | null;
  /** §8 Final Package Assembly */
  finalPackage?: unknown;
  /** §12 опциональный интерпретатор лекал (ручной вызов API) */
  patternRender?: unknown;
};

export type SessionState = {
  id: string;
  images: SessionImage[];
  analysis: Record<string, unknown> | null;
  analysisApproved: boolean | null;
  pipeline: PipelineResult | null;
  /** Последний успешно выполненный шаг (1…8) */
  pipelineMaxStep: number;
  createdAt: string;
  /** Опциональный контекст для intake (§1.2) */
  intakeContext?: IntakeContext;
  /** Версии промптов/схем/модели (п.16 ТЗ) */
  artifactVersions?: ArtifactVersions | null;
};

export type { ArtifactVersions, IntakeContext };
