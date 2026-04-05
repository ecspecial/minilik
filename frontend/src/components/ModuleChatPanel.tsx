import { Fragment, useMemo, useState, type ReactNode } from 'react';

/** Нумерованные строки («1. …») — заголовки секций; пустая строка разделяет абзацы-блоки. */
function segmentAssistantText(text: string): (
  | { kind: 'heading'; text: string }
  | { kind: 'body'; lines: string[] }
)[] {
  const rawLines = text.split('\n');
  const segments: (
    | { kind: 'heading'; text: string }
    | { kind: 'body'; lines: string[] }
  )[] = [];
  let bodyBuf: string[] = [];

  const flushBody = () => {
    if (bodyBuf.length) {
      segments.push({ kind: 'body', lines: [...bodyBuf] });
      bodyBuf = [];
    }
  };

  for (const line of rawLines) {
    if (!line.trim()) {
      flushBody();
      continue;
    }
    const t = line.trim();
    if (/^\d+\.\s+\S/.test(t)) {
      flushBody();
      segments.push({ kind: 'heading', text: t });
    } else {
      bodyBuf.push(line);
    }
  }
  flushBody();
  return segments;
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function JsonChatNode({
  value,
  depth,
}: {
  value: unknown;
  depth: number;
}): ReactNode {
  if (value === null || value === undefined) {
    return <span className="chat-scalar chat-scalar--muted">—</span>;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    const s = String(value);
    if (s.length > 280 && depth === 0) {
      return <p className="chat-paragraph">{s}</p>;
    }
    return <span className="chat-scalar">{s}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="chat-scalar chat-scalar--muted">пусто</span>;
    }
    const allPrimitive = value.every(
      (x) =>
        x === null ||
        x === undefined ||
        typeof x === 'string' ||
        typeof x === 'number' ||
        typeof x === 'boolean',
    );
    if (allPrimitive) {
      return (
        <ul className="chat-list">
          {value.map((x, i) => (
            <li key={i}>{String(x)}</li>
          ))}
        </ul>
      );
    }
    return (
      <ul className="chat-list chat-list--nested">
        {value.map((x, i) => (
          <li key={i}>
            <JsonChatNode value={x} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (rec.parseError === true && typeof rec.raw === 'string') {
      return (
        <p className="chat-warning">
          Ответ не удалось разобрать как JSON. Фрагмент:{' '}
          <code className="chat-code-inline">{rec.raw.slice(0, 400)}…</code>
        </p>
      );
    }
    const entries = Object.entries(rec);
    if (entries.length === 0) {
      return <span className="chat-scalar chat-scalar--muted">∅</span>;
    }
    return (
      <div
        className="chat-object"
        style={{ marginLeft: depth > 0 ? '0.65rem' : undefined }}
      >
        {entries.map(([k, v]) => (
          <div key={k} className="chat-kv">
            <div className="chat-key">{humanizeKey(k)}</div>
            <div className="chat-val">
              <JsonChatNode value={v} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return <span className="chat-scalar">{String(value)}</span>;
}

type PanelBadge = 'module' | 'json';

export function ModuleChatPanel({
  id,
  title,
  data,
  badge = 'module',
}: {
  id?: string;
  title: string;
  data: unknown;
  badge?: PanelBadge;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const rawJson = useMemo(() => JSON.stringify(data, null, 2), [data]);

  if (data === undefined) return null;

  return (
    <section id={id} className="card panel workspace-anchor module-chat-panel">
      <div className="panel-header">
        <span className={`panel-badge ${badge === 'json' ? 'panel-badge--soft' : ''}`}>
          {badge === 'json' ? 'Данные' : 'Модуль'}
        </span>
        <h2 style={{ margin: 0 }}>{title}</h2>
      </div>
      <div className="chat-thread" aria-label={`Ответ: ${title}`}>
        <div className="chat-msg chat-msg--assistant">
          <div className="chat-msg-avatar" aria-hidden>
            <span>ИИ</span>
          </div>
          <div className="chat-msg-stack">
            <span className="chat-msg-role">Ассистент</span>
            <div className="chat-msg-bubble">
              <JsonChatNode value={data} depth={0} />
            </div>
            <details
              className="chat-raw"
              open={rawOpen}
              onToggle={(e) =>
                setRawOpen((e.target as HTMLDetailsElement).open)
              }
            >
              <summary className="chat-raw-summary">Сырой JSON</summary>
              <pre className="chat-raw-pre">{rawJson}</pre>
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}

function AssistantTextBubble({
  text,
  scrollable,
}: {
  text: string;
  scrollable?: boolean;
}) {
  const segments = useMemo(() => segmentAssistantText(text), [text]);

  return (
    <div className="chat-thread chat-thread--embedded">
      <div className="chat-msg chat-msg--assistant">
        <div className="chat-msg-avatar" aria-hidden>
          <span>ИИ</span>
        </div>
        <div className="chat-msg-stack">
          <span className="chat-msg-role">Ассистент</span>
          <div
            className={`chat-msg-bubble chat-msg-bubble--text${scrollable ? ' chat-msg-bubble--scroll' : ''}`}
          >
            <div className="chat-formatted">
              {segments.map((seg, i) => {
                if (seg.kind === 'heading') {
                  return (
                    <p
                      key={`h-${i}`}
                      className="chat-paragraph chat-paragraph--section-heading"
                    >
                      {seg.text}
                    </p>
                  );
                }
                return (
                  <div key={`b-${i}`} className="chat-body-block">
                    {seg.lines.map((line, j) => (
                      <Fragment key={j}>
                        {j > 0 ? <br /> : null}
                        {line}
                      </Fragment>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Текстовый ответ в том же стиле, что и блоки-модули. */
export function AssistantTextPanel({
  id,
  title,
  badgeLabel,
  children,
  variant = 'card',
  scrollable = true,
}: {
  id?: string;
  title: string;
  badgeLabel?: string;
  children: string;
  variant?: 'card' | 'embedded';
  /** Ограничить высоту и прокрутку (не на всю страницу) */
  scrollable?: boolean;
}) {
  if (!children?.trim()) return null;
  if (variant === 'embedded') {
    return <AssistantTextBubble text={children} scrollable={scrollable} />;
  }
  return (
    <section id={id} className="card panel workspace-anchor module-chat-panel">
      <div className="panel-header">
        <span className="panel-badge">{badgeLabel ?? 'Ответ'}</span>
        <h2 style={{ margin: 0 }}>{title}</h2>
      </div>
      <AssistantTextBubble text={children} scrollable={scrollable} />
    </section>
  );
}
