import {
  ECONOMY_STUBS,
  variablePercentSum,
  type SalesChannel,
  type Scenario,
} from '../constants/economy-stubs';

export type EconomyLine = {
  /** Себестоимость: ткань + фурнитура + производство */
  fullCost: number;
  recommendedPrice: number;
  /** Для расчёта от выбранной розничной цены */
  assumedRetailPrice: number;
  commissionPct: number;
  commissionAmount: number;
  logistics: number;
  marketingPct: number;
  marketingAmount: number;
  returnsPct: number;
  returnsAmount: number;
  paymentPct: number;
  paymentAmount: number;
  /** Сумма долей от цены (кроме логистики в ₽) */
  variablePercentTotal: number;
  grossProfit: number;
  marginPct: number;
  minBreakEvenPrice: number;
  scenario: Scenario;
  channel: SalesChannel;
  disclaimer: string;
};

export function calculateLine(input: {
  fabricCost: number;
  hardwareCost: number;
  productionCost: number;
  channel: SalesChannel;
  scenario: Scenario;
}): EconomyLine {
  const stub = ECONOMY_STUBS[input.channel][input.scenario];
  const fullCost =
    input.fabricCost + input.hardwareCost + input.productionCost;
  const recommendedPrice = Math.round(
    fullCost * stub.markupRecommended,
  );
  const price = recommendedPrice;

  const commissionAmount = (price * stub.commissionPct) / 100;
  const marketingAmount = (price * stub.marketingPct) / 100;
  const returnsAmount = (price * stub.returnsPct) / 100;
  const paymentAmount = (price * stub.paymentPct) / 100;
  const variablePercentTotal = variablePercentSum(stub);

  const variableCosts =
    fullCost +
    stub.logisticsPerUnit +
    commissionAmount +
    marketingAmount +
    returnsAmount +
    paymentAmount;

  const grossProfit = price - variableCosts;
  const marginPct = price > 0 ? (grossProfit / price) * 100 : 0;

  const netMarginFactor = variablePercentTotal / 100;
  const minBreakEvenPrice =
    netMarginFactor < 0.99
      ? Math.round(
          (fullCost + stub.logisticsPerUnit) / (1 - netMarginFactor),
        )
      : price;

  let disclaimer =
    'Условный расчёт MVP: ставки из конфига-заглушки, не данные WB/Ozon/фактура.';
  if (input.channel === 'wb' && input.scenario === 'base') {
    disclaimer += ` WB база: сумма комиссия+маркетинг+возвраты+эквайринг = ${variablePercentTotal}% от цены (логистика отдельно).`;
  }

  return {
    fullCost: Math.round(fullCost),
    recommendedPrice: price,
    assumedRetailPrice: price,
    commissionPct: stub.commissionPct,
    commissionAmount: Math.round(commissionAmount),
    logistics: stub.logisticsPerUnit,
    marketingPct: stub.marketingPct,
    marketingAmount: Math.round(marketingAmount),
    returnsPct: stub.returnsPct,
    returnsAmount: Math.round(returnsAmount),
    paymentPct: stub.paymentPct,
    paymentAmount: Math.round(paymentAmount),
    variablePercentTotal,
    grossProfit: Math.round(grossProfit),
    marginPct: Math.round(marginPct * 10) / 10,
    minBreakEvenPrice,
    scenario: input.scenario,
    channel: input.channel,
    disclaimer,
  };
}
