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

/** Шаг цепочки 1…5 (шаг 1 сбрасывает предыдущий отчёт на бэкенде). */
export async function runPipelineStep(sessionId: string, step: number) {
  const { data } = await api.post(
    `/sessions/${sessionId}/pipeline/step/${step}`,
  );
  return data;
}

/** Вся цепочка одним запросом. */
export async function runPipeline(sessionId: string) {
  const { data } = await api.post(`/sessions/${sessionId}/pipeline`);
  return data;
}

export default api;
