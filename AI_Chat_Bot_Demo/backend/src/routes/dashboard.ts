// src/routes/dashboard.ts
import { Router, Request, Response } from "express";
import { subDays, startOfDay, startOfMonth, addDays } from "date-fns";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import {
  fetchKnowledgeUsageForClient,
  KnowledgeUsageSummary
} from "../services/knowledgeUsageService";

const router = Router();

// Protect everything under /dashboard with auth
router.use("/dashboard", requireAuth);

/**
 * Given a knowledge usage summary, compute crawler training + search tokens.
 * We use totalTokens here because that's what you pay on (same logic as usageAggregationService).
 */
function computeCrawlerTokens(
  knowledge: KnowledgeUsageSummary | null
): { trainingTokens: number; searchTokens: number; totalTokens: number } {
  if (!knowledge) {
    return { trainingTokens: 0, searchTokens: 0, totalTokens: 0 };
  }

  let trainingTokens = 0;
  let searchTokens = 0;

  for (const op of knowledge.byOperation || []) {
    if (op.operation === "embeddings_ingest") {
      trainingTokens += op.totalTokens;
    } else if (op.operation === "embeddings_search") {
      searchTokens += op.totalTokens;
    }
  }

  return {
    trainingTokens,
    searchTokens,
    totalTokens: trainingTokens + searchTokens
  };
}

/**
 * GET /api/dashboard/overview
 *
 * Returns:
 * - KPIs
 * - Conversations last 10 days per bot
 * - Tokens last 10 days per bot (AI + Knowledge)
 * - Top bots by conversations in last 30 days
 */
