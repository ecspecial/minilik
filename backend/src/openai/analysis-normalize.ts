import { PRODUCT_TYPES } from '../constants/product-types';

function pickProductType(raw: unknown): string {
  if (typeof raw !== 'string') return 'Другое';
  const t = raw.trim();
  if ((PRODUCT_TYPES as readonly string[]).includes(t)) return t;
  const lower = t.toLowerCase();
  for (const p of PRODUCT_TYPES) {
    if (p.toLowerCase() === lower) return p;
  }
  return 'Другое';
}

/**
 * Дополняет ответ Intake полями для UI и жёстко мапит productType в справочник.
 */
export function normalizeIntakeAnalysis(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const vs = data.vision_summary as Record<string, unknown> | undefined;
  const productType = pickProductType(
    vs?.product_type ?? vs?.productType ?? data.productType,
  );

  const season = String(vs?.season ?? data.season ?? '—');
  const silhouette = String(vs?.silhouette ?? data.silhouette ?? '—');

  const likely = vs?.likely_materials;
  const materials = Array.isArray(likely)
    ? likely.map(String).join(', ')
    : String(data.materials ?? '—');

  const keyEl = vs?.key_elements;
  const details = Array.isArray(keyEl)
    ? keyEl.map(String).join(', ')
    : String(data.details ?? '—');

  const uncertain = vs?.uncertain_points;
  const iq = data.input_quality as Record<string, unknown> | undefined;
  const issues = iq?.issues;
  const parts: string[] = [];
  if (data.confidenceNotes != null && String(data.confidenceNotes).trim())
    parts.push(String(data.confidenceNotes));
  if (Array.isArray(uncertain) && uncertain.length)
    parts.push(`Неопределённости: ${uncertain.map(String).join('; ')}`);
  if (Array.isArray(issues) && issues.length)
    parts.push(`Качество входа: ${issues.map(String).join('; ')}`);
  const confidenceNotes = parts.length ? parts.join('\n') : '—';

  return {
    ...data,
    productType,
    season,
    silhouette,
    details,
    materials,
    confidenceNotes,
  };
}
