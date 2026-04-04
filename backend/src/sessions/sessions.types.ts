import type { SalesChannel, Scenario } from '../constants/economy-stubs';
import type { EconomyLine } from '../economy/economy-calculator';

export type SessionImage = {
  mimeType: string;
  dataUrl: string;
};

/** Результат цепочки; поля появляются по мере выполнения шагов 1–5. */
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
  };
  marketer?: unknown;
  photoStudio?: unknown;
  /** null = шаг 5 выполнен, картинки нет; undefined = шаг ещё не выполняли */
  generatedImageUrl?: string | null;
};

export type SessionState = {
  id: string;
  images: SessionImage[];
  analysis: Record<string, unknown> | null;
  analysisApproved: boolean | null;
  /** Частичный или полный результат; null до первого шага pipeline */
  pipeline: PipelineResult | null;
  /** Последний успешно выполненный шаг цепочки (1…5); 0 — цепочка не начата или сброшена */
  pipelineMaxStep: number;
  createdAt: string;
};