router.get(
  "/dashboard/overview",
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;

    const now = new Date();
    const today = startOfDay(now);
    const tenDaysAgo = subDays(today, 9); // inclusive, 10 days window
    const thirtyDaysAgo = subDays(today, 29);
    const monthStart = startOfMonth(now);

    // Important:
    // We need:
    // - tokens "this month" => monthStart.now
    // - tokens "last 10 days" => tenDaysAgo.now
    // So fetch OpenAI usage from the earlier of those two dates.
    const windowStart = tenDaysAgo < monthStart ? tenDaysAgo : monthStart;

    type BotLite = {
      id: string;
      name: string;
      status: string;
      knowledgeClientId: string | null;
    };

    // 1) Load bots + conversations + OpenAI usage for this user
    const [bots, conversationsLast30, openAiUsageSinceWindowStart] =
      await Promise.all([
        prisma.bot.findMany({
          where: { userId },
          select: {
            id: true,
            name: true,
            status: true,
            knowledgeClientId: true
          }
        }) as unknown as Promise<BotLite[]>,
        prisma.conversation.findMany({
          where: {
            bot: { userId },
            lastMessageAt: { gte: thirtyDaysAgo }
          },
          select: {
            id: true,
            botId: true,
            lastMessageAt: true
          }
        }),
        prisma.openAIUsage.findMany({
          where: {
            bot: { userId },
            botId: { not: null },
            createdAt: { gte: windowStart }
          },
          select: {
            botId: true,
            totalTokens: true,
            createdAt: true
          }
        })
      ]);

    const botIds = bots.map((b) => b.id);

    // 1.5) Load plan limits + monthly email usage
    const [subscriptions, totalEmailsThisMonth] = await Promise.all([
      prisma.subscription.findMany({
        where: { botId: { in: botIds } },
        select: {
          botId: true,
          status: true,
          usagePlan: {
            select: {
              monthlyTokens: true,
              monthlyEmails: true
            }
          }
        }
      }),
      prisma.emailUsage.count({
        where: {
          botId: { in: botIds },
          createdAt: { gte: monthStart, lt: now }
        }
      })
    ]);

    // Map botId -> { name, status }
    const botMap = new Map<string, { name: string; status: string }>();
    bots.forEach((b) =>
      botMap.set(b.id, {
        name: b.name,
        status: b.status
      })
    );

    // ----- KPIs -----
    const totalBots = bots.length;
    const activeBots = bots.filter((b) => b.status === "ACTIVE").length;
    const totalConversationsLast30Days = conversationsLast30.length;

    // AI tokens this month (filter to monthStart.now)
    const aiTokensThisMonth = openAiUsageSinceWindowStart
      .filter((u) => u.createdAt >= monthStart)
      .reduce((sum, u) => sum + u.totalTokens, 0);

    // Knowledge tokens this month (sum ingest + search)
    const knowledgeBots = bots.filter((b) => !!b.knowledgeClientId);

    const knowledgeTokensThisMonth = (
      await Promise.all(
        knowledgeBots.map(async (b) => {
          try {
            const summary = await fetchKnowledgeUsageForClient({
              clientId: b.knowledgeClientId as string,
              from: monthStart,
              to: now
            });

            return computeCrawlerTokens(summary).totalTokens;
          } catch (err) {
            console.error(
              "Failed to fetch monthly knowledge usage for bot",
              b.id,
              err
            );
            return 0;
          }
        })
      )
    ).reduce((sum, v) => sum + v, 0);

    const totalTokensThisMonth = aiTokensThisMonth + knowledgeTokensThisMonth;

    // ----- Plan totals (sum across bots) -----
    // Plans are per-bot (Subscription -> UsagePlan). For the dashboard KPIs we aggregate usage across all bots,
    // so we also aggregate the limits the same way.
    // If ANY plan is unlimited (null), the aggregated limit becomes null (unlimited).
    const allowedStatuses = new Set(["ACTIVE", "TRIALING", "PAST_DUE"]);

    let monthlyTokensLimit: number | null = 0;
    let monthlyEmailsLimit: number | null = 0;

    for (const s of subscriptions) {
      if (!allowedStatuses.has(s.status)) continue;
      const plan = s.usagePlan;
      if (!plan) continue;

      if (monthlyTokensLimit !== null) {
        if (plan.monthlyTokens == null) monthlyTokensLimit = null;
        else monthlyTokensLimit += plan.monthlyTokens;
      }

      if (monthlyEmailsLimit !== null) {
        if (plan.monthlyEmails == null) monthlyEmailsLimit = null;
        else monthlyEmailsLimit += plan.monthlyEmails;
      }
    }

    const tokensUsagePercent =
      monthlyTokensLimit && monthlyTokensLimit > 0
        ? (totalTokensThisMonth / monthlyTokensLimit) * 100
        : null;

    const emailsUsagePercent =
      monthlyEmailsLimit && monthlyEmailsLimit > 0
        ? (totalEmailsThisMonth / monthlyEmailsLimit) * 100
        : null;

    // Helper: format a date as YYYY-MM-DD
    const toDayString = (d: Date): string => d.toISOString().slice(0, 10);

    // Prebuild the last 10 days array + their day-start Date objects
    const dates: string[] = [];
    const dateStarts: Date[] = [];
    for (let i = 9; i >= 0; i--) {
      const d = startOfDay(subDays(today, i));
      dateStarts.push(d);
      dates.push(toDayString(d));
    }

    // ----- Conversations last 10 days per bot -----
    const conversationsLast10 = conversationsLast30.filter(
      (c) => c.lastMessageAt >= tenDaysAgo
    );

    // key: `${day}|${botId}` -> count
    const convDailyMap = new Map<string, number>();

    conversationsLast10.forEach((c) => {
      const botId = c.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(c.lastMessageAt));
      const key = `${dayKey}|${botId}`;
      convDailyMap.set(key, (convDailyMap.get(key) || 0) + 1);
    });

    const conversationsSeries = bots.map((bot) => {
      const values = dates.map((day) => {
        const key = `${day}|${bot.id}`;
        return convDailyMap.get(key) || 0;
      });

      return {
        botId: bot.id,
        botName: bot.name,
        values
      };
    });

    // ----- Tokens last 10 days per bot -----
    // 1) AI tokens
    const openAiUsageLast10 = openAiUsageSinceWindowStart.filter(
      (u) => u.createdAt >= tenDaysAgo
    );

    const tokensDailyMap = new Map<string, number>(); // `${day}|${botId}` -> tokens

    openAiUsageLast10.forEach((u) => {
      const botId = u.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(u.createdAt));
      const key = `${dayKey}|${botId}`;
      tokensDailyMap.set(key, (tokensDailyMap.get(key) || 0) + u.totalTokens);
    });

    // 2) Knowledge tokens (ingest+search), fetched per day
    // NOTE: This keeps your API response unchanged; it just makes the numbers correct.
    await Promise.all(
      knowledgeBots.flatMap((b) => {
        const clientId = b.knowledgeClientId as string;

        return dateStarts.map(async (dayStart) => {
          const dayEnd = addDays(dayStart, 1);
          const dayKey = toDayString(dayStart);
          const key = `${dayKey}|${b.id}`;

          try {
            const summary = await fetchKnowledgeUsageForClient({
              clientId,
              from: dayStart,
              to: dayEnd
            });

            const crawlerTokens = computeCrawlerTokens(summary).totalTokens;
            if (crawlerTokens > 0) {
              tokensDailyMap.set(
                key,
                (tokensDailyMap.get(key) || 0) + crawlerTokens
              );
            }
          } catch (err) {
            console.error(
              "Failed to fetch daily knowledge usage for bot",
              b.id,
              dayKey,
              err
            );
          }
        });
      })
    );

    const tokensSeries = bots.map((bot) => {
      const values = dates.map((day) => {
        const key = `${day}|${bot.id}`;
        return tokensDailyMap.get(key) || 0;
      });

      return {
        botId: bot.id,
        botName: bot.name,
        values
      };
    });

    // ----- Top bots by conversations (last 30 days) -----
    const conversationsByBot = new Map<
      string,
      { count: number; lastConversationAt: Date | null }
    >();

    conversationsLast30.forEach((c) => {
      const botId = c.botId;
      if (!botId) return;

      const existing =
        conversationsByBot.get(botId) || {
          count: 0,
          lastConversationAt: null as Date | null
        };

      existing.count += 1;
      if (
        !existing.lastConversationAt ||
        c.lastMessageAt > existing.lastConversationAt
      ) {
        existing.lastConversationAt = c.lastMessageAt;
      }

      conversationsByBot.set(botId, existing);
    });

    const topBotsByConversationsLast30Days = Array.from(
      conversationsByBot.entries()
    )
      .map(([botId, info]) => ({
        botId,
        botName: botMap.get(botId)?.name ?? "Unknown bot",
        conversationCount: info.count,
        lastConversationAt: info.lastConversationAt
          ? info.lastConversationAt.toISOString()
          : null
      }))
      .sort((a, b) => b.conversationCount - a.conversationCount)
      .slice(0, 5);

    // ----- Final response -----
    res.json({
      kpis: {
        totalBots,
        activeBots,
        totalConversationsLast30Days,
        totalTokensThisMonth,
        monthlyTokensLimit,
        tokensUsagePercent,
        totalEmailsThisMonth,
        monthlyEmailsLimit,
        emailsUsagePercent
      },
      conversationsLast10Days: {
        dates,
        series: conversationsSeries
      },
      tokensLast10Days: {
        dates,
        series: tokensSeries
      },
      topBotsByConversationsLast30Days
    });
  }
);

export default router;
