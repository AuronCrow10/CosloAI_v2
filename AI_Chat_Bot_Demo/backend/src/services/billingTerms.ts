export type BillingTerm = "MONTHLY" | "SEMI_ANNUAL" | "ANNUAL";

const BILLING_TERM_MONTHS: Record<BillingTerm, number> = {
  MONTHLY: 1,
  SEMI_ANNUAL: 6,
  ANNUAL: 12
};

export function normalizeBillingTerm(value: unknown): BillingTerm {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "SEMI_ANNUAL") return "SEMI_ANNUAL";
  if (raw === "ANNUAL") return "ANNUAL";
  return "MONTHLY";
}

export function billingTermMonths(term: BillingTerm): number {
  return BILLING_TERM_MONTHS[term];
}

export type PlanTermPrice = {
  billingTerm: BillingTerm;
  months: number;
  amountCents: number;
  monthlyEquivalentAmountCents: number;
  currency: string;
  stripePriceId: string | null;
};

function safeMonthlyEquivalent(amountCents: number, months: number): number {
  return Math.round(amountCents / months);
}

export function getPlanTermPrice(
  plan: any,
  billingTerm: BillingTerm
): PlanTermPrice {
  const currency = String(plan?.currency || "eur").toLowerCase();

  if (billingTerm === "SEMI_ANNUAL") {
    const amountCents =
      typeof plan?.semiAnnualAmountCents === "number"
        ? plan.semiAnnualAmountCents
        : (plan?.monthlyAmountCents ?? 0) * 6;
    return {
      billingTerm,
      months: 6,
      amountCents,
      monthlyEquivalentAmountCents: safeMonthlyEquivalent(amountCents, 6),
      currency,
      stripePriceId: plan?.stripeSemiAnnualPriceId || null
    };
  }

  if (billingTerm === "ANNUAL") {
    const amountCents =
      typeof plan?.annualAmountCents === "number"
        ? plan.annualAmountCents
        : (plan?.monthlyAmountCents ?? 0) * 12;
    return {
      billingTerm,
      months: 12,
      amountCents,
      monthlyEquivalentAmountCents: safeMonthlyEquivalent(amountCents, 12),
      currency,
      stripePriceId: plan?.stripeAnnualPriceId || null
    };
  }

  const amountCents = plan?.monthlyAmountCents ?? 0;
  return {
    billingTerm: "MONTHLY",
    months: 1,
    amountCents,
    monthlyEquivalentAmountCents: amountCents,
    currency,
    stripePriceId: plan?.stripePriceId || null
  };
}

export function listPlanTermPrices(plan: any): PlanTermPrice[] {
  const monthly = getPlanTermPrice(plan, "MONTHLY");
  const termPrices: PlanTermPrice[] = [monthly];

  if (monthly.amountCents > 0) {
    const semi = getPlanTermPrice(plan, "SEMI_ANNUAL");
    if (semi.stripePriceId && semi.amountCents > 0) {
      termPrices.push(semi);
    }

    const annual = getPlanTermPrice(plan, "ANNUAL");
    if (annual.stripePriceId && annual.amountCents > 0) {
      termPrices.push(annual);
    }
  }

  return termPrices;
}

export type PlanChangeDirection = "UPGRADE" | "DOWNGRADE" | "UNCHANGED";

export function classifyPlanChange(params: {
  currentMonthlyAmountCents: number;
  targetMonthlyAmountCents: number;
  currentBillingTerm: BillingTerm;
  targetBillingTerm: BillingTerm;
}): PlanChangeDirection {
  const {
    currentMonthlyAmountCents,
    targetMonthlyAmountCents,
    currentBillingTerm,
    targetBillingTerm
  } = params;

  if (
    currentMonthlyAmountCents === targetMonthlyAmountCents &&
    currentBillingTerm === targetBillingTerm
  ) {
    return "UNCHANGED";
  }

  if (targetMonthlyAmountCents > currentMonthlyAmountCents) {
    return "UPGRADE";
  }

  if (targetMonthlyAmountCents < currentMonthlyAmountCents) {
    return "DOWNGRADE";
  }

  const currentMonths = billingTermMonths(currentBillingTerm);
  const targetMonths = billingTermMonths(targetBillingTerm);

  return targetMonths > currentMonths ? "UPGRADE" : "DOWNGRADE";
}
