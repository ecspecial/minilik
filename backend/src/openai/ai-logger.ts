import { Logger } from '@nestjs/common';

const logger = new Logger('AI_TIMING');

export async function withTiming<T>(
  label: string,
  meta: Record<string, string | number | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const metaStr = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  logger.log(`→ START ${label}${metaStr ? ` | ${metaStr}` : ''}`);
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - started);
    logger.log(`← OK    ${label} | ${ms}ms`);
    return result;
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    logger.error(`← FAIL  ${label} | ${ms}ms | ${formatErr(err)}`);
    throw err;
  }
}

export function formatErr(err: unknown): string {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const status = o.status ?? o.statusCode;
    const msg = (o.message as string) || String(err);
    const code = o.code;
    const type = (o as { error?: { type?: string; code?: string } }).error;
    const bits = [msg];
    if (status !== undefined) bits.push(`http=${status}`);
    if (code) bits.push(`code=${code}`);
    if (type?.type) bits.push(`type=${type.type}`);
    if (type?.code) bits.push(`apiCode=${type.code}`);
    return bits.join(' | ');
  }
  return String(err);
}
