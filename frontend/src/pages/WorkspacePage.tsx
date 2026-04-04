import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../ThemeToggle';
import { ANCHOR_STORAGE_KEY } from '../workspaceSections';
import {
  analyze,
  analysisDecision,
  createSession,
  getSession,
  runPipeline,
  runPipelineStep,
  setAuthToken,
  uploadImages,
} from '../api';

type Analysis = Record<string, unknown>;

type SessionPayload = {
  id: string;
  images: { mimeType: string; dataUrl: string }[];
  analysis: Analysis | null;
  analysisApproved: boolean | null;
  pipeline: Record<string, unknown> | null;
  pipelineMaxStep?: number;
};

const STORAGE_KEY = 'mvp_session_id';

/** Что видит пользователь на каждом шаге цепочки после подтверждения */
const CHAIN_STEPS = [
  {
    step: 1,
    title: 'Конструктор + технолог',
    userText:
      'Пояснение лекал, кроя, мерок и швейной технологии: этапы, оборудование, риски.',
  },
  {
    step: 2,
    title: 'Закупщик',
    userText:
      'Оценка ткани, фурнитуры, расхода и отходов — числа пойдут в расчёт экономики.',
  },
  {
    step: 3,
    title: 'Финансист',
    userText:
      'Таблицы WB / Ozon / сайт × три сценария (пессимист / база / оптимист) плюс текстовый разбор. Для WB в базе заложена сумма отчислений от цены 55% (комиссия+маркетинг+возвраты+эквайринг, логистика отдельно в ₽).',
  },
  {
    step: 4,
    title: 'Маркетолог + фото-ТЗ',
    userText:
      'SEO, описание, буллеты и техническое задание на съёмку (ракурсы, инфографика).',
  },
  {
    step: 5,
    title: 'Визуал',
    userText:
      'Картинка по API (промпт жёстко привязан к распознанному типу изделия). Не участвует в цифрах.',
  },
] as const;

