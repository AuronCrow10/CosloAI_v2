// services/planUsageService.ts

import { prisma } from "../prisma/prisma";
import { getUsageForBot } from "./usageAggregationService";
import { getEmailUsageForBot } from "./emailUsageService";

export const EMAIL_TOKEN_COST = 400;
export const WHATSAPP_MESSAGE_TOKEN_COST = 1;
export const USAGE_WINDOW_DAYS = 30;
const USAGE_WINDOW_MS = USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type PlanUsageSnapshot = {
  botId: string;
  monthlyTokenLimit: number | null;
  usedTokensOpenAI: number;
  usedTokensEmails: number;
  usedTokensWhatsapp: number;
  usedTokensTotal: number;
  remainingTokens: number | null;
  periodStart: Date;
  periodEnd: Date;
  usageWindowIndex: number | null;
};

export type UsageWindow = {
  from: Date;
  to: Date;
  anchorAt: Date;
  windowIndex: number;
};

function getCurrentMonthUtcRange(): UsageWindow {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    from,
    to,
    anchorAt: from,
    windowIndex: 0
  };
}

function computeUsageWindowFromAnchor(anchorAt: Date, now = new Date()): UsageWindow {
  const diffMs = now.getTime() - anchorAt.getTime();
  const windowIndex = diffMs <= 0 ? 0 : Math.floor(diffMs / USAGE_WINDOW_MS);
  const from = new Date(anchorAt.getTime() + windowIndex * USAGE_WINDOW_MS);
  const to = new Date(from.getTime() + USAGE_WINDOW_MS);

  return { from, to, anchorAt, windowIndex };
}

async function resolveUsageAnchorForSubscription(botId: string, sub: any): Promise<Date | null> {
  if (!sub) return null;
  if (sub.usageAnchorAt) return sub.usageAnchorAt as Date;

  const payment = await prisma.payment.findFirst({
    where: {
      botId,
      kind: "SUBSCRIPTION",
      status: "paid",
      periodStart: { not: null }
    },
    orderBy: { periodStart: "asc" }
  });

  const anchor =
    payment?.periodStart ??
    sub.createdAt ??
    new Date();

  try {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { usageAnchorAt: anchor }
    });
  } catch (err) {
    console.error("[planUsageService] Failed to persist usage anchor", {
      botId,
      subscriptionId: sub.id,
      error: err
    });
  }

  return anchor;
}

export async function getCurrentUsageWindowForBot(
  botId: string
): Promise<UsageWindow | null> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: { subscription: true }
  });

  if (!bot?.subscription) {
    return null;
  }

  const anchorAt = await resolveUsageAnchorForSubscription(botId, bot.subscription);
  if (!anchorAt) return null;

  return computeUsageWindowFromAnchor(anchorAt);
}

export async function getCurrentUsageRangeForBot(
  botId: string
): Promise<{ from: Date; to: Date; windowIndex: number | null }> {
  const usageWindow = await getCurrentUsageWindowForBot(botId);
  if (!usageWindow) {
    const fallback = getCurrentMonthUtcRange();
    return { from: fallback.from, to: fallback.to, windowIndex: null };
  }

  return {
    from: usageWindow.from,
    to: usageWindow.to,
    windowIndex: usageWindow.windowIndex
  };
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

  const usageWindow = await getCurrentUsageWindowForBot(botId);
  const { from, to, windowIndex } = usageWindow ?? getCurrentMonthUtcRange();

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
    remainingTokens,
    periodStart: from,
    periodEnd: to,
    usageWindowIndex: usageWindow ? windowIndex : null
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
