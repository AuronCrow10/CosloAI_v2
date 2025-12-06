// src/api/billing.ts
import { authFetchJson } from "./authorizedClient";
import type { BotStatus } from "./bots";

export type SubscriptionStatus =
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELED"
  | "INCOMPLETE"
  | "INCOMPLETE_EXPIRED"
  | "TRIALING"
  | "UNPAID";

export interface SubscriptionSummary {
  botId: string;
  botName: string;
  botSlug: string;
  botStatus: BotStatus;
  subscriptionStatus: SubscriptionStatus;
  currency: string;

  totalMonthlyAmountCents: number;
  totalMonthlyAmountFormatted: string;
  featuresAmountCents: number;
  planAmountCents: number;

  usagePlanId: string | null;
  usagePlanName: string | null;
  usagePlanCode: string | null;

  monthlyTokens: number | null;
  usedTokensThisPeriod: number;
  usagePercent: number | null;

  periodStart: string;
  periodEnd: string;
}

export interface PaymentSummary {
  id: string;
  botId: string;
  botName: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  hasInvoice: boolean;
}

export interface BillingOverviewResponse {
  subscriptions: SubscriptionSummary[];
  totalMonthlyAmountCents: number;
  totalMonthlyAmountFormatted: string;
  payments: PaymentSummary[];
}

export async function fetchBillingOverview(): Promise<BillingOverviewResponse> {
  return authFetchJson<BillingOverviewResponse>("/billing/overview");
}

export async function getPaymentInvoiceUrl(
  paymentId: string
): Promise<{ url: string }> {
  return authFetchJson<{ url: string }>(
    `/billing/payments/${encodeURIComponent(paymentId)}/invoice-url`
  );
}