function JsonBlock({
  title,
  data,
  id,
}: {
  title: string;
  data: unknown;
  id?: string;
}) {
  if (data === undefined) return null;
  return (
    <div id={id} className="card panel workspace-anchor">
      <div className="panel-header">
        <span className="panel-badge">JSON</span>
        <h2 style={{ margin: 0 }}>{title}</h2>
      </div>
      <pre className="pre">{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
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
  /** step-by-step: номер шага 1–5 во время запроса; null — нет активного шага */
  const [pipelineLoadingStep, setPipelineLoadingStep] = useState<number | null>(
    null,
  );
  /** как запускать цепочку после подтверждения */
  const [chainMode, setChainMode] = useState<'progressive' | 'full'>(
    'progressive',
  );

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
    const data = (await getSession(id)) as SessionPayload;
    setSession(data);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) {
      setSessionId(existing);
      refresh(existing).catch(() => {
        if (!cancelled) {
          sessionStorage.removeItem(STORAGE_KEY);
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
        sessionStorage.setItem(STORAGE_KEY, id);
        setSessionId(id);
        await refresh(id);
      } catch {
        if (!cancelled) setErr('Не удалось создать сессию. Запустите бэкенд.');
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
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      setErr('Ошибка анализа. Проверьте доступность ИИ-сервиса и настройки бэкенда.');
    } finally {
      setBusy(null);
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
          'Ошибка цепочки. Проверьте подтверждение анализа и настройки платформы.',
        );
      } finally {
        setBusy(null);
      }
      return;
    }

    setBusy('pipeline');
    try {
      for (let i = 1; i <= 5; i++) {
        setPipelineLoadingStep(i);
        const meta = CHAIN_STEPS[i - 1];
        document.title = `MiniLik — шаг ${i}/5: ${meta.title}`;
        await runPipelineStep(sessionId, i);
        await refresh(sessionId);
      }
    } catch {
      setErr(
        'Ошибка на шаге цепочки. Попробуйте снова или используйте «Всё сразу».',
      );
    } finally {
      setPipelineLoadingStep(null);
      setBusy(null);
      document.title = 'MiniLik — кабинет';
    }
  }

  function logout() {
    localStorage.removeItem('mvp_token');
    sessionStorage.removeItem(STORAGE_KEY);
    setAuthToken(null);
    nav('/', { replace: true });
  }

  function goHome() {
    nav('/', { replace: false });
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
          : maxPipeline < 5 || busy === 'pipeline'
            ? 4
            : 5;

  const analysis = session?.analysis;

  return (
    <div className="app-shell">
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
              <strong>Вы подтверждаете</strong> — если всё верно, запускается
              цепочка специализированных ассистентов.
            </li>
            <li>
              <strong>Отчёт по шагам</strong> — вы видите результат каждого
              этапа по мере готовности (в режиме «Пошагово»).
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
            { n: 4, t: 'Цепочка ИИ', d: '5 внутренних шагов' },
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
            <span className="panel-badge">Шаг 1</span>
            <h2>Фотографии</h2>
          </div>
          <p className="panel-desc">
            Нажмите на квадрат, чтобы добавить снимки (до 3). Миниатюры можно
            снять крестиком до отправки. После отправки файлы сохраняются на
            сервере и используются при распознавании.
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
              {busy === 'upload' ? 'Отправка…' : 'Отправить фото на сервер'}
            </button>
          </div>
          {files.length > 0 && !sessionId && (
            <p className="muted" style={{ marginTop: 8 }}>
              Сессия ещё не готова — дождитесь ответа бэкенда или обновите
              страницу. Без сессии отправка недоступна.
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
            <SpinnerBlock label="ИИ разбирает фото и формирует JSON… Первый ответ может занять 10–30 секунд." />
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
              Проверьте тип и описание. Если всё ок — подтвердите, иначе отклоните
              и загрузите другие фото.
            </p>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="tag tag-a">тип изделия — из справочника</span>
            </div>
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
            {session?.analysisApproved == null && (
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
            <h2>ИИ-цепочка (5 этапов)</h2>
          </div>
          <p className="panel-desc">
            После подтверждения анализа система вызывает пять блоков: конструктор
            и технолог параллельно, затем закупщик, финансист, маркетолог с ТЗ на
            фото, и генерация картинки.
          </p>

          <p className="muted" style={{ marginBottom: 8 }}>
            Как показывать результат:
          </p>
          <div className="choice-row">
            <button
              type="button"
              className={`choice-btn ${chainMode === 'progressive' ? 'selected' : ''}`}
              onClick={() => setChainMode('progressive')}
              disabled={busy !== null || session?.analysisApproved !== true}
            >
              Пошагово (видно каждый этап)
            </button>
            <button
              type="button"
              className={`choice-btn ${chainMode === 'full' ? 'selected' : ''}`}
              onClick={() => setChainMode('full')}
              disabled={busy !== null || session?.analysisApproved !== true}
            >
              Всё сразу (один длинный запрос)
            </button>
          </div>

          <ul className="hero-list" style={{ marginTop: 12 }}>
            {CHAIN_STEPS.map((s) => (
              <li key={s.step}>
                <strong>
                  {s.step}. {s.title}
                </strong>{' '}
                — {s.userText}
              </li>
            ))}
          </ul>

          {chainMode === 'progressive' &&
            busy === 'pipeline' &&
            pipelineLoadingStep !== null && (
              <SpinnerBlock
                label={`Шаг ${pipelineLoadingStep} из 5: ${CHAIN_STEPS[pipelineLoadingStep - 1].title}. ${CHAIN_STEPS[pipelineLoadingStep - 1].userText}`}
              />
            )}

          {chainMode === 'full' && busy === 'pipeline' && (
            <SpinnerBlock label="Выполняется полная цепочка — до нескольких минут. Результат появится сразу целиком." />
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button
              type="button"
              onClick={onRunChain}
              disabled={session?.analysisApproved !== true || busy !== null}
            >
              {busy === 'pipeline'
                ? 'Идёт обработка…'
                : 'Запустить ИИ-отчёт'}
            </button>
            {maxPipeline > 0 && maxPipeline < 5 && !busy && (
              <span className="muted">
                Готово шагов цепочки: {maxPipeline}/5
              </span>
            )}
          </div>
        </section>

        {pipeline?.constructor != null && (
          <JsonBlock
            id="module-constructor"
            title="Конструктор"
            data={pipeline.constructor}
          />
        )}
        {pipeline?.technologist != null && (
          <JsonBlock
            id="module-technologist"
            title="Технолог"
            data={pipeline.technologist}
          />
        )}
        {pipeline?.purchasing != null && (
          <JsonBlock
            id="module-purchasing"
            title="Закупщик"
            data={pipeline.purchasing}
          />
        )}

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
                Цифры считает бэкенд по заглушкам; текст ниже — комментарий ИИ.
                WB: в базовом сценарии сумма процентовых отчислений от цены = 55%
                (см. подпись у строк WB база).
              </p>
              <div className="pre" style={{ maxHeight: 'none', marginBottom: 12 }}>
                {String(
                  (pipeline.finance as { narrative?: string }).narrative ?? '',
                )}
              </div>
              <FinanceGrid finance={pipeline.finance as Record<string, unknown>} />
            </section>
          )}

        {pipeline?.marketer != null && (
          <JsonBlock
            id="module-marketer"
            title="Маркетолог"
            data={pipeline.marketer}
          />
        )}
        {pipeline?.photoStudio != null && (
          <JsonBlock
            id="module-photo"
            title="Фото-студия (ТЗ)"
            data={pipeline.photoStudio}
          />
        )}

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
      </div>
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
