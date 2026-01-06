// services/planUsageService.ts

import { prisma } from "../prisma/prisma";
import { getUsageForBot } from "./usageAggregationService";
import { getEmailUsageForBot } from "./emailUsageService";

export const EMAIL_TOKEN_COST = 400;
export const WHATSAPP_MESSAGE_TOKEN_COST = 24000;

export type PlanUsageSnapshot = {
  botId: string;
  monthlyTokenLimit: number | null;
  usedTokensOpenAI: number;
  usedTokensEmails: number;
  usedTokensWhatsapp: number;
  usedTokensTotal: number;
  remainingTokens: number | null;
};

function getCurrentMonthUtcRange(): { from: Date; to: Date } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from, to };
}


async function getCurrentBillingPeriodForBot(
  botId: string
): Promise<{ from: Date; to: Date } | null> {
  const payment = await prisma.payment.findFirst({
    where: {
      botId,
      kind: "SUBSCRIPTION",
      status: "paid",
      periodStart: { not: null },
      periodEnd: { not: null }
    },
    orderBy: { periodStart: "desc" }
  });

  if (!payment?.periodStart || !payment?.periodEnd) {
    return null;
  }

  return { from: payment.periodStart, to: payment.periodEnd };
}


export async function getPlanUsageForBot(
  botId: string
): Promise<PlanUsageSnapshot | null> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: {
      user: true,
      subscription: { include: { usagePlan: true } }
    }
  });

  if (!bot) return null;

  let monthlyTokenLimit =
    bot.subscription?.usagePlan?.monthlyTokens ?? null;

  const billingRange = await getCurrentBillingPeriodForBot(botId);
  const { from, to } = billingRange ?? getCurrentMonthUtcRange();

  // 1) OpenAI usage (chat + crawler + analytics)
  const agg = await getUsageForBot({
    bot: bot as any, // we already included user
    from,
    to
  });

  const openAITokens = agg.totalTokens;

  // 2) Emails → token-equivalent
  const emailUsage = await getEmailUsageForBot({ botId, from, to });
  const emailTokens = emailUsage.count * EMAIL_TOKEN_COST;

  // 3) WhatsApp lead templates → token-equivalent
  const leadSentCount = await prisma.metaLead.count({
    where: {
      botId,
      whatsappStatus: "SENT",
      createdAt: { gte: from, lt: to }
    }
  });

  const whatsappTokens = leadSentCount * WHATSAPP_MESSAGE_TOKEN_COST;

  const usedTokensTotal = openAITokens + emailTokens + whatsappTokens;

  // Add any paid top-ups for this billing period
  if (monthlyTokenLimit && monthlyTokenLimit > 0) {
    const topupPayments = await prisma.payment.findMany({
      where: {
        botId,
        kind: "TOP_UP",
        status: "paid",
        createdAt: {
          gte: from,
          lt: to
        },
        topupTokens: { not: null }
      },
      select: { topupTokens: true }
    });

    const extraTokens = topupPayments.reduce(
      (sum, p) => sum + (p.topupTokens ?? 0),
      0
    );

    monthlyTokenLimit += extraTokens;
  }

  const remainingTokens =
    monthlyTokenLimit && monthlyTokenLimit > 0
      ? Math.max(monthlyTokenLimit - usedTokensTotal, 0)
      : null;

  return {
    botId,
    monthlyTokenLimit,
    usedTokensOpenAI: openAITokens,
    usedTokensEmails: emailTokens,
    usedTokensWhatsapp: whatsappTokens,
    usedTokensTotal,
    remainingTokens
  };
}

/**
 * Check if a bot has enough budget left for an upcoming operation that
 * will cost `requiredTokens`.
 */
export async function ensureBotHasTokens(
  botId: string,
  requiredTokens: number
): Promise<{
  ok: boolean;
  snapshot: PlanUsageSnapshot | null;
}> {
  const snapshot = await getPlanUsageForBot(botId);
  if (!snapshot) {
    // No bot / no subscription / no plan → treat as allowed
    return { ok: true, snapshot: null };
  }

  const limit = snapshot.monthlyTokenLimit;
  if (!limit || limit <= 0) {
    // Unlimited tokens
    return { ok: true, snapshot };
  }

  const projected = snapshot.usedTokensTotal + requiredTokens;
  if (projected > limit) {
    return { ok: false, snapshot };
  }

  return { ok: true, snapshot };
}
