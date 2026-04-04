export type SalesChannel = 'wb' | 'ozon' | 'site';
export type Scenario = 'pessimistic' | 'base' | 'optimistic';

/** Заглушки: не боевые ставки WB/Ozon. Меняются только конфигом. */
export type ChannelStub = {
  commissionPct: number;
  logisticsPerUnit: number;
  marketingPct: number;
  returnsPct: number;
  paymentPct: number;
  /** Множитель к себестоимости для «рекомендованной цены» (упрощённо) */
  markupRecommended: number;
};

/** Сумма долей от цены: commission + marketing + returns + payment (логистика — отдельно в ₽). */
export function variablePercentSum(stub: ChannelStub): number {
  return (
    stub.commissionPct +
    stub.marketingPct +
    stub.returnsPct +
    stub.paymentPct
  );
}

/**
 * Wildberries (заглушка): в базовом сценарии сумма «комиссионных» процентов от цены = 55%.
 * Распределение условное; логистика по-прежнему фикс в ₽.
 */
export const ECONOMY_STUBS: Record<
  SalesChannel,
  Record<Scenario, ChannelStub>
> = {
  wb: {
    pessimistic: {
      commissionPct: 36,
      logisticsPerUnit: 380,
      marketingPct: 11,
      returnsPct: 15,
      paymentPct: 3,
      markupRecommended: 2.4,
    },
    base: {
      commissionPct: 30,
      logisticsPerUnit: 290,
      marketingPct: 9,
      returnsPct: 13,
      paymentPct: 3,
      markupRecommended: 2.05,
    },
    optimistic: {
      commissionPct: 25,
      logisticsPerUnit: 220,
      marketingPct: 7,
      returnsPct: 11,
      paymentPct: 2,
      markupRecommended: 1.85,
    },
  },
  ozon: {
    pessimistic: {
      commissionPct: 30,
      logisticsPerUnit: 410,
      marketingPct: 15,
      returnsPct: 20,
      paymentPct: 2.2,
      markupRecommended: 2.45,
    },
    base: {
      commissionPct: 25,
      logisticsPerUnit: 310,
      marketingPct: 11,
      returnsPct: 14,
      paymentPct: 1.9,
      markupRecommended: 2.1,
    },
    optimistic: {
      commissionPct: 21,
      logisticsPerUnit: 240,
      marketingPct: 8,
      returnsPct: 9,
      paymentPct: 1.6,
      markupRecommended: 1.9,
    },
  },
  site: {
    pessimistic: {
      commissionPct: 4,
      logisticsPerUnit: 350,
      marketingPct: 22,
      returnsPct: 12,
      paymentPct: 2.4,
      markupRecommended: 2.6,
    },
    base: {
      commissionPct: 3,
      logisticsPerUnit: 260,
      marketingPct: 16,
      returnsPct: 8,
      paymentPct: 2.0,
      markupRecommended: 2.25,
    },
    optimistic: {
      commissionPct: 2.2,
      logisticsPerUnit: 190,
      marketingPct: 11,
      returnsPct: 5,
      paymentPct: 1.7,
      markupRecommended: 2.0,
    },
  },
};

/** Для подсказок в UI / дисклеймере */
export const WB_BASE_VARIABLE_PCT_TOTAL = variablePercentSum(
  ECONOMY_STUBS.wb.base,
);
