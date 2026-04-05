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
  /** Этап 1 конструктора — текст по new-update.txt */
  constructor?: unknown;
  /** Этап 2 — точные лекала (опционально, отдельная кнопка) */
  constructorStage2?: string;
  technologist?: unknown;
  /** JSON-слой для калькулятора (из ###CALC_JSON###) */
  purchasing?: unknown;
  /** Текст закупщика для людей */
  purchasingReport?: string;
  finance?: {
    lines: Record<
      SalesChannel,
      Record<Scenario, EconomyLine>
    >;
    narrative: string;
  };
  marketer?: unknown;
  photoStudio?: unknown;
  /** null = шаг 7 выполнен, картинки нет */
  generatedImageUrl?: string | null;
  /** Схема лекал по конструктору (ручной вызов, image API) */
  patternLayoutImageUrl?: string | null;
  /** Текст подписей к лекалам (только выкройки, из чата) */
  lekalaLayoutSheetText?: string | null;
  /** @deprecated используйте lekalaLayoutSheetText */
  patternTechPackSheetText?: string | null;
  /** Технический рисунок изделия (вид спереди/сзади), без лекал */
  technicalFlatImageUrl?: string | null;
  /** Студийный lookbook (модель под изделие) — отдельная генерация, image API */
  kidStudioImageUrl?: string | null;
  /** Итоговый текстовый пакет */
  finalPackage?: unknown;
  /** Интерпретатор лекал — текст */
  patternRender?: unknown;
};

export type SessionState = {
  id: string;
  images: SessionImage[];
  analysis: Record<string, unknown> | null;
  /** Текстовый отчёт intake (промпт new-update §1) */
  analysisReport?: string | null;
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
