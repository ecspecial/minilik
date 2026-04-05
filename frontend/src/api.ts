import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

export function setAuthToken(token: string | null) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}

export async function login(username: string, password: string) {
  const { data } = await api.post<{ accessToken: string }>('/auth/login', {
    username,
    password,
  });
  return data;
}

export async function createSession() {
  const { data } = await api.post<{ id: string }>('/sessions');
  return data;
}

export async function getSession(id: string) {
  const { data } = await api.get<unknown>(`/sessions/${id}`);
  return data;
}

export async function uploadImages(sessionId: string, files: File[]) {
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  const { data } = await api.post(`/sessions/${sessionId}/images`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function analyze(sessionId: string) {
  const { data } = await api.post(`/sessions/${sessionId}/analyze`);
  return data;
}

export async function analysisDecision(sessionId: string, approved: boolean) {
  const { data } = await api.post(`/sessions/${sessionId}/analysis-decision`, {
    approved,
  });
  return data;
}

export type AnalysisPatchPayload = {
  productType?: string;
  season?: string;
  silhouette?: string;
  details?: string;
  materials?: string;
  confidenceNotes?: string;
  analysisReport?: string;
};

export async function patchAnalysis(
  sessionId: string,
  patch: AnalysisPatchPayload,
) {
  const { data } = await api.patch(`/sessions/${sessionId}/analysis`, patch);
  return data;
}

/** Шаг цепочки 1…8 (шаг 1 сбрасывает предыдущий отчёт на бэкенде). */
export async function runPipelineStep(sessionId: string, step: number) {
  const { data } = await api.post(
    `/sessions/${sessionId}/pipeline/step/${step}`,
  );
  return data;
}

/** Вся цепочка одним запросом (1–8). */
export async function runPipeline(sessionId: string) {
  const { data } = await api.post(`/sessions/${sessionId}/pipeline`);
  return data;
}

export type IntakeContextPayload = {
  brand?: string;
  collection?: string;
  user_comment?: string;
  target_channel_hint?: string;
  price_hint?: string;
  age_hint?: string;
  season_hint?: string;
};

export async function patchIntakeContext(
  sessionId: string,
  ctx: IntakeContextPayload,
) {
  const { data } = await api.patch(`/sessions/${sessionId}/intake-context`, ctx);
  return data;
}

export async function recalculateModule(
  sessionId: string,
  targetModule: string,
  updatedInputs?: Record<string, unknown>,
) {
  const { data } = await api.post(`/sessions/${sessionId}/pipeline/recalculate`, {
    targetModule,
    updatedInputs,
  });
  return data;
}

export async function mergeModule(
  sessionId: string,
  module: string,
  userEdits: Record<string, unknown>,
) {
  const { data } = await api.post(`/sessions/${sessionId}/merge-module`, {
    module,
    userEdits,
  });
  return data;
}

export async function runPatternRenderTool(sessionId: string) {
  const { data } = await api.post(
    `/sessions/${sessionId}/tools/pattern-render`,
  );
  return data;
}

export async function runPatternLayoutImageTool(sessionId: string) {
  const { data } = await api.post(
    `/sessions/${sessionId}/tools/pattern-layout-image`,
  );
  return data;
}

export async function runConstructorStage2(sessionId: string) {
  const { data } = await api.post(
    `/sessions/${sessionId}/constructor-stage-2`,
  );
  return data;
}

export async function runMarketPriceEstimateTool(sessionId: string) {
  const { data } = await api.post(
    `/sessions/${sessionId}/tools/market-price-estimate`,
  );
  return data;
}

export default api;
