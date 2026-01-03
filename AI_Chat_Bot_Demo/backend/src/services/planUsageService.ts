// services/planUsageService.ts

import { prisma } from "../prisma/prisma";
import { getUsageForBot } from "./usageAggregationService";
import { getEmailUsageForBot } from "./emailUsageService";

export const EMAIL_TOKEN_COST = 10;
export const WHATSAPP_MESSAGE_TOKEN_COST = 20;

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

  const monthlyTokenLimit = bot.subscription?.usagePlan?.monthlyTokens ?? null;
  const { from, to } = getCurrentMonthUtcRange();

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

  // 3) WhatsApp messages → token-equivalent
  // assistant messages in WA conversations
  const [waAssistantCount, leadSentCount] = await Promise.all([
    prisma.message.count({
      where: {
        conversation: { botId, channel: "WHATSAPP" },
        role: "ASSISTANT",
        createdAt: { gte: from, lt: to }
      }
    }),
    prisma.metaLead.count({
      where: {
        botId,
        whatsappStatus: "SENT",
        createdAt: { gte: from, lt: to }
      }
    })
  ]);

  const whatsappCount = waAssistantCount + leadSentCount;
  const whatsappTokens = whatsappCount * WHATSAPP_MESSAGE_TOKEN_COST;

  const usedTokensTotal = openAITokens + emailTokens + whatsappTokens;

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
