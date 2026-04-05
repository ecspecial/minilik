import axios from 'axios';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AssistantTextPanel } from '../components/ModuleChatPanel';
import { PRODUCT_TYPES } from '../constants/productTypes';
import { ThemeToggle } from '../ThemeToggle';
import { ANCHOR_STORAGE_KEY } from '../workspaceSections';
import api, {
  analyze,
  analysisDecision,
  createSession,
  getSession,
  type IntakeContextPayload,
  listSessions,
  type SessionListItem,
  patchAnalysis,
  patchIntakeContext,
  runConstructorStage2,
  runKidStudioImageTool,
  runPatternLayoutImageTool,
  runTechnicalFlatImageTool,
  runPipeline,
  runPipelineStep,
  setAuthToken,
  uploadImages,
} from '../api';

type Analysis = Record<string, unknown>;

/** Полный URL для копирования (тот же хост, что у открытой страницы). */
function absoluteSessionImageUrl(sessionId: string, imageIndex: number): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/sessions/${sessionId}/images/${imageIndex}`;
}

/** Для выгрузки JSON: из относительного `/sessions/…` в `https://…/api/sessions/…`. */
function exportedImageUrlField(im: { url?: string }): string | undefined {
  if (!im.url) return undefined;
  if (/^https?:\/\//i.test(im.url)) return im.url;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const path = im.url.startsWith('/api')
    ? im.url
    : `/api${im.url.startsWith('/') ? im.url : `/${im.url}`}`;
  return `${origin}${path}`;
}

type SessionPayload = {
  id: string;
  images: { mimeType: string; url?: string; dataUrl?: string }[];
  analysis: Analysis | null;
  analysisReport?: string | null;
  analysisApproved: boolean | null;
  pipeline: Record<string, unknown> | null;
  pipelineMaxStep?: number;
  createdAt?: string;
  updatedAt?: string;
  intakeContext?: IntakeContextPayload;
  artifactVersions?: unknown;
};

/** Текущая сессия — localStorage, чтобы переживала обновление вкладки. Полное тело — на сервере (файлы JSON). */
const STORAGE_KEY = 'mvp_session_id';

/** Шаги цепочки после подтверждения анализа */
const CHAIN_STEPS = [
  {
    step: 1,
    title: 'Конструктор (черновик)',
    userText:
      'Техлист и описание кроя: конструкция, мерки, детали, черновое ТЗ на лекала. Это не рабочие лекала для производства — уточнение на следующем шаге.',
  },
  {
    step: 2,
    title: 'Технолог',
    userText:
      'Последовательность операций, оборудование, типы швов и обработок — строго опираясь на вывод конструктора.',
  },
  {
    step: 3,
    title: 'Закупщик и материалы',
    userText:
      'Ткани, фурнитура, ориентировочный расход, себестоимость материалов; оценки подписываются, откуда взяты.',
  },
  {
    step: 4,
    title: 'Финансист',
    userText:
      'Сетки юнит-экономики по каналам (например WB, Ozon, свой сайт) и поясняющий текст ИИ. Для WB в базовой модели сумма процентов от цены около 55%, логистика считается отдельно.',
  },
  {
    step: 5,
    title: 'Маркетолог',
    userText:
      'SEO-поля, буллеты, описание, позиционирование и задание на съёмку — только из утверждённых фактов по изделию.',
  },
  {
    step: 6,
    title: 'Фото и визуал',
    userText:
      'Готовые описания кадров для каталога, белого фона и lifestyle — без искажения посадки и силуэта модели.',
  },
  {
    step: 7,
    title: 'Картинка изделия',
    userText:
      'Вариант визуализации модели в нужном типе изделия — для презентации идей; не заменяет профессиональную съёмку.',
  },
  {
    step: 8,
    title: 'Финальный пакет',
    userText:
      'Один связный документ: кратко, что вы согласовали и какие выводы по всем направлениям.',
  },
] as const;

function pipelineStr(
  pipeline: Record<string, unknown> | null | undefined,
  key: string,
): string {
  if (!pipeline) return '';
  const v = pipeline[key];
  return typeof v === 'string' ? v : '';
}

function hasPrecisePatterns(
  pipeline: Record<string, unknown> | null | undefined,
): boolean {
  return pipelineStr(pipeline, 'constructorStage2').trim().length > 0;
}

/** Текст для подписей к лекалам (новое поле или совместимость со старым). */
function lekalaSheetFromPipeline(
  pipeline: Record<string, unknown> | null | undefined,
): string {
  if (!pipeline) return '';
  const a = pipeline.lekalaLayoutSheetText;
  const b = pipeline.patternTechPackSheetText;
  if (typeof a === 'string' && a.trim()) return a;
  if (typeof b === 'string' && b.trim()) return b;
  return '';
}

/** Если нет полного текста intake — собираем из полей карточки */
function buildFallbackAnalysisText(a: Analysis): string {
  const lines: string[] = [
    `Тип изделия (справочник): ${String(a.productType ?? '—')}`,
    `Сезон: ${String(a.season ?? '—')}`,
    `Силуэт: ${String(a.silhouette ?? '—')}`,
    `Детали: ${String(a.details ?? '—')}`,
    `Материалы: ${String(a.materials ?? '—')}`,
  ];
  if (a.confidenceNotes != null && String(a.confidenceNotes).trim()) {
    lines.push(`Комментарий: ${String(a.confidenceNotes)}`);
  }
  return lines.join('\n\n');
}

function SpinnerBlock({ label }: { label: string }) {
  return (
    <div className="spinner-row">
      <div className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export default function WorkspacePage() {
  const nav = useNavigate();
  const location = useLocation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** step-by-step: номер шага 1–8 во время запроса; null — нет активного шага */
  const [pipelineLoadingStep, setPipelineLoadingStep] = useState<number | null>(
    null,
  );
  /** как запускать цепочку после подтверждения */
  const [chainMode, setChainMode] = useState<'progressive' | 'full'>(
    'progressive',
  );
  const [intakeDraft, setIntakeDraft] = useState<IntakeContextPayload>({});
  const [toolBusy, setToolBusy] = useState<string | null>(null);
  const [analysisEditing, setAnalysisEditing] = useState(false);
  const [analysisDraft, setAnalysisDraft] = useState({
    reportText: '',
    productType: '',
    season: '',
    silhouette: '',
    details: '',
    materials: '',
    confidenceNotes: '',
  });
  const [sessionList, setSessionList] = useState<SessionListItem[]>([]);
  const [creatingSession, setCreatingSession] = useState(false);

  const token = localStorage.getItem('mvp_token');
  useEffect(() => {
    if (!token) {
      if (location.hash) {
        sessionStorage.setItem(ANCHOR_STORAGE_KEY, location.hash);
      }
      nav('/login', { replace: true });
      return;
    }
    setAuthToken(token);
  }, [token, nav, location.hash]);

  const refresh = useCallback(async (id: string) => {
    try {
      const data = (await getSession(id)) as SessionPayload;
      setSession(data);
      try {
        setSessionList(await listSessions());
      } catch {
        /* список сессий опционален */
      }
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 404) {
        localStorage.removeItem(STORAGE_KEY);
        try {
          const { id: newId } = await createSession();
          localStorage.setItem(STORAGE_KEY, newId);
          setSessionId(newId);
          const data = (await getSession(newId)) as SessionPayload;
          setSession(data);
          try {
            setSessionList(await listSessions());
          } catch {
            /* ignore */
          }
        } catch {
          setSessionId(null);
          setSession(null);
          setErr(
            'Сессия не найдена на сервере, новую создать не удалось.',
          );
        }
        return;
      }
      throw e;
    }
  }, []);

  useEffect(() => {
    if (!session?.id) return;
    setIntakeDraft({ ...(session.intakeContext ?? {}) });
  }, [session?.id]);

  useEffect(() => {
    if (session?.analysisApproved != null) setAnalysisEditing(false);
  }, [session?.analysisApproved]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      setSessionId(existing);
      refresh(existing).catch(() => {
        if (!cancelled) {
          localStorage.removeItem(STORAGE_KEY);
          setSessionId(null);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const { id } = await createSession();
        if (cancelled) return;
        localStorage.setItem(STORAGE_KEY, id);
        setSessionId(id);
        await refresh(id);
      } catch {
        if (!cancelled)
          setErr('Не удалось начать работу. Проверьте подключение и попробуйте обновить страницу.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, refresh]);

  useEffect(() => {
    if (!token || !location.hash) return;
    const id = location.hash.slice(1);
    if (!id) return;
    const scrollToTarget = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };
    scrollToTarget();
    const t1 = window.setTimeout(scrollToTarget, 450);
    const t2 = window.setTimeout(scrollToTarget, 1400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [token, location.hash, session?.pipeline, busy]);

  /** Нельзя держать createObjectURL в useMemo: в Strict Mode cleanup useEffect отзывает URL, а мемо от рендера не пересчитывается — превью «мёртвые». */
  const [filePreviewUrls, setFilePreviewUrls] = useState<string[]>([]);

  useLayoutEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setFilePreviewUrls(urls);
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [files]);

  /** Превью уже загруженных на сервер фото (blob URL или legacy data URL). */
  const [sessionImagePreviewUrls, setSessionImagePreviewUrls] = useState<
    string[]
  >([]);
  const sessionImageBlobsRef = useRef<string[]>([]);

  useEffect(() => {
    sessionImageBlobsRef.current.forEach((u) => URL.revokeObjectURL(u));
    sessionImageBlobsRef.current = [];
    const images = session?.images;
    if (!images?.length) {
      setSessionImagePreviewUrls([]);
      return;
    }
    let cancelled = false;

    void (async () => {
      const next: string[] = [];
      for (const im of images) {
        if (cancelled) return;
        if (im.dataUrl) {
          next.push(im.dataUrl);
          continue;
        }
        if (im.url) {
          try {
            const { data } = await api.get<Blob>(im.url, {
              responseType: 'blob',
            });
            if (cancelled) return;
            const blobUrl = URL.createObjectURL(data);
            sessionImageBlobsRef.current.push(blobUrl);
            next.push(blobUrl);
          } catch {
            if (!cancelled) next.push('');
          }
          continue;
        }
        if (!cancelled) next.push('');
      }
      if (!cancelled) setSessionImagePreviewUrls(next);
    })();

    return () => {
      cancelled = true;
      sessionImageBlobsRef.current.forEach((u) => URL.revokeObjectURL(u));
      sessionImageBlobsRef.current = [];
    };
  }, [session?.images]);

  function removeFileAt(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function onUpload() {
    if (!sessionId || !files.length) return;
    setErr(null);
    setBusy('upload');
    try {
      await uploadImages(sessionId, files.slice(0, 3));
      setFiles([]);
      await refresh(sessionId);
    } catch {
      setErr('Ошибка загрузки файлов.');
    } finally {
      setBusy(null);
    }
  }

  async function onAnalyze() {
    if (!sessionId) return;
    setErr(null);
    setBusy('analyze');
    try {
      await analyze(sessionId);
      await refresh(sessionId);
    } catch {
      setErr('Не удалось выполнить анализ. Попробуйте позже или обратитесь в поддержку.');
    } finally {
      setBusy(null);
    }
  }

  async function onSaveIntake() {
    if (!sessionId) return;
    setErr(null);
    setBusy('intake');
    try {
      await patchIntakeContext(sessionId, intakeDraft);
      await refresh(sessionId);
    } catch {
      setErr('Не удалось сохранить дополнительные уточнения.');
    } finally {
      setBusy(null);
    }
  }

  async function onPatternLayoutImageTool() {
    if (!sessionId) return;
    setErr(null);
    setToolBusy('patternLayout');
    try {
      await runPatternLayoutImageTool(sessionId);
      await refresh(sessionId);
    } catch {
      setErr(
        'Не удалось сгенерировать лист лекал (текст выкроек, затем картинка). Нужны точные лекала; запрос может занять больше минуты.',
      );
    } finally {
      setToolBusy(null);
    }
  }

  async function onTechnicalFlatImageTool() {
    if (!sessionId) return;
    setErr(null);
    setToolBusy('techFlat');
    try {
      await runTechnicalFlatImageTool(sessionId);
      await refresh(sessionId);
    } catch {
      setErr(
        'Не удалось построить технический рисунок. Выполните шаг 1 конструктора (текст черновика).',
      );
    } finally {
      setToolBusy(null);
    }
  }

  async function onKidStudioImageTool() {
    if (!sessionId) return;
    setErr(null);
    setToolBusy('kidStudio');
    try {
      await runKidStudioImageTool(sessionId);
      await refresh(sessionId);
    } catch {
      setErr(
        'Не удалось сгенерировать студийный образ. Заполните карточку изделия и повторите.',
      );
    } finally {
      setToolBusy(null);
    }
  }

  function startAnalysisEdit() {
    if (!analysis) return;
    const reportFromApi = session?.analysisReport?.trim();
    setAnalysisDraft({
      reportText: reportFromApi
        ? String(session.analysisReport)
        : buildFallbackAnalysisText(analysis),
      productType: String(analysis.productType ?? ''),
      season: String(analysis.season ?? ''),
      silhouette: String(analysis.silhouette ?? ''),
      details: String(analysis.details ?? ''),
      materials: String(analysis.materials ?? ''),
      confidenceNotes: String(analysis.confidenceNotes ?? ''),
    });
    setAnalysisEditing(true);
  }

  async function saveAnalysisEdit() {
    if (!sessionId) return;
    setErr(null);
    setBusy('analysisPatch');
    try {
      await patchAnalysis(sessionId, {
        analysisReport: analysisDraft.reportText.trim()
          ? analysisDraft.reportText
          : undefined,
        productType: analysisDraft.productType || undefined,
        season: analysisDraft.season || undefined,
        silhouette: analysisDraft.silhouette || undefined,
        details: analysisDraft.details || undefined,
        materials: analysisDraft.materials || undefined,
        confidenceNotes: analysisDraft.confidenceNotes || undefined,
      });
      setAnalysisEditing(false);
      await refresh(sessionId);
    } catch {
      setErr('Не удалось сохранить правки карточки.');
    } finally {
      setBusy(null);
    }
  }

  async function onConstructorStage2() {
    if (!sessionId) return;
    setErr(null);
    setToolBusy('constructor2');
    try {
      await runConstructorStage2(sessionId);
      await refresh(sessionId);
    } catch {
      setErr(
        'Сначала нужен готовый черновик конструктора (первый шаг). Дождитесь его и повторите.',
      );
    } finally {
      setToolBusy(null);
    }
  }

  async function onDecision(approved: boolean) {
    if (!sessionId) return;
    setErr(null);
    setBusy('decision');
    try {
      await analysisDecision(sessionId, approved);
      await refresh(sessionId);
    } catch {
      setErr('Не удалось сохранить решение.');
    } finally {
      setBusy(null);
    }
  }

  async function onRunNextPipelineStep() {
    if (!sessionId) return;
    const next = (session?.pipelineMaxStep ?? 0) + 1;
    if (next > 8) return;
    setErr(null);
    setBusy('pipeline');
    setPipelineLoadingStep(next);
    try {
      const meta = CHAIN_STEPS[next - 1];
      document.title = `MiniLik — шаг ${next}/8: ${meta.title}`;
      await runPipelineStep(sessionId, next);
      await refresh(sessionId);
    } catch {
      setErr(
        'На этом шаге возникла ошибка. Завершите предыдущие этапы и попробуйте снова или обратитесь в поддержку.',
      );
    } finally {
      setPipelineLoadingStep(null);
      setBusy(null);
      document.title = 'MiniLik — кабинет';
    }
  }

  async function onRunChain() {
    if (!sessionId) return;
    setErr(null);
    setPipelineLoadingStep(null);

    if (chainMode === 'full') {
      setBusy('pipeline');
      try {
        await runPipeline(sessionId);
        await refresh(sessionId);
      } catch {
        setErr(
          'Не удалось выполнить все этапы подряд. Убедитесь, что карточка изделия подтверждена, и попробуйте ещё раз.',
        );
      } finally {
        setBusy(null);
      }
      return;
    }

    await onRunNextPipelineStep();
  }

  function logout() {
    localStorage.removeItem('mvp_token');
    localStorage.removeItem(STORAGE_KEY);
    setAuthToken(null);
    nav('/', { replace: true });
  }

  function goHome() {
    nav('/', { replace: false });
  }

  async function switchWorkspaceSession(id: string) {
    if (!token || id === sessionId) return;
    setErr(null);
    localStorage.setItem(STORAGE_KEY, id);
    setSessionId(id);
    setFiles([]);
    await refresh(id);
  }

  async function startNewWorkspaceSession() {
    if (!token) return;
    setCreatingSession(true);
    setErr(null);
    try {
      const { id } = await createSession();
      localStorage.setItem(STORAGE_KEY, id);
      setSessionId(id);
      setFiles([]);
      await refresh(id);
    } catch {
      setErr('Не удалось создать новую сессию.');
    } finally {
      setCreatingSession(false);
    }
  }

  function exportCurrentSessionJson() {
    if (!session) return;
    const forExport = {
      ...session,
      images: session.images.map((im) =>
        im.url
          ? { mimeType: im.mimeType, url: exportedImageUrlField(im) ?? im.url }
          : { mimeType: im.mimeType, dataUrl: im.dataUrl },
      ),
    };
    const blob = new Blob([JSON.stringify(forExport, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `minilik-session-${session.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const maxPipeline = session?.pipelineMaxStep ?? 0;
  const pipeline = session?.pipeline;

  const uiStep = !session
    ? 0
    : !session.images?.length
      ? 1
      : !session.analysis
        ? 2
        : session.analysisApproved == null
          ? 3
          : maxPipeline < 8 || busy === 'pipeline'
            ? 4
            : 5;

  const analysis = session?.analysis;

  const productTypeOptions = useMemo(() => {
    const t = analysisDraft.productType.trim();
    if (t && !(PRODUCT_TYPES as readonly string[]).includes(t)) {
      return [t, ...PRODUCT_TYPES];
    }
    return [...PRODUCT_TYPES];
  }, [analysisDraft.productType]);

  const intakeDisplayText = useMemo(() => {
    if (!analysis) return '';
    const r = session?.analysisReport?.trim();
    if (r) return String(session.analysisReport);
    return buildFallbackAnalysisText(analysis);
  }, [analysis, session?.analysisReport]);

  const showStickyNext =
    !!token &&
    session?.analysisApproved === true &&
    chainMode === 'progressive' &&
    maxPipeline < 8;

  return (
    <div
      className={`app-shell${showStickyNext ? ' app-shell--with-sticky-cta' : ''}`}
    >
      <div className="layout">
        <header className="page-header">
          <div className="brand">
            <h1 className="brand-title">ИИ-конвейер для изделия</h1>
            <p className="brand-tagline">
              От фотографии до черновика юнит-экономики и маркетинговых материалов
              — с прозрачными этапами и понятной классификацией изделия.
            </p>
          </div>
          <div className="page-header-actions">
            <ThemeToggle />
            <button type="button" className="secondary" onClick={goHome}>
              Главная
            </button>
            <button type="button" className="secondary" onClick={logout}>
              Выйти
            </button>
          </div>
        </header>

        <section className="session-history-bar card panel" aria-label="История сессий">
          <div className="session-history-top">
            <details className="session-history-details">
              <summary className="session-history-summary">
                История сессий
                <span className="session-history-count">({sessionList.length})</span>
              </summary>
              {sessionList.length === 0 ? (
                <p className="session-history-empty">Пока нет сохранённых сессий на сервере.</p>
              ) : (
                <ul className="session-history-list">
                  {sessionList.map((row) => (
                    <li key={row.id} className="session-history-row">
                      <button
                        type="button"
                        className={
                          row.id === sessionId
                            ? 'session-history-pill session-history-pill--current'
                            : 'session-history-pill'
                        }
                        onClick={() => void switchWorkspaceSession(row.id)}
                        disabled={busy !== null || creatingSession}
                      >
                        <span className="session-history-pill-label">{row.label}</span>
                        <span className="session-history-pill-meta">
                          {new Date(row.updatedAt).toLocaleString('ru-RU', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {row.imageCount ? ` · ${row.imageCount} фото` : ''}
                          {row.pipelineMaxStep > 0
                            ? ` · шаг ${row.pipelineMaxStep}/8`
                            : ''}
                        </span>
                      </button>
                      {row.imageCount > 0 ? (
                        <div className="session-history-image-urls">
                          <span className="session-history-urls-label">
                            URL фото (скопировать целиком; открытие в новой вкладке —
                            только будучи залогиненным на этом сайте):
                          </span>
                          {Array.from({ length: row.imageCount }, (_, i) => (
                            <code
                              key={`${row.id}-img-${i}`}
                              className="session-history-url-code"
                              title="Выделить и скопировать"
                            >
                              {absoluteSessionImageUrl(row.id, i)}
                            </code>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <div className="session-history-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => void startNewWorkspaceSession()}
                disabled={busy !== null || creatingSession}
              >
                {creatingSession ? 'Создание…' : 'Новая сессия'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={exportCurrentSessionJson}
                disabled={!session}
              >
                Скачать JSON
              </button>
            </div>
          </div>
          <p className="session-history-hint">
            Все ответы и загруженные фото сохраняются на сервере в JSON; ссылки на сгенерированные
            картинки тоже лежат в сессии (если внешний URL перестанет открываться, используйте выгрузку
            заранее или загрузку своих файлов).
          </p>
        </section>

        <section className="hero">
          <h2>Как это работает (простыми словами)</h2>
          <ol className="hero-list">
            <li>
              <strong>Загрузка</strong> — до 3 фото товара (чем чётче кадр, тем
              лучше распознавание).
            </li>
            <li>
              <strong>ИИ смотрит фото</strong> — заполняет карточку изделия (тип,
              сезон, силуэт, детали, материалы).
            </li>
            <li>
              <strong>Вы подтверждаете</strong> — если всё верно, система
              последовательно готовит материалы по направлениям: конструкция,
              технология, закупки, финансы, маркетинг и далее.
            </li>
            <li>
              <strong>Отчёт по шагам</strong> — можно идти по одному шагу и
              проверять результат (режим «Пошагово») или запустить всё подряд.
            </li>
          </ol>

          <div className="mode-legend">
            <div className="mode-card a">
              <h3>Тип изделия — только справочник</h3>
              <p>
                Поле <strong>«тип изделия»</strong> всегда берётся из закрытого
                перечня на нашей стороне: система не выдумывает новый тип, а
                выбирает один из заранее заданных вариантов. Остальные поля
                карточки заполняются по результату анализа фотографий.
              </p>
            </div>
          </div>
        </section>

        <nav className="timeline" aria-label="Этапы до отчёта">
          {[
            { n: 1, t: 'Фото', d: 'Загрузка 1–3 снимков' },
            { n: 2, t: 'Анализ ИИ', d: 'Распознавание по фото' },
            { n: 3, t: 'Ваше «да»', d: 'Подтверждение карточки' },
            { n: 4, t: 'Этапы отчёта', d: 'Восемь разделов подряд' },
            { n: 5, t: 'Итог', d: 'Все блоки на экране' },
          ].map((it) => (
            <div
              key={it.n}
              className={`timeline-item ${uiStep === it.n ? 'active' : ''} ${uiStep > it.n ? 'done' : ''}`}
            >
              <div className="timeline-num">{it.n}</div>
              <div className="timeline-body">
                <strong>{it.t}</strong>
                {it.d}
              </div>
            </div>
          ))}
        </nav>

        {err && <p className="err">{err}</p>}

        <section className="card panel">
          <div className="panel-header">
            <span className="panel-badge">До анализа</span>
            <h2>Дополнительно до анализа (по желанию)</h2>
          </div>
          <p className="panel-desc">
            Бренд, коллекция, канал, ориентир по цене и комментарий учитываются при
            анализе фото и на этапе закупки. Все поля необязательны — можно
            оставить пустым.
          </p>
          <div
            className="grid-econ"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {(
              [
                ['brand', 'Бренд'],
                ['collection', 'Коллекция'],
                ['target_channel_hint', 'Канал (подсказка)'],
                ['price_hint', 'Цена (подсказка)'],
                ['age_hint', 'Возраст (подсказка)'],
                ['season_hint', 'Сезон (подсказка)'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {label}
                <input
                  type="text"
                  className="pre"
                  style={{ padding: 8, fontFamily: 'inherit' }}
                  value={String(intakeDraft[key] ?? '')}
                  onChange={(e) =>
                    setIntakeDraft((d) => ({ ...d, [key]: e.target.value }))
                  }
                  disabled={busy !== null || !sessionId}
                />
              </label>
            ))}
          </div>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            Комментарий
            <textarea
              className="pre"
              style={{ minHeight: 72, padding: 8, fontFamily: 'inherit' }}
              value={String(intakeDraft.user_comment ?? '')}
              onChange={(e) =>
                setIntakeDraft((d) => ({ ...d, user_comment: e.target.value }))
              }
              disabled={busy !== null || !sessionId}
            />
          </label>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="secondary"
              onClick={onSaveIntake}
              disabled={!sessionId || busy !== null}
            >
              {busy === 'intake' ? 'Сохранение…' : 'Сохранить уточнения'}
            </button>
          </div>
        </section>

        <section className="card panel">
          <div className="panel-header">
            <span className="panel-badge">Шаг 1</span>
            <h2>Фотографии</h2>
          </div>
          <p className="panel-desc">
            Нажмите на квадрат, чтобы добавить снимки (до 3). Миниатюры можно
            убрать крестиком до отправки. После отправки фото используются при
            распознавании изделия.
          </p>
          <div className="file-picker-row">
            {/*
              Прямой клик по нативному input внутри label — без input.click() из React.
              Иначе в Chromium/Edge теряется user activation: диалог есть, change пустой.
            */}
            <label
              className={`file-picker-tile${files.length >= 3 ? ' file-picker-tile--full' : ''}`}
            >
              <span className="file-picker-plus" aria-hidden>
                +
              </span>
              <span className="file-picker-label">
                {files.length >= 3 ? (
                  <>
                    Лимит
                    <br />
                    3 фото
                  </>
                ) : (
                  <>
                    Добавить
                    <br />
                    файлы
                  </>
                )}
              </span>
              <span className="file-picker-hint">
                {files.length >= 3 ? 'удалите лишнее' : 'до 3 фото'}
              </span>
              <input
                type="file"
                className="file-picker-overlay-input"
                accept="image/*"
                multiple
                disabled={files.length >= 3 || busy === 'upload'}
                aria-label={
                  files.length >= 3
                    ? 'Лимит три фото. Удалите файл на миниатюре, чтобы добавить другой.'
                    : 'Выбрать файлы изображений, не более трёх'
                }
                onChange={(e) => {
                  const picked = e.currentTarget.files;
                  const next: File[] = [];
                  if (picked) {
                    for (let i = 0; i < picked.length; i++) {
                      const f = picked.item(i);
                      if (f) next.push(f);
                    }
                  }
                  if (next.length > 0) {
                    setFiles((prev) => [...prev, ...next].slice(0, 3));
                  }
                  e.currentTarget.value = '';
                }}
              />
            </label>
            {files.length > 0 && (
              <ul className="file-preview-strip" aria-label="Выбранные фото">
                {files.map((file, index) => (
                  <li
                    key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                    className="file-preview-card"
                  >
                    {filePreviewUrls[index] ? (
                      <img
                        src={filePreviewUrls[index]}
                        alt={file.name}
                        className="file-preview-img"
                      />
                    ) : (
                      <div
                        className="file-preview-placeholder"
                        aria-hidden
                      />
                    )}
                    <span className="file-preview-name" title={file.name}>
                      {file.name.replace(/\.[^.]+$/, '') || file.name}
                    </span>
                    <button
                      type="button"
                      className="file-preview-remove"
                      onClick={() => removeFileAt(index)}
                      disabled={busy !== null}
                      aria-label={`Убрать из выбора: ${file.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Выбрано: <strong>{files.length}</strong> из 3
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={onUpload}
              disabled={!sessionId || !files.length || busy !== null}
            >
              {busy === 'upload' ? 'Отправка…' : 'Загрузить фото'}
            </button>
          </div>
          {session && session.images.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p className="muted" style={{ marginBottom: 8 }}>
                Загружено в сессию: <strong>{session.images.length}</strong>{' '}
                — картинки хранятся как файлы на сервере, в JSON только ссылки.
              </p>
              <ul
                className="file-preview-strip"
                aria-label="Фото в текущей сессии"
              >
                {session.images.map((_, index) => (
                  <li
                    key={`sess-img-${session.id}-${index}`}
                    className="file-preview-card"
                  >
                    {sessionImagePreviewUrls[index] ? (
                      <img
                        src={sessionImagePreviewUrls[index]}
                        alt={`Фото ${index + 1}`}
                        className="file-preview-img"
                      />
                    ) : (
                      <div
                        className="file-preview-placeholder"
                        aria-hidden
                      />
                    )}
                    <span className="file-preview-name" title="">
                      #{index + 1}
                    </span>
                    <code
                      className="session-inline-image-url"
                      title="Полный URL для копирования"
                    >
                      {absoluteSessionImageUrl(session.id, index)}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {files.length > 0 && !sessionId && (
            <p className="muted" style={{ marginTop: 8 }}>
              Подождите пару секунд, пока система подготовится, или обновите
              страницу. Пока подготовка не завершена, загрузка недоступна.
            </p>
          )}
        </section>

        <section id="module-analysis" className="card panel workspace-anchor">
          <div className="panel-header">
            <span className="panel-badge">Шаг 2</span>
            <h2>ИИ-анализ изделия</h2>
          </div>
          <p className="panel-desc">
            Наша система анализирует фото и заполняет карточку.{' '}
            <span className="tag tag-a">Тип изделия</span> всегда из закрытого
            справочника; остальные поля — по результатам распознавания.
          </p>
          {busy === 'analyze' && (
            <SpinnerBlock label="Идёт разбор фото и подготовка отчёта… Обычно 10–30 секунд." />
          )}
          <button
            type="button"
            onClick={onAnalyze}
            disabled={!session?.images?.length || busy !== null}
          >
            {busy === 'analyze' ? 'Идёт анализ…' : 'Запустить распознавание'}
          </button>
        </section>

        {analysis && (
          <section className="card panel">
            <div className="panel-header">
              <span className="panel-badge">Шаг 3</span>
              <h2>Что получилось</h2>
            </div>
            <p className="panel-desc">
              Один текст от ИИ — его можно править. Структурные поля карточки
              (тип из справочника и др.) — в блоке ниже. Подтвердите, когда всё
              верно.
            </p>
            <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
              {session?.analysisApproved == null && !analysisEditing && (
                <button
                  type="button"
                  className="secondary"
                  onClick={startAnalysisEdit}
                  disabled={busy !== null}
                >
                  Редактировать текст и карточку
                </button>
              )}
            </div>
            {analysisEditing && session?.analysisApproved == null ? (
              <div
                className="analysis-edit-grid"
                style={{
                  display: 'grid',
                  gap: 12,
                  marginTop: 8,
                }}
              >
                <label
                  className="muted"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    gridColumn: '1 / -1',
                  }}
                >
                  Основной текст отчёта
                  <textarea
                    className="pre chat-msg-bubble--scroll"
                    style={{
                      minHeight: 200,
                      padding: 10,
                      fontFamily: 'inherit',
                      lineHeight: 1.45,
                    }}
                    value={analysisDraft.reportText}
                    onChange={(e) =>
                      setAnalysisDraft((d) => ({
                        ...d,
                        reportText: e.target.value,
                      }))
                    }
                    disabled={busy !== null}
                  />
                </label>
                <details className="analysis-meta-fold" open>
                  <summary>Карточка изделия (справочник и поля)</summary>
                  <div
                    className="analysis-edit-grid"
                    style={{
                      display: 'grid',
                      gap: 12,
                      padding: '0 1rem 1rem',
                    }}
                  >
                    <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      Тип изделия
                      <select
                        className="pre"
                        style={{ padding: 8, fontFamily: 'inherit' }}
                        value={analysisDraft.productType}
                        onChange={(e) =>
                          setAnalysisDraft((d) => ({
                            ...d,
                            productType: e.target.value,
                          }))
                        }
                        disabled={busy !== null}
                      >
                        {productTypeOptions.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(
                      [
                        ['season', 'Сезон'],
                        ['silhouette', 'Силуэт'],
                      ] as const
                    ).map(([key, label]) => (
                      <label
                        key={key}
                        className="muted"
                        style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                      >
                        {label}
                        <input
                          type="text"
                          className="pre"
                          style={{ padding: 8, fontFamily: 'inherit' }}
                          value={analysisDraft[key]}
                          onChange={(e) =>
                            setAnalysisDraft((d) => ({
                              ...d,
                              [key]: e.target.value,
                            }))
                          }
                          disabled={busy !== null}
                        />
                      </label>
                    ))}
                    {(
                      [
                        ['details', 'Детали'],
                        ['materials', 'Материалы'],
                        ['confidenceNotes', 'Комментарий'],
                      ] as const
                    ).map(([key, label]) => (
                      <label
                        key={key}
                        className="muted"
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          gridColumn: '1 / -1',
                        }}
                      >
                        {label}
                        <textarea
                          className="pre"
                          style={{
                            minHeight: key === 'confidenceNotes' ? 100 : 72,
                            padding: 8,
                            fontFamily: 'inherit',
                          }}
                          value={analysisDraft[key]}
                          onChange={(e) =>
                            setAnalysisDraft((d) => ({
                              ...d,
                              [key]: e.target.value,
                            }))
                          }
                          disabled={busy !== null}
                        />
                      </label>
                    ))}
                  </div>
                </details>
                <div className="row" style={{ gridColumn: '1 / -1' }}>
                  <button
                    type="button"
                    onClick={saveAnalysisEdit}
                    disabled={busy !== null}
                  >
                    {busy === 'analysisPatch'
                      ? 'Сохранение…'
                      : 'Сохранить правки'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setAnalysisEditing(false)}
                    disabled={busy !== null}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <>
                <AssistantTextPanel
                  title="Отчёт ИИ"
                  badgeLabel="Текст"
                  scrollable
                >
                  {intakeDisplayText}
                </AssistantTextPanel>
                <details className="analysis-meta-fold">
                  <summary>Карточка изделия (тип из справочника и поля)</summary>
                  <ul className="analysis-list">
                    <li>
                      <strong>Тип изделия:</strong>{' '}
                      {String(analysis.productType ?? '—')}
                    </li>
                    <li>
                      <strong>Сезон:</strong> {String(analysis.season ?? '—')}
                    </li>
                    <li>
                      <strong>Силуэт:</strong>{' '}
                      {String(analysis.silhouette ?? '—')}
                    </li>
                    <li>
                      <strong>Детали:</strong> {String(analysis.details ?? '—')}
                    </li>
                    <li>
                      <strong>Материалы:</strong>{' '}
                      {String(analysis.materials ?? '—')}
                    </li>
                    {analysis.confidenceNotes != null &&
                      String(analysis.confidenceNotes) && (
                        <li className="muted">
                          <strong>Комментарий:</strong>{' '}
                          {String(analysis.confidenceNotes)}
                        </li>
                      )}
                  </ul>
                </details>
              </>
            )}
            {session?.analysisApproved == null && !analysisEditing && (
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => onDecision(true)}
                  disabled={busy !== null}
                >
                  Всё верно — запустить ИИ-цепочку
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => onDecision(false)}
                  disabled={busy !== null}
                >
                  Нет, сбросить
                </button>
              </div>
            )}
            {session?.analysisApproved === true && (
              <p className="muted" style={{ marginTop: 12 }}>
                Подтверждено. Ниже выберите способ запуска отчёта.
              </p>
            )}
            {session?.analysisApproved === false && (
              <p className="err" style={{ marginTop: 12 }}>
                Отклонено. Загрузите другие фото и снова нажмите распознавание.
              </p>
            )}
          </section>
        )}

        <section className="card panel">
          <div className="panel-header">
            <span className="panel-badge">Шаг 4</span>
            <h2>ИИ-цепочка (8 этапов)</h2>
          </div>
          <p className="panel-desc">
            На каждом шаге вы получаете готовый текст: что сделано и на что
            опираться дальше.{' '}
            <strong>Пошагово</strong> — выполняете этапы по одному: после чернового
            конструктора сначала получите <strong>точные лекала</strong>, при
            необходимости — <strong>схему-картинку</strong> (чтобы цифры на схеме
            были опираемыми на модель, сначала нужны точные лекала), затем
            нажимайте «Следующий шаг» к
            технологу. <strong>Всё сразу</strong> — система сама пройдёт все восемь
            этапов подряд: после черновика посчитает точные лекала и по ним
            построит схему, если это технически возможно.
          </p>

          <p className="muted" style={{ marginBottom: 8 }}>
            Как удобнее работать:
          </p>
          <div className="choice-row">
            <button
              type="button"
              className={`choice-btn ${chainMode === 'progressive' ? 'selected' : ''}`}
              onClick={() => setChainMode('progressive')}
              disabled={busy !== null || session?.analysisApproved !== true}
            >
              Пошагово
            </button>
            <button
              type="button"
              className={`choice-btn ${chainMode === 'full' ? 'selected' : ''}`}
              onClick={() => setChainMode('full')}
              disabled={busy !== null || session?.analysisApproved !== true}
            >
              Всё сразу
            </button>
          </div>

          <details
            className="analysis-meta-fold"
            style={{ marginTop: 12 }}
            open={chainMode === 'full'}
          >
            <summary>Все 8 этапов (кратко)</summary>
            <ul className="hero-list" style={{ margin: 0 }}>
              {CHAIN_STEPS.map((s) => (
                <li key={s.step}>
                  <strong>
                    {s.step}. {s.title}
                  </strong>{' '}
                  — {s.userText}
                </li>
              ))}
            </ul>
          </details>

          {chainMode === 'progressive' &&
            busy === 'pipeline' &&
            pipelineLoadingStep !== null && (
              <SpinnerBlock
                label={`Шаг ${pipelineLoadingStep} из 8: ${CHAIN_STEPS[pipelineLoadingStep - 1].title}. ${CHAIN_STEPS[pipelineLoadingStep - 1].userText}`}
              />
            )}

          {chainMode === 'full' && busy === 'pipeline' && (
            <SpinnerBlock label="Полная цепочка: шаги 1–8, после конструктора — автоматически точные лекала и схема. До нескольких минут; блоки появятся ниже по мере готовности." />
          )}

          <div className="row chain-panel-progress" style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={onRunChain}
              disabled={
                session?.analysisApproved !== true ||
                busy !== null ||
                (chainMode === 'progressive' && maxPipeline >= 8)
              }
            >
              {busy === 'pipeline'
                ? 'Идёт обработка…'
                : chainMode === 'full'
                  ? 'Запустить всю цепочку (1–8)'
                  : maxPipeline >= 8
                    ? 'Все шаги выполнены'
                    : `Следующий шаг ${maxPipeline + 1}/8 — ${CHAIN_STEPS[maxPipeline].title}`}
            </button>
            {maxPipeline > 0 && maxPipeline < 8 && busy !== 'pipeline' && (
              <span>Готово: {maxPipeline}/8</span>
            )}
            {maxPipeline >= 8 && busy !== 'pipeline' && <span>Цепочка 8/8</span>}
          </div>
        </section>

        {pipelineStr(pipeline, 'constructor').trim() ? (
          <>
            <AssistantTextPanel
              id="module-constructor"
              title="Конструктор: черновой техлист"
              badgeLabel="Раздел"
            >
              {pipelineStr(pipeline, 'constructor')}
            </AssistantTextPanel>
            <section className="card panel">
              <div className="panel-header">
                <span className="panel-badge">Конструктор</span>
                <h2 style={{ margin: 0 }}>Лекала и технический рисунок</h2>
              </div>
              <p className="panel-desc">
                Это <strong>разные вещи</strong>.{' '}
                <strong>Технический рисунок</strong> — изделие спереди и сзади
                линиями (как в паспорте модели), без деталей выкройки.{' '}
                <strong>Лекала</strong> — отдельные плоские детали кроя для
                раскроя (примеры раскладки деталей — отдельно от вида изделия).
                Сначала
                сформируйте текст <strong>точных лекал</strong>, затем при
                необходимости сгенерируйте картинку выкроек.
              </p>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={onConstructorStage2}
                  disabled={
                    !sessionId ||
                    toolBusy !== null ||
                    busy === 'pipeline' ||
                    maxPipeline < 1
                  }
                >
                  {toolBusy === 'constructor2'
                    ? 'Запрос…'
                    : 'Сформировать точные лекала'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={onTechnicalFlatImageTool}
                  disabled={
                    !sessionId ||
                    toolBusy !== null ||
                    busy === 'pipeline' ||
                    !pipelineStr(pipeline, 'constructor').trim()
                  }
                >
                  {toolBusy === 'techFlat'
                    ? 'Генерация…'
                    : 'Технический рисунок изделия'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={onPatternLayoutImageTool}
                  disabled={
                    !sessionId ||
                    toolBusy !== null ||
                    busy === 'pipeline' ||
                    !hasPrecisePatterns(pipeline)
                  }
                >
                  {toolBusy === 'patternLayout'
                    ? 'Генерация…'
                    : 'Лекала на листе (картинка)'}
                </button>
              </div>
              {!pipelineStr(pipeline, 'constructor').trim() ? (
                <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                  Технический рисунок доступен после шага 1 конструктора.
                </p>
              ) : null}
              {!hasPrecisePatterns(pipeline) ? (
                <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                  Картинка лекал — после формирования точных лекал (этап 2).
                </p>
              ) : null}
            </section>
            {pipelineStr(pipeline, 'constructorStage2').trim() ? (
              <AssistantTextPanel
                id="module-constructor-2"
                title="Точные лекала"
                badgeLabel="Раздел"
              >
                {pipelineStr(pipeline, 'constructorStage2')}
              </AssistantTextPanel>
            ) : null}
            <section
              id="module-technical-flat"
              className="card panel workspace-anchor"
            >
              <div className="panel-header">
                <span className="panel-badge">Визуал</span>
                <h2 style={{ margin: 0 }}>Технический рисунок изделия</h2>
              </div>
              <p className="panel-desc">
                Вид спереди и сзади готового изделия линиями — без лекал и без
                разложенных выкроек. Для производственных файлов раскроя
                используйте блок ниже.
              </p>
              {typeof (pipeline as { technicalFlatImageUrl?: string | null })
                .technicalFlatImageUrl === 'string' &&
                String(
                  (pipeline as { technicalFlatImageUrl: string })
                    .technicalFlatImageUrl,
                ).length > 0 && (
                  <img
                    className="gen"
                    style={{ marginTop: 16 }}
                    src={
                      (pipeline as { technicalFlatImageUrl: string })
                        .technicalFlatImageUrl
                    }
                    alt="Технический рисунок изделия"
                  />
                )}
            </section>
            <section
              id="module-pattern-layout"
              className="card panel workspace-anchor"
            >
              <div className="panel-header">
                <span className="panel-badge">Визуал</span>
                <h2 style={{ margin: 0 }}>Лекала (выкройки на листе)</h2>
              </div>
              <p className="panel-desc">
                Только <strong>плоские детали кроя</strong>. На самой картинке —
                в основном <strong>номера деталей 1, 2, 3…</strong> (генерация
                плохо рисует кириллицу на чертежах). Полные русские названия и
                размеры — в тексте ниже и в «Точные лекала».
              </p>
              {lekalaSheetFromPipeline(pipeline).trim().length > 0 && (
                  <details className="analysis-meta-fold" style={{ marginTop: 12 }}>
                    <summary>Расшифровка номеров и размеры (основной текст)</summary>
                    <pre
                      className="pre chat-raw-pre"
                      style={{ maxHeight: 'min(40vh, 20rem)' }}
                    >
                      {lekalaSheetFromPipeline(pipeline)}
                    </pre>
                  </details>
                )}
              {typeof (pipeline as { patternLayoutImageUrl?: string })
                .patternLayoutImageUrl === 'string' &&
                String(
                  (pipeline as { patternLayoutImageUrl?: string })
                    .patternLayoutImageUrl,
                ).length > 0 && (
                  <img
                    className="gen"
                    style={{ marginTop: 16 }}
                    src={
                      (pipeline as { patternLayoutImageUrl: string })
                        .patternLayoutImageUrl
                    }
                    alt="Лекала — детали выкройки"
                  />
                )}
            </section>
          </>
        ) : null}
        {pipelineStr(pipeline, 'technologist').trim() ? (
          <AssistantTextPanel id="module-technologist" title="Технолог" badgeLabel="Раздел">
            {pipelineStr(pipeline, 'technologist')}
          </AssistantTextPanel>
        ) : null}
        {pipelineStr(pipeline, 'purchasingReport').trim() ? (
          <AssistantTextPanel
            id="module-purchasing"
            title="Закупщик"
            badgeLabel="Раздел"
          >
            {pipelineStr(pipeline, 'purchasingReport')}
          </AssistantTextPanel>
        ) : null}

        {pipeline != null &&
          typeof pipeline.finance === 'object' &&
          pipeline.finance !== null && (
            <section
              id="module-finance"
              className="card panel workspace-anchor"
            >
              <div className="panel-header">
                <span className="panel-badge">Финансы</span>
                <h2>Юнит-экономика (черновик)</h2>
              </div>
              <p className="panel-desc">
                Ниже — ориентировочные расчёты по каналам продаж и пояснение в
                свободной форме. Цифры для рабочих решений нужно сверить со своими
                договорами и тарифами. Для WB в базовом сценарии сумма типовых
                отчислений от цены около 55%; логистика уточняется отдельно.
              </p>
              <AssistantTextPanel
                variant="embedded"
                title="Комментарий ИИ"
              >
                {String(
                  (pipeline.finance as { narrative?: string }).narrative ?? '',
                )}
              </AssistantTextPanel>
              <FinanceGrid finance={pipeline.finance as Record<string, unknown>} />
            </section>
          )}

        {typeof pipeline?.finalPackage === 'string' &&
        pipeline.finalPackage.trim() ? (
          <AssistantTextPanel
            id="module-final-package"
            title="Финальный пакет"
            badgeLabel="Итог"
          >
            {pipeline.finalPackage}
          </AssistantTextPanel>
        ) : null}
        {pipelineStr(pipeline, 'marketer').trim() ? (
          <AssistantTextPanel
            id="module-marketer"
            title="Маркетолог"
            badgeLabel="Раздел"
          >
            {pipelineStr(pipeline, 'marketer')}
          </AssistantTextPanel>
        ) : null}
        {pipelineStr(pipeline, 'photoStudio').trim() ? (
          <AssistantTextPanel
            id="module-photo"
            title="Фото / визуал (ТЗ)"
            badgeLabel="Раздел"
          >
            {pipelineStr(pipeline, 'photoStudio')}
          </AssistantTextPanel>
        ) : null}

        {typeof pipeline?.generatedImageUrl === 'string' &&
          pipeline.generatedImageUrl.length > 0 && (
            <section
              id="module-visual"
              className="card panel workspace-anchor"
            >
              <div className="panel-header">
                <span className="panel-badge">Визуал</span>
                <h2>Сгенерированное изображение</h2>
              </div>
              <p className="panel-desc">
                Иллюстрация для презентации; в расчётах не используется.
              </p>
              <img
                className="gen"
                src={pipeline.generatedImageUrl}
                alt="Сгенерированный визуал изделия"
              />
            </section>
          )}

        {analysis ? (
          <section
            id="module-studio-lookbook"
            className="card panel workspace-anchor"
          >
            <div className="panel-header">
              <span className="panel-badge">Визуал</span>
              <h2 style={{ margin: 0 }}>Студия: образ на модели</h2>
            </div>
            <p className="panel-desc">
              Отдельная генерация по карточке и техлисту: светлая студия, модель
              подходит типу изделия (детское или взрослое — по вашим данным),
              несколько ракурсов на одном листе. Для каталога и презентаций; не
              заменяет живую примерку.
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                className="secondary"
                onClick={onKidStudioImageTool}
                disabled={!sessionId || toolBusy !== null || busy === 'pipeline'}
              >
                {toolBusy === 'kidStudio'
                  ? 'Генерация…'
                  : 'Собрать студийный образ'}
              </button>
            </div>
            {typeof pipeline?.kidStudioImageUrl === 'string' &&
              pipeline.kidStudioImageUrl.length > 0 && (
                <img
                  className="gen"
                  style={{ marginTop: 16 }}
                  src={pipeline.kidStudioImageUrl}
                  alt="Студийный образ изделия на модели"
                />
              )}
          </section>
        ) : null}
      </div>

      {showStickyNext ? (
        <div className="workspace-sticky-cta" role="region" aria-label="Следующий шаг цепочки">
          <div className="workspace-sticky-cta-inner">
            <span className="sticky-meta">
              Шаг {maxPipeline + 1}/8 — {CHAIN_STEPS[maxPipeline].title}
            </span>
            <button
              type="button"
              onClick={onRunChain}
              disabled={busy !== null}
            >
              {busy === 'pipeline'
                ? 'Идёт шаг…'
                : `Далее: ${CHAIN_STEPS[maxPipeline].title}`}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FinanceGrid({ finance }: { finance: Record<string, unknown> }) {
  const lines = finance.lines as
    | Record<string, Record<string, Record<string, unknown>>>
    | undefined;
  if (!lines) return null;

  const channels: Record<string, string> = {
    wb: 'Wildberries',
    ozon: 'Ozon',
    site: 'Свой сайт',
  };
  const scenarios: Record<string, string> = {
    pessimistic: 'Пессимистичный',
    base: 'Базовый',
    optimistic: 'Оптимистичный',
  };

  return (
    <div className="grid-econ" style={{ marginTop: 4 }}>
      {Object.entries(lines).map(([ch, bySc]) => (
        <div key={ch} className="econ-card">
          <h3>{channels[ch] ?? ch}</h3>
          {Object.entries(bySc).map(([sc, row]) => (
            <div key={sc} style={{ marginBottom: 12 }}>
              <strong style={{ color: 'var(--text)' }}>
                {scenarios[sc] ?? sc}
              </strong>
              <ul>
                <li>Себестоимость: {String(row.fullCost)} ₽</li>
                <li>Цена (реком.): {String(row.recommendedPrice)} ₽</li>
                <li>
                  Отчисления от цены (сумма %):{' '}
                  {row.variablePercentTotal != null
                    ? `${String(row.variablePercentTotal)} %`
                    : '—'}
                </li>
                <li>Валовая прибыль: {String(row.grossProfit)} ₽</li>
                <li>Маржа: {String(row.marginPct)} %</li>
                <li>Мин. цена (оц.): {String(row.minBreakEvenPrice)} ₽</li>
              </ul>
              <span className="tag tag-cfg">{String(row.disclaimer)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
