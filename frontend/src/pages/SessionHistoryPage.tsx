import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AssistantTextPanel,
  ModuleChatPanel,
} from '../components/ModuleChatPanel';
import api, {
  getSession,
  listSessions,
  setAuthToken,
  type SessionListItem,
} from '../api';
import { exportedImageUrlField, sessionAssetRequestPath } from '../sessionPaths';
import { ThemeToggle } from '../ThemeToggle';
import type { IntakeContextPayload } from '../api';

type Analysis = Record<string, unknown>;

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

function pipelineStr(
  pipeline: Record<string, unknown> | null | undefined,
  key: string,
): string {
  if (!pipeline) return '';
  const v = pipeline[key];
  return typeof v === 'string' ? v : '';
}

function HistoryBlock({
  step,
  title,
  subtitle,
  children,
  id,
}: {
  step?: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section className="history-block card panel" id={id}>
      <div className="history-block-head">
        {step != null && (
          <span className="history-step">Запрос цепочки · шаг {step}/8</span>
        )}
        <h2 className="history-block-title">{title}</h2>
        {subtitle ? <p className="muted history-block-sub">{subtitle}</p> : null}
      </div>
      <div className="history-block-body">{children}</div>
    </section>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="muted history-empty-hint">{text}</p>;
}

function exportOneSessionJson(session: SessionPayload) {
  const forExport = {
    ...session,
    images: session.images.map((im) =>
      im.url
        ? { mimeType: im.mimeType, url: exportedImageUrlField(im) ?? im.url }
        : im,
    ),
  };
  const blob = new Blob([JSON.stringify(forExport, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `minilik-session-${session.id}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function useIntakePreviewUrls(session: SessionPayload): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  const blobsRef = useRef<string[]>([]);

  useEffect(() => {
    blobsRef.current.forEach((u) => URL.revokeObjectURL(u));
    blobsRef.current = [];
    const images = session.images;
    if (!images?.length) {
      setUrls([]);
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
        const path = sessionAssetRequestPath(im.url);
        if (path) {
          try {
            const { data } = await api.get<Blob>(path, {
              responseType: 'blob',
            });
            if (cancelled) return;
            const blobUrl = URL.createObjectURL(data);
            blobsRef.current.push(blobUrl);
            next.push(blobUrl);
          } catch {
            if (!cancelled) next.push('');
          }
          continue;
        }
        if (!cancelled) next.push('');
      }
      if (!cancelled) setUrls(next);
    })();
    return () => {
      cancelled = true;
      blobsRef.current.forEach((u) => URL.revokeObjectURL(u));
      blobsRef.current = [];
    };
  }, [session.id, session.images]);

  return urls;
}

function HistorySessionSection({
  session,
  meta,
}: {
  session: SessionPayload;
  meta: SessionListItem;
}) {
  const sid = session.id;
  const pid = `history-${sid}`;
  const intakePreviewUrls = useIntakePreviewUrls(session);
  const pipeline = session.pipeline;

  const pipelineImageSrc = useCallback((url: string | null | undefined) => {
    if (!url?.trim()) return null;
    if (url.trim().startsWith('data:')) return url.trim();
    const p = sessionAssetRequestPath(url);
    if (!p) return null;
    return `${typeof window !== 'undefined' ? window.location.origin : ''}${p}`;
  }, []);

  const intakeContextEntries = useMemo(() => {
    const ctx = session.intakeContext;
    if (!ctx || typeof ctx !== 'object') return [];
    return Object.entries(ctx).filter(
      ([, v]) => v != null && String(v).trim() !== '',
    );
  }, [session.intakeContext]);

  return (
    <article
      className="history-session-article"
      id={`history-session-${sid}`}
      aria-label={`Сессия: ${meta.label}`}
    >
      <div className="history-toolbar card panel history-session-toolbar">
        <div>
          <h2 className="history-session-heading">{meta.label}</h2>
          <strong className="history-toolbar-id">{sid}</strong>
          <p className="muted history-toolbar-meta">
            Создана:{' '}
            {session.createdAt
              ? new Date(session.createdAt).toLocaleString('ru-RU')
              : '—'}
            {' · '}
            Обновлена:{' '}
            {session.updatedAt
              ? new Date(session.updatedAt).toLocaleString('ru-RU')
              : '—'}
            {' · '}
            Цепочка: шаг {session.pipelineMaxStep ?? 0}/8
            {' · '}
            Анализ:{' '}
            {session.analysisApproved === true
              ? 'подтверждён'
              : session.analysisApproved === false
                ? 'отклонён'
                : 'не решён'}
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => exportOneSessionJson(session)}
        >
          Скачать JSON
        </button>
      </div>

      <HistoryBlock title="Служебное" subtitle="Идентификатор и версии артефактов">
        <pre className="history-pre">
          {JSON.stringify(
            {
              id: session.id,
              artifactVersions: session.artifactVersions ?? null,
            },
            null,
            2,
          )}
        </pre>
      </HistoryBlock>

      {intakeContextEntries.length > 0 ? (
        <HistoryBlock
          title="Контекст до анализа"
          subtitle="Доп. поля (PATCH intake-context)"
        >
          <ModuleChatPanel
            title="Контекст"
            data={Object.fromEntries(intakeContextEntries)}
            badge="json"
          />
        </HistoryBlock>
      ) : null}

      <HistoryBlock title="Интейк — фотографии" subtitle="POST …/images">
        {session.images?.length ? (
          <div className="history-img-grid">
            {session.images.map((im, i) => (
              <figure key={i} className="history-img-wrap">
                {intakePreviewUrls[i] ? (
                  <img
                    src={intakePreviewUrls[i]}
                    alt={`Фото ${i + 1}`}
                  />
                ) : (
                  <span className="muted">Нет превью</span>
                )}
                <figcaption className="muted">{im.mimeType}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <EmptyHint text="Фото не загружались." />
        )}
      </HistoryBlock>

      <HistoryBlock title="Анализ по фото" subtitle="POST …/analyze">
        {session.analysis ? (
          <ModuleChatPanel
            title="Карточка анализа"
            data={session.analysis}
            badge="json"
          />
        ) : (
          <EmptyHint text="Анализ ещё не выполнялся." />
        )}
        {session.analysisReport?.trim() ? (
          <div style={{ marginTop: '1rem' }}>
            <h3 className="history-subheading">Текстовый отчёт</h3>
            <AssistantTextPanel
              id={`${pid}-analysis-report`}
              title="Отчёт"
              badgeLabel="Отчёт"
              variant="embedded"
              scrollable
            >
              {session.analysisReport}
            </AssistantTextPanel>
          </div>
        ) : null}
      </HistoryBlock>

      <HistoryBlock
        step={1}
        title="Конструктор (черновик)"
        subtitle="Шаг 1 — POST …/pipeline/step/1"
      >
        {pipelineStr(pipeline, 'constructor').trim() ? (
          <AssistantTextPanel
            id={`${pid}-constructor`}
            title="Конструктор"
            badgeLabel="Шаг 1"
            variant="embedded"
            scrollable
          >
            {pipelineStr(pipeline, 'constructor')}
          </AssistantTextPanel>
        ) : (
          <EmptyHint text="Шаг 1 ещё не выполнялся." />
        )}
      </HistoryBlock>

      <HistoryBlock
        title="Точные лекала и подписи к схеме"
        subtitle="Этап 2, техкарта, опционально схема"
      >
        {pipelineStr(pipeline, 'constructorStage2').trim() ? (
          <AssistantTextPanel
            id={`${pid}-stage2`}
            title="Этап 2"
            badgeLabel="Этап 2"
            variant="embedded"
            scrollable
          >
            {pipelineStr(pipeline, 'constructorStage2')}
          </AssistantTextPanel>
        ) : (
          <EmptyHint text="Этап 2 не запускался." />
        )}
        {lekalaSheet(pipeline) ? (
          <div style={{ marginTop: '1rem' }}>
            <h3 className="history-subheading">Текст для подписей / раскладки</h3>
            <AssistantTextPanel
              title="Подписи"
              badgeLabel="Лекала"
              variant="embedded"
              scrollable
            >
              {lekalaSheet(pipeline)}
            </AssistantTextPanel>
          </div>
        ) : null}
        {renderPipelineImage(
          'Схема раскладки лекал (инструмент)',
          pipeline?.patternLayoutImageUrl as string | null | undefined,
          pipelineImageSrc,
        )}
      </HistoryBlock>

      <HistoryBlock step={2} title="Технолог" subtitle="Шаг 2 — POST …/pipeline/step/2">
        {renderTechnologist(pipeline)}
      </HistoryBlock>

      <HistoryBlock
        step={3}
        title="Закупщик и материалы"
        subtitle="Шаг 3 — POST …/pipeline/step/3"
      >
        {pipelineStr(pipeline, 'purchasingReport').trim() ? (
          <AssistantTextPanel
            title="Закупщик"
            badgeLabel="Отчёт закупщика"
            variant="embedded"
            scrollable
          >
            {pipelineStr(pipeline, 'purchasingReport')}
          </AssistantTextPanel>
        ) : null}
        {pipeline?.purchasing != null ? (
          <div style={{ marginTop: '1rem' }}>
            <ModuleChatPanel
              title="JSON закупщика"
              data={pipeline.purchasing}
              badge="json"
            />
          </div>
        ) : (
          <EmptyHint text="Шаг 3 ещё не выполнялся." />
        )}
      </HistoryBlock>

      <HistoryBlock step={4} title="Финансист" subtitle="Шаг 4 — POST …/pipeline/step/4">
        {pipeline?.finance != null ? (
          <ModuleChatPanel title="Финансы" data={pipeline.finance} badge="json" />
        ) : (
          <EmptyHint text="Шаг 4 ещё не выполнялся." />
        )}
      </HistoryBlock>

      <HistoryBlock step={5} title="Маркетолог" subtitle="Шаг 5 — POST …/pipeline/step/5">
        {renderJsonOrString(pipeline?.marketer, 'Шаг 5')}
      </HistoryBlock>

      <HistoryBlock step={6} title="Фото и визуал" subtitle="Шаг 6 — POST …/pipeline/step/6">
        {renderJsonOrString(pipeline?.photoStudio, 'Шаг 6')}
      </HistoryBlock>

      <HistoryBlock
        step={7}
        title="Картинка изделия и визуализации"
        subtitle="Шаг 7 и инструменты"
      >
        {renderPipelineImage(
          'Каталог / галерея (шаг 7)',
          pipeline?.generatedImageUrl as string | null | undefined,
          pipelineImageSrc,
        )}
        {renderPipelineImage(
          'Технический рисунок (инструмент)',
          pipeline?.technicalFlatImageUrl as string | null | undefined,
          pipelineImageSrc,
        )}
        {renderPipelineImage(
          'Студийный образ (инструмент)',
          pipeline?.kidStudioImageUrl as string | null | undefined,
          pipelineImageSrc,
        )}
      </HistoryBlock>

      <HistoryBlock step={8} title="Финальный пакет" subtitle="Шаг 8 — POST …/pipeline/step/8">
        {pipelineStr(pipeline, 'finalPackage').trim() ? (
          <AssistantTextPanel
            title="Финальный пакет"
            badgeLabel="Шаг 8"
            variant="embedded"
            scrollable
          >
            {pipelineStr(pipeline, 'finalPackage')}
          </AssistantTextPanel>
        ) : (
          <EmptyHint text="Шаг 8 ещё не выполнялся." />
        )}
      </HistoryBlock>

      <HistoryBlock
        title="Инструмент: интерпретация лекал"
        subtitle="POST …/tools/pattern-render"
      >
        {pipeline?.patternRender != null ? (
          typeof pipeline.patternRender === 'string' ? (
            <AssistantTextPanel
              title="Лекала"
              badgeLabel="pattern-render"
              variant="embedded"
              scrollable
            >
              {pipeline.patternRender}
            </AssistantTextPanel>
          ) : (
            <ModuleChatPanel
              title="Лекала"
              data={pipeline.patternRender}
              badge="json"
            />
          )
        ) : (
          <EmptyHint text="Не вызывался." />
        )}
      </HistoryBlock>
    </article>
  );
}

function SessionLoadErrorCard({ meta }: { meta: SessionListItem }) {
  return (
    <article
      className="history-session-article history-session-article--error card panel"
      id={`history-session-${meta.id}`}
    >
      <h2 className="history-session-heading">{meta.label}</h2>
      <p className="err history-session-error">
        Не удалось загрузить данные сессии ({meta.id}). Попробуйте обновить страницу.
      </p>
    </article>
  );
}

function lekalaSheet(p: Record<string, unknown> | null | undefined): string {
  if (!p) return '';
  const a = p.lekalaLayoutSheetText;
  const b = p.patternTechPackSheetText;
  if (typeof a === 'string' && a.trim()) return a;
  if (typeof b === 'string' && b.trim()) return b;
  return '';
}

function renderTechnologist(
  pipeline: Record<string, unknown> | null | undefined,
) {
  const t = pipeline?.technologist;
  if (t == null) {
    return <EmptyHint text="Шаг 2 ещё не выполнялся." />;
  }
  if (typeof t === 'string') {
    return (
      <AssistantTextPanel
        title="Технолог"
        badgeLabel="Шаг 2"
        variant="embedded"
        scrollable
      >
        {t}
      </AssistantTextPanel>
    );
  }
  return <ModuleChatPanel title="Технолог" data={t} badge="json" />;
}

function renderJsonOrString(value: unknown, label: string): ReactNode {
  if (value == null) {
    return <EmptyHint text={`${label} ещё не выполнялся.`} />;
  }
  if (typeof value === 'string') {
    return (
      <AssistantTextPanel
        title={label}
        badgeLabel={label}
        variant="embedded"
        scrollable
      >
        {value}
      </AssistantTextPanel>
    );
  }
  return <ModuleChatPanel title={label} data={value} badge="json" />;
}

function renderPipelineImage(
  caption: string,
  url: string | null | undefined,
  resolve: (u: string | null | undefined) => string | null,
) {
  const src = resolve(url);
  if (!src) return null;
  return (
    <figure className="history-pipeline-fig">
      <figcaption className="history-subheading">{caption}</figcaption>
      <div className="history-img-wrap history-img-wrap--pipeline">
        <img src={src} alt={caption} />
      </div>
    </figure>
  );
}

type LoadedChunk =
  | { kind: 'ok'; data: SessionPayload }
  | { kind: 'err'; row: SessionListItem };

export default function SessionHistoryPage() {
  const nav = useNavigate();
  const location = useLocation();
  const token = localStorage.getItem('mvp_token');

  const [list, setList] = useState<SessionListItem[]>([]);
  const [loadedChunks, setLoadedChunks] = useState<LoadedChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      nav('/login', { replace: true });
      return;
    }
    setAuthToken(token);
  }, [token, nav]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr(null);
      try {
        const rows = await listSessions();
        if (cancelled) return;
        setList(rows);
        if (!rows.length) {
          setLoadedChunks([]);
          return;
        }
        const chunks = await Promise.all(
          rows.map(
            async (row): Promise<LoadedChunk> => {
              try {
                const data = (await getSession(row.id)) as SessionPayload;
                return { kind: 'ok', data };
              } catch {
                return { kind: 'err', row };
              }
            },
          ),
        );
        if (cancelled) return;
        setLoadedChunks(chunks);
      } catch {
        if (!cancelled) {
          setErr('Не удалось загрузить историю.');
          setList([]);
          setLoadedChunks([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (loading || !loadedChunks.length) return;
    const h = location.hash;
    if (!h.startsWith('#history-session-')) return;
    const el = document.querySelector(h);
    if (el) {
      window.setTimeout(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [loading, loadedChunks, location.hash]);

  function logout() {
    localStorage.removeItem('mvp_token');
    setAuthToken(null);
    nav('/login', { replace: true });
  }

  if (!token) {
    return null;
  }

  return (
    <div className="app-shell history-page-shell">
      <div className="layout history-page-layout">
        <header className="page-header">
          <div className="brand">
            <h1 className="brand-title">История сессий</h1>
            <p className="brand-tagline">
              Все сохранённые сессии подряд: по блокам и шагам цепочки. Скачать
              полный JSON можно для каждой сессии отдельно.
            </p>
          </div>
          <div className="page-header-actions">
            <ThemeToggle />
            <Link to="/workspace" className="secondary">
              В кабинет
            </Link>
            <button type="button" className="secondary" onClick={logout}>
              Выйти
            </button>
          </div>
        </header>

        {err ? <p className="err">{err}</p> : null}

        <div className="history-page-grid">
          <aside className="history-sidebar card panel" aria-label="Оглавление">
            <h2 className="history-sidebar-title">К сессии</h2>
            {loading ? (
              <p className="muted">Загрузка…</p>
            ) : list.length === 0 ? (
              <p className="muted">Пока нет сессий.</p>
            ) : (
              <ul className="history-session-list">
                {list.map((row) => (
                  <li key={row.id}>
                    <a
                      href={`#history-session-${row.id}`}
                      className="session-history-pill session-history-pill--anchor"
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
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <main className="history-main">
            {loading ? (
              <p className="muted">Загрузка данных всех сессий…</p>
            ) : loadedChunks.length === 0 ? (
              <EmptyHint text="Нет сессий для отображения." />
            ) : (
              loadedChunks.map((chunk) =>
                chunk.kind === 'ok' ? (
                  <HistorySessionSection
                    key={chunk.data.id}
                    session={chunk.data}
                    meta={
                      list.find((l) => l.id === chunk.data.id) ?? {
                        id: chunk.data.id,
                        createdAt: chunk.data.createdAt ?? '',
                        updatedAt: chunk.data.updatedAt ?? '',
                        pipelineMaxStep: chunk.data.pipelineMaxStep ?? 0,
                        analysisApproved: chunk.data.analysisApproved ?? null,
                        label: chunk.data.id.slice(0, 8) + '…',
                        imageCount: chunk.data.images?.length ?? 0,
                      }
                    }
                  />
                ) : (
                  <SessionLoadErrorCard key={chunk.row.id} meta={chunk.row} />
                ),
              )
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
