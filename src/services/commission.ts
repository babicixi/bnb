import type { AgentCommissionRule, Id } from "../domain/types.js";

export function calculateAgentCommission(input: {
  salesAgentId?: Id;
  netAmountAfterDiscountVnd: number;
  rules: AgentCommissionRule[];
  asOfDate: string;
}): number {
  if (!input.salesAgentId) {
    return 0;
  }

  const rule = input.rules.find((candidate) => {
    if (!candidate.isActive || candidate.salesAgentId !== input.salesAgentId)
      return false;
    if (candidate.validFrom && candidate.validFrom > input.asOfDate)
      return false;
    if (candidate.validUntil && candidate.validUntil < input.asOfDate)
      return false;
    return true;
  });

  if (!rule) {
    return 0;
  }

  return rule.commissionType === "percentage"
    ? Math.round((input.netAmountAfterDiscountVnd * rule.value) / 100)
    : Math.round(rule.value);
}
