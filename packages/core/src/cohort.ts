import type { OrderOutcome } from '@liveops/live-contracts';

export interface CohortReportBase {
  totalOrders: number;
  completedOrders: number;
  refundedOrders: number;
  repeatOrders: number;
  completeCostOrders: number;
  contributionCents: number | null;
  acquisitionLossBreaches: number;
  dailyLossPoolBreaches: number;
  monthlyLossPoolBreaches: number;
  qualifies: boolean;
  reasons: string[];
}

const COST_FIELDS = [
  'pickupDeliveryCostCents',
  'productionLaborCostCents',
  'materialCostCents',
  'liveLaborCostCents',
  'reworkCostCents',
  'compensationCostCents',
  'equipmentCostCents',
  'softwareCostCents',
] as const;

function allCostPresent(order: OrderOutcome): boolean {
  return COST_FIELDS.every((field) => order[field] !== null);
}

function perOrderContribution(order: OrderOutcome): number {
  const income = order.firstNetSettlementCents ?? 0;
  const cost = COST_FIELDS.reduce((sum, field) => sum + (order[field] ?? 0), 0);
  return income - cost;
}

const ACQUISITION_LOSS_CENTS = 10 * 100;
const DAILY_LOSS_POOL_CENTS = 200 * 100;
const MONTHLY_LOSS_POOL_CENTS = 3000 * 100;
const COMPLETED_ORDER_GOAL = 30;
const REPEAT_ORDER_GOAL = 3;

/**
 * 批次经营核算（PRODUCT_SPEC §6）。
 * 收入取「平台净结算」，平台扣费单独留证审计、不重复扣除；
 * 取送/生产/耗材/直播值守/返工/赔偿/设备折旧/软件成本均计入。
 * 任何成本数据未取得时，批次贡献返回 null（不得判定通过）。
 */
export function calculateCohortReport(orders: OrderOutcome[]): CohortReportBase {
  const totalOrders = orders.length;
  const completedOrders = orders.filter((order) => order.completedAt !== null).length;
  const refundedOrders = orders.filter((order) => order.refundedAt !== null).length;
  const repeatOrders = orders.filter((order) => order.repeatPaidAt !== null && order.repeatAtRegularPrice).length;
  const completeCostOrders = orders.filter(allCostPresent).length;

  const reasons: string[] = [];
  if (totalOrders === 0) reasons.push('尚无合格经营样本');

  const incomplete = orders.some((order) => !allCostPresent(order));
  if (incomplete) {
    reasons.push('存在成本数据未取得，批次贡献暂不计算');
  }

  const contributions = orders.map(perOrderContribution);
  const contributionCents = incomplete ? null : contributions.reduce((sum, value) => sum + value, 0);

  const acquisitionLossBreaches = orders.filter((order, index) => (contributions[index] ?? 0) < -ACQUISITION_LOSS_CENTS).length;

  const dailyNegative = new Map<string, number>();
  const monthlyNegative = new Map<string, number>();
  orders.forEach((order, index) => {
    const contribution = contributions[index] ?? 0;
    if (contribution >= 0) return;
    const paid = new Date(order.firstPaidAt);
    const dayKey = paid.toISOString().slice(0, 10);
    dailyNegative.set(dayKey, (dailyNegative.get(dayKey) ?? 0) + contribution);
    const monthKey = paid.toISOString().slice(0, 7);
    monthlyNegative.set(monthKey, (monthlyNegative.get(monthKey) ?? 0) + contribution);
  });
  const dailyLossPoolBreaches = [...dailyNegative.values()].filter((sum) => sum < -DAILY_LOSS_POOL_CENTS).length;
  const monthlyLossPoolBreaches = [...monthlyNegative.values()].filter((sum) => sum < -MONTHLY_LOSS_POOL_CENTS).length;

  const qualifies =
    completedOrders >= COMPLETED_ORDER_GOAL &&
    repeatOrders >= REPEAT_ORDER_GOAL &&
    contributionCents !== null &&
    contributionCents >= 0 &&
    acquisitionLossBreaches === 0 &&
    dailyLossPoolBreaches === 0 &&
    monthlyLossPoolBreaches === 0;

  if (completedOrders < COMPLETED_ORDER_GOAL) {
    reasons.push(`完成履约 ${completedOrders} / ${COMPLETED_ORDER_GOAL}`);
  }
  if (repeatOrders < REPEAT_ORDER_GOAL) {
    reasons.push(`30天正常价复购 ${repeatOrders} / ${REPEAT_ORDER_GOAL}`);
  }
  if (contributionCents !== null && contributionCents < 0) {
    reasons.push('批次贡献为负，不符合商用条件');
  }
  if (acquisitionLossBreaches > 0) {
    reasons.push(`单笔新客亏损超限 ${acquisitionLossBreaches} 笔`);
  }
  if (dailyLossPoolBreaches > 0) {
    reasons.push(`日亏损池超限 ${dailyLossPoolBreaches} 天`);
  }
  if (monthlyLossPoolBreaches > 0) {
    reasons.push(`月亏损池超限 ${monthlyLossPoolBreaches} 个月`);
  }

  return {
    totalOrders,
    completedOrders,
    refundedOrders,
    repeatOrders,
    completeCostOrders,
    contributionCents,
    acquisitionLossBreaches,
    dailyLossPoolBreaches,
    monthlyLossPoolBreaches,
    qualifies,
    reasons,
  };
}
