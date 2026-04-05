/** Парсинг ответа закупщика: текст для людей + JSON для калькулятора. */
export function splitPurchasingResponse(raw: string): {
  report: string;
  costing: Record<string, unknown>;
} {
  const marker = '###CALC_JSON###';
  const i = raw.lastIndexOf(marker);
  if (i === -1) {
    return { report: raw.trim(), costing: defaultPurchasingCosting() };
  }
  const report = raw.slice(0, i).trim();
  const jsonPart = raw.slice(i + marker.length).trim();
  try {
    const costing = JSON.parse(jsonPart) as Record<string, unknown>;
    if (!costing || typeof costing !== 'object') {
      return { report: raw.trim(), costing: defaultPurchasingCosting() };
    }
    return { report, costing: mergePurchasingDefaults(costing) };
  } catch {
    return { report: raw.trim(), costing: defaultPurchasingCosting() };
  }
}

function defaultPurchasingCosting(): Record<string, unknown> {
  return {
    material_cost_base: {
      fabric_cost_per_unit: 1200,
      trim_cost_per_unit: 450,
      packaging_cost_per_unit: 0,
      costing_notes: [
        'оценка по умолчанию: блок ###CALC_JSON### не распознан',
      ],
    },
    manufacturing_cost_per_unit: 2800,
    fabric_options: [],
    trim_list: [],
    waste_percent_estimate: 8,
    price_sources: { fabric: [], trims: [] },
  };
}

function mergePurchasingDefaults(
  c: Record<string, unknown>,
): Record<string, unknown> {
  const d = defaultPurchasingCosting();
  const mcb = {
    ...(d.material_cost_base as Record<string, unknown>),
    ...(typeof c.material_cost_base === 'object' && c.material_cost_base !== null
      ? (c.material_cost_base as Record<string, unknown>)
      : {}),
  };
  return {
    ...d,
    ...c,
    material_cost_base: mcb,
    fabric_options: Array.isArray(c.fabric_options) ? c.fabric_options : [],
    trim_list: Array.isArray(c.trim_list) ? c.trim_list : [],
    price_sources:
      typeof c.price_sources === 'object' && c.price_sources !== null
        ? c.price_sources
        : { fabric: [], trims: [] },
  };
}

export function moduleText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
