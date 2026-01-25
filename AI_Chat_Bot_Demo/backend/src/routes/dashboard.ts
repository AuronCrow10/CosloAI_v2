// src/routes/dashboard.ts
import { Router, Request, Response } from "express";
import { subDays, startOfDay, startOfMonth, addDays, differenceInCalendarDays } from "date-fns";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import {
  fetchKnowledgeUsageForClient,
  KnowledgeUsageSummary
} from "../services/knowledgeUsageService";
import {
  EMAIL_TOKEN_COST,
  WHATSAPP_MESSAGE_TOKEN_COST,
  getPlanUsageForBot
} from "../services/planUsageService";

const router = Router();

// Protect everything under /dashboard with auth
router.use("/dashboard", requireAuth);

const MAX_RANGE_DAYS = 90;

function parseRangeDays(
  req: Request,
  fallbackDays: number,
  maxDays = MAX_RANGE_DAYS
): number {
  const raw = req.query.days;
  if (typeof raw !== "string") return fallbackDays;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallbackDays;
  const clamped = Math.max(1, Math.min(maxDays, Math.floor(parsed)));
  return clamped;
}

/**
 * Given a knowledge usage summary, compute crawler training + search tokens.
 * We use totalTokens here because that's what you pay on
 * (same logic as usageAggregationService).
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

async function sumTokensForRange(
  botIds: string[],
  from: Date,
  to: Date,
  knowledgeBots?: { id: string; knowledgeClientId: string | null }[]
): Promise<number> {
  if (!botIds.length) return 0;

  const openAi = await prisma.openAIUsage.aggregate({
    where: {
      botId: { in: botIds },
      createdAt: { gte: from, lt: addDays(to, 1) }
    },
    _sum: { totalTokens: true }
  });
  const openAiTokens = openAi._sum.totalTokens || 0;

  const kbots =
    knowledgeBots ??
    (await prisma.bot.findMany({
      where: { id: { in: botIds }, knowledgeClientId: { not: null } },
      select: { id: true, knowledgeClientId: true }
    }));

  let knowledgeTokens = 0;
  await Promise.all(
    kbots.map(async (b) => {
      if (!b.knowledgeClientId) return;
      try {
        const summary = await fetchKnowledgeUsageForClient({
          clientId: b.knowledgeClientId as string,
          from,
          to: addDays(to, 1)
        });
        knowledgeTokens += computeCrawlerTokens(summary).totalTokens;
      } catch (err) {
        console.error("Failed to fetch knowledge usage for range", b.id, err);
      }
    })
  );

  const emailCount = await prisma.emailUsage.count({
    where: {
      botId: { in: botIds },
      createdAt: { gte: from, lt: addDays(to, 1) }
    }
  });

  const waCount = await prisma.metaLead.count({
    where: {
      botId: { in: botIds },
      whatsappStatus: "SENT",
      createdAt: { gte: from, lt: addDays(to, 1) }
    }
  });

  return (
    openAiTokens +
    knowledgeTokens +
    emailCount * EMAIL_TOKEN_COST +
    waCount * WHATSAPP_MESSAGE_TOKEN_COST
  );
}

/**
 * GET /api/dashboard/overview
 *
 * Returns:
 * - KPIs
 * - Conversations last 10 days per bot
 * - Tokens last 10 days per bot (AI + Knowledge + Email + WA lead templates)
 * - Token breakdown per day by channel (OpenAI+knowledge / email / WA)
 * - Token breakdown by bot (OpenAI+knowledge / email / WA) over the last 10 days
 * - Top bots by conversations in last 30 days
 */
router.get(
  "/dashboard/overview",
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;

    const now = new Date();
    const today = startOfDay(now);
    const tenDaysAgo = subDays(today, 9); // inclusive, 10-day window
    const thirtyDaysAgo = subDays(today, 29);
    const monthStart = startOfMonth(now);

    // We need:
    // - tokens "this month" => monthStart..now
    // - tokens "last 10 days" => tenDaysAgo..now
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

    // 1.5) Load plan limits + monthly email usage + monthly WA lead templates
    const [subscriptions, totalEmailsThisMonth, totalLeadTemplatesThisMonth] =
      await Promise.all([
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
        }),
        // Only WhatsApp lead templates that were actually SENT
        prisma.metaLead.count({
          where: {
            botId: { in: botIds },
            whatsappStatus: "SENT",
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

    const planSnapshots = await Promise.all(
      botIds.map((botId) => getPlanUsageForBot(botId))
    );

    // Map botId -> snapshot for easy lookup
    const planUsageByBot = new Map<
      string,
      { monthlyTokenLimit: number | null; usedTokensTotal: number }
    >();

    for (const snap of planSnapshots) {
      if (!snap) continue;
        planUsageByBot.set(snap.botId, {
        monthlyTokenLimit: snap.monthlyTokenLimit,
      usedTokensTotal: snap.usedTokensTotal
    });
  }


    // ----- KPIs -----
const totalBots = bots.length;
const activeBots = bots.filter((b) => b.status === "ACTIVE").length;
const totalConversationsLast30Days = conversationsLast30.length;

const allowedStatuses = new Set(["ACTIVE", "TRIALING", "PAST_DUE"]);

let totalTokensThisMonth = 0;
let monthlyTokensLimit: number | null = 0;
let monthlyEmailsLimit: number | null = 0;

// Aggregate plan usage snapshots and plan limits across all bots
for (const bot of bots) {
  const snap = planUsageByBot.get(bot.id);
  if (snap) {
    // OpenAI + knowledge + emails + WhatsApp (current billing period / month)
    totalTokensThisMonth += snap.usedTokensTotal;
  }

  const sub = subscriptions.find((s) => s.botId === bot.id);
  if (!sub) continue;
  if (!allowedStatuses.has(sub.status)) continue;
  const plan = sub.usagePlan;
  if (!plan) continue;

  // Token limit: use snapshot limit (includes top-ups) when available,
  // otherwise fall back to the raw plan monthlyTokens
  if (monthlyTokensLimit !== null) {
    const limitForBot =
      (snap && snap.monthlyTokenLimit != null
        ? snap.monthlyTokenLimit
        : plan.monthlyTokens) ?? null;

    if (limitForBot == null) {
      monthlyTokensLimit = null;
    } else {
      monthlyTokensLimit += limitForBot;
    }
  }

  // Email limit aggregation stays plan-based
  if (monthlyEmailsLimit !== null) {
    if (plan.monthlyEmails == null) monthlyEmailsLimit = null;
    else monthlyEmailsLimit += plan.monthlyEmails;
  }
}

    const tokensUsagePercent =
      monthlyTokensLimit && monthlyTokensLimit > 0
      ? Math.min(100, (totalTokensThisMonth / monthlyTokensLimit) * 100)
      : null;


    const knowledgeBots = bots.filter((b) => !!b.knowledgeClientId);

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

    // Global per-day split maps
    const baseTokensDaily = new Map<string, number>(); // OpenAI + Knowledge
    const emailTokensDaily = new Map<string, number>(); // email virtual tokens
    const whatsappTokensDaily = new Map<string, number>(); // WA template virtual tokens

    const bumpDay = (
      map: Map<string, number>,
      day: string,
      amount: number
    ) => {
      map.set(day, (map.get(day) || 0) + amount);
    };

    // NEW: per-bot totals by channel over the last 10 days
    type TokenByBotTotals = {
      openAiTokens: number;
      emailTokens: number;
      whatsappTokens: number;
    };
    const tokensByBot = new Map<string, TokenByBotTotals>();

    const ensureBotTotals = (botId: string): TokenByBotTotals => {
      let entry = tokensByBot.get(botId);
      if (!entry) {
        entry = { openAiTokens: 0, emailTokens: 0, whatsappTokens: 0 };
        tokensByBot.set(botId, entry);
      }
      return entry;
    };

    openAiUsageLast10.forEach((u) => {
      const botId = u.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(u.createdAt));
      const key = `${dayKey}|${botId}`;
      tokensDailyMap.set(key, (tokensDailyMap.get(key) || 0) + u.totalTokens);

      // base tokens (OpenAI + Knowledge)
      bumpDay(baseTokensDaily, dayKey, u.totalTokens);

      // per-bot OpenAI tokens
      ensureBotTotals(botId).openAiTokens += u.totalTokens;
    });

    // 2) Knowledge tokens (ingest+search), fetched per day
    await Promise.all(
      knowledgeBots.flatMap((b) => {
        const clientId = b.knowledgeClientId as string;

        return dateStarts.map(async (dayStart) => {
          const dayEnd = addDays(dayStart, 1);
          const dayKey = toDayString(dayStart);

          try {
            const summary = await fetchKnowledgeUsageForClient({
              clientId,
              from: dayStart,
              to: dayEnd
            });

            const crawlerTokens = computeCrawlerTokens(summary).totalTokens;
            if (crawlerTokens > 0) {
              const key = `${dayKey}|${b.id}`;
              tokensDailyMap.set(
                key,
                (tokensDailyMap.get(key) || 0) + crawlerTokens
              );

              // base tokens (OpenAI + Knowledge)
              bumpDay(baseTokensDaily, dayKey, crawlerTokens);

              // per-bot OpenAI+knowledge tokens
              ensureBotTotals(b.id).openAiTokens += crawlerTokens;
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

    // 3) Email + WA lead template tokens last 10 days
    const dayWindowEnd = addDays(today, 1);

    const [emailUsageLast10, waLeadsLast10] = await Promise.all([
      prisma.emailUsage.findMany({
        where: {
          botId: { in: botIds },
          createdAt: { gte: tenDaysAgo, lt: dayWindowEnd }
        },
        select: {
          botId: true,
          createdAt: true
        }
      }),
      prisma.metaLead.findMany({
        where: {
          botId: { in: botIds },
          whatsappStatus: "SENT",
          createdAt: { gte: tenDaysAgo, lt: dayWindowEnd }
        },
        select: {
          botId: true,
          createdAt: true
        }
      })
    ]);

    emailUsageLast10.forEach((e) => {
      const botId = e.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(e.createdAt));
      const key = `${dayKey}|${botId}`;
      tokensDailyMap.set(
        key,
        (tokensDailyMap.get(key) || 0) + EMAIL_TOKEN_COST
      );

      bumpDay(emailTokensDaily, dayKey, EMAIL_TOKEN_COST);

      // per-bot email tokens
      ensureBotTotals(botId).emailTokens += EMAIL_TOKEN_COST;
    });

    waLeadsLast10.forEach((lead) => {
      const botId = lead.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(lead.createdAt));
      const key = `${dayKey}|${botId}`;
      tokensDailyMap.set(
        key,
        (tokensDailyMap.get(key) || 0) + WHATSAPP_MESSAGE_TOKEN_COST
      );

      bumpDay(whatsappTokensDaily, dayKey, WHATSAPP_MESSAGE_TOKEN_COST);

      // per-bot WA tokens
      ensureBotTotals(botId).whatsappTokens += WHATSAPP_MESSAGE_TOKEN_COST;
    });

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

    const tokensLast10Days = {
      dates,
      series: tokensSeries
    };

    // Per-day breakdown by channel
    const tokenBreakdownLast10Days = {
      dates,
      openAiTokens: dates.map((d) => baseTokensDaily.get(d) || 0),
      emailTokens: dates.map((d) => emailTokensDaily.get(d) || 0),
      whatsappTokens: dates.map((d) => whatsappTokensDaily.get(d) || 0)
    };

    // NEW: per-bot breakdown by channel over last 10 days (aggregated)
    const tokenBreakdownByBotLast10Days = Array.from(
      tokensByBot.entries()
    ).map(([botId, totals]) => {
      const botMeta = botMap.get(botId);
      return {
        botId,
        botName: botMeta?.name ?? "Unknown bot",
        openAiTokens: totals.openAiTokens,
        emailTokens: totals.emailTokens,
        whatsappTokens: totals.whatsappTokens
      };
    });

    // Sort bots by total plan tokens desc (more active first)
    tokenBreakdownByBotLast10Days.sort((a, b) => {
      const totalA = a.openAiTokens + a.emailTokens + a.whatsappTokens;
      const totalB = b.openAiTokens + b.emailTokens + b.whatsappTokens;
      return totalB - totalA;
    });

    // ----- Top bots by conversations in last 30 days -----
    const botConversationCounts = new Map<
      string,
      { count: number; lastConversationAt: Date | null }
    >();

    conversationsLast30.forEach((c) => {
      const entry =
        botConversationCounts.get(c.botId) || {
          count: 0,
          lastConversationAt: null
        };

      entry.count += 1;
      if (
        !entry.lastConversationAt ||
        entry.lastConversationAt < c.lastMessageAt
      ) {
        entry.lastConversationAt = c.lastMessageAt;
      }

      botConversationCounts.set(c.botId, entry);
    });

    const topBotsByConversationsLast30Days = Array.from(
      botConversationCounts.entries()
    )
      .map(([botId, info]) => {
        const bot = botMap.get(botId);
        return {
          botId,
          botName: bot?.name ?? "Unknown bot",
          conversationCount: info.count,
          lastConversationAt: info.lastConversationAt
            ? info.lastConversationAt.toISOString()
            : null
        };
      })
      .sort((a, b) => b.conversationCount - a.conversationCount)
      .slice(0, 10);

    // Alias for clarity in KPIs
    const totalWhatsappLeadsThisMonth = totalLeadTemplatesThisMonth;

    const kpis = {
      totalBots,
      activeBots,
      totalConversationsLast30Days,
      totalTokensThisMonth,
      monthlyTokensLimit,
      tokensUsagePercent,
      totalEmailsThisMonth,
      monthlyEmailsLimit,
      emailsUsagePercent,
      totalWhatsappLeadsThisMonth
    };

     res.json({
      kpis,
      conversationsLast10Days: {
        dates,
        series: conversationsSeries
      },
      tokensLast10Days,
      tokenBreakdownLast10Days,
      tokenBreakdownByBotLast10Days,
      topBotsByConversationsLast30Days
    });
  }
);

/**
 * GET /api/dashboard/overview-range?days=30
 * Same payload as /overview but with a variable day window for charts.
 * KPIs are calculated for the selected range.
 */
router.get(
  "/dashboard/overview-range",
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const rangeDays = parseRangeDays(req, 10);

    const now = new Date();
    const today = startOfDay(now);
    const rangeStart = subDays(today, rangeDays - 1);
    const monthStart = startOfMonth(now);
    const windowStart = rangeStart < monthStart ? rangeStart : monthStart;

    type BotLite = {
      id: string;
      name: string;
      status: string;
      knowledgeClientId: string | null;
    };

    const [bots, conversationsInRange, openAiUsageSinceWindowStart] =
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
            lastMessageAt: { gte: rangeStart }
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

    const [subscriptions, totalEmailsInRange, totalLeadTemplatesInRange] =
      await Promise.all([
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
            createdAt: { gte: rangeStart, lt: addDays(today, 1) }
          }
        }),
        prisma.metaLead.count({
          where: {
            botId: { in: botIds },
            whatsappStatus: "SENT",
            createdAt: { gte: rangeStart, lt: addDays(today, 1) }
          }
        })
      ]);

    const planSnapshots = await Promise.all(
      botIds.map((botId) => getPlanUsageForBot(botId))
    );

    const planUsageByBot = new Map<
      string,
      { monthlyTokenLimit: number | null; usedTokensTotal: number }
    >();

    for (const snap of planSnapshots) {
      if (!snap) continue;
      planUsageByBot.set(snap.botId, {
        monthlyTokenLimit: snap.monthlyTokenLimit,
        usedTokensTotal: snap.usedTokensTotal
      });
    }

    const totalBots = bots.length;
    const activeBots = bots.filter((b) => b.status === "ACTIVE").length;
    const totalConversationsLast30Days = conversationsInRange.length;

    const allowedStatuses = new Set(["ACTIVE", "TRIALING", "PAST_DUE"]);

    let totalTokensThisMonth = 0;
    let monthlyTokensLimit: number | null = 0;
    let monthlyEmailsLimit: number | null = 0;

    for (const bot of bots) {
      const snap = planUsageByBot.get(bot.id);
      if (snap) {
        totalTokensThisMonth += snap.usedTokensTotal;
      }

      const sub = subscriptions.find((s) => s.botId === bot.id);
      if (!sub) continue;
      if (!allowedStatuses.has(sub.status)) continue;
      const plan = sub.usagePlan;
      if (!plan) continue;

      if (monthlyTokensLimit !== null) {
        const limitForBot =
          (snap && snap.monthlyTokenLimit != null
            ? snap.monthlyTokenLimit
            : plan.monthlyTokens) ?? null;

        if (limitForBot == null) {
          monthlyTokensLimit = null;
        } else {
          monthlyTokensLimit += limitForBot;
        }
      }

      if (monthlyEmailsLimit !== null) {
        if (plan.monthlyEmails == null) monthlyEmailsLimit = null;
        else monthlyEmailsLimit += plan.monthlyEmails;
      }
    }

    const knowledgeBotsForRange = bots
      .filter((b) => b.knowledgeClientId)
      .map((b) => ({ id: b.id, knowledgeClientId: b.knowledgeClientId }));

    totalTokensThisMonth = await sumTokensForRange(
      botIds,
      rangeStart,
      today,
      knowledgeBotsForRange
    );

    const daysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0
    ).getDate();
    const tokensLimitForRange =
      monthlyTokensLimit == null
        ? null
        : (monthlyTokensLimit * rangeDays) / daysInMonth;
    const emailsLimitForRange =
      monthlyEmailsLimit == null
        ? null
        : (monthlyEmailsLimit * rangeDays) / daysInMonth;

    const tokensUsagePercent =
      tokensLimitForRange && tokensLimitForRange > 0
        ? Math.min(100, (totalTokensThisMonth / tokensLimitForRange) * 100)
        : null;

    const emailsUsagePercent =
      emailsLimitForRange && emailsLimitForRange > 0
        ? (totalEmailsInRange / emailsLimitForRange) * 100
        : null;

    const toDayString = (d: Date): string => d.toISOString().slice(0, 10);

    const dates: string[] = [];
    const dateStarts: Date[] = [];
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = startOfDay(subDays(today, i));
      dateStarts.push(d);
      dates.push(toDayString(d));
    }

    const convDailyMap = new Map<string, number>();
    conversationsInRange.forEach((c) => {
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

    const openAiUsageInRange = openAiUsageSinceWindowStart.filter(
      (u) => u.createdAt >= rangeStart
    );

    const tokensDailyMap = new Map<string, number>();
    const baseTokensDaily = new Map<string, number>();
    const emailTokensDaily = new Map<string, number>();
    const whatsappTokensDaily = new Map<string, number>();

    const bumpDay = (map: Map<string, number>, day: string, amount: number) => {
      map.set(day, (map.get(day) || 0) + amount);
    };

    type TokenByBotTotals = {
      openAiTokens: number;
      emailTokens: number;
      whatsappTokens: number;
    };
    const tokensByBot = new Map<string, TokenByBotTotals>();

    const ensureBotTotals = (botId: string): TokenByBotTotals => {
      let entry = tokensByBot.get(botId);
      if (!entry) {
        entry = { openAiTokens: 0, emailTokens: 0, whatsappTokens: 0 };
        tokensByBot.set(botId, entry);
      }
      return entry;
    };

    openAiUsageInRange.forEach((u) => {
      const botId = u.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(u.createdAt));
      const key = `${dayKey}|${botId}`;
      tokensDailyMap.set(key, (tokensDailyMap.get(key) || 0) + u.totalTokens);

      bumpDay(baseTokensDaily, dayKey, u.totalTokens);
      ensureBotTotals(botId).openAiTokens += u.totalTokens;
    });

    await Promise.all(
      knowledgeBotsForRange.flatMap((b) => {
        const clientId = b.knowledgeClientId as string;

        return dateStarts.map(async (dayStart) => {
          const dayEnd = addDays(dayStart, 1);
          const dayKey = toDayString(dayStart);

          try {
            const summary = await fetchKnowledgeUsageForClient({
              clientId,
              from: dayStart,
              to: dayEnd
            });

            const crawlerTokens = computeCrawlerTokens(summary).totalTokens;
            if (crawlerTokens > 0) {
              const key = `${dayKey}|${b.id}`;
              tokensDailyMap.set(
                key,
                (tokensDailyMap.get(key) || 0) + crawlerTokens
              );

              bumpDay(baseTokensDaily, dayKey, crawlerTokens);
              ensureBotTotals(b.id).openAiTokens += crawlerTokens;
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

    const dayWindowEnd = addDays(today, 1);

    const [emailUsageInRange, waLeadsInRange] = await Promise.all([
      prisma.emailUsage.findMany({
        where: {
          botId: { in: botIds },
          createdAt: { gte: rangeStart, lt: dayWindowEnd }
        },
        select: {
          botId: true,
          createdAt: true
        }
      }),
      prisma.metaLead.findMany({
        where: {
          botId: { in: botIds },
          whatsappStatus: "SENT",
          createdAt: { gte: rangeStart, lt: dayWindowEnd }
        },
        select: {
          botId: true,
          createdAt: true
        }
      })
    ]);

    emailUsageInRange.forEach((e) => {
      const botId = e.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(e.createdAt));
      const key = `${dayKey}|${botId}`;
      tokensDailyMap.set(
        key,
        (tokensDailyMap.get(key) || 0) + EMAIL_TOKEN_COST
      );

      bumpDay(emailTokensDaily, dayKey, EMAIL_TOKEN_COST);
      ensureBotTotals(botId).emailTokens += EMAIL_TOKEN_COST;
    });

    waLeadsInRange.forEach((lead) => {
      const botId = lead.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(lead.createdAt));
      const key = `${dayKey}|${botId}`;
      tokensDailyMap.set(
        key,
        (tokensDailyMap.get(key) || 0) + WHATSAPP_MESSAGE_TOKEN_COST
      );

      bumpDay(whatsappTokensDaily, dayKey, WHATSAPP_MESSAGE_TOKEN_COST);
      ensureBotTotals(botId).whatsappTokens += WHATSAPP_MESSAGE_TOKEN_COST;
    });

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

    const tokenBreakdownLast10Days = {
      dates,
      openAiTokens: dates.map((d) => baseTokensDaily.get(d) || 0),
      emailTokens: dates.map((d) => emailTokensDaily.get(d) || 0),
      whatsappTokens: dates.map((d) => whatsappTokensDaily.get(d) || 0)
    };

    const tokenBreakdownByBotLast10Days = Array.from(
      tokensByBot.entries()
    ).map(([botId, totals]) => {
      const botMeta = bots.find((b) => b.id === botId);
      return {
        botId,
        botName: botMeta?.name ?? "Unknown bot",
        openAiTokens: totals.openAiTokens,
        emailTokens: totals.emailTokens,
        whatsappTokens: totals.whatsappTokens
      };
    });

    tokenBreakdownByBotLast10Days.sort((a, b) => {
      const totalA = a.openAiTokens + a.emailTokens + a.whatsappTokens;
      const totalB = b.openAiTokens + b.emailTokens + b.whatsappTokens;
      return totalB - totalA;
    });

    const botConversationCounts = new Map<
      string,
      { count: number; lastConversationAt: Date | null }
    >();

    conversationsInRange.forEach((c) => {
      const entry =
        botConversationCounts.get(c.botId) || {
          count: 0,
          lastConversationAt: null
        };

      entry.count += 1;
      if (!entry.lastConversationAt || entry.lastConversationAt < c.lastMessageAt) {
        entry.lastConversationAt = c.lastMessageAt;
      }

      botConversationCounts.set(c.botId, entry);
    });

    const topBotsByConversationsLast30Days = Array.from(
      botConversationCounts.entries()
    )
      .map(([botId, info]) => {
        const bot = bots.find((b) => b.id === botId);
        return {
          botId,
          botName: bot?.name ?? "Unknown bot",
          conversationCount: info.count,
          lastConversationAt: info.lastConversationAt
            ? info.lastConversationAt.toISOString()
            : null
        };
      })
      .sort((a, b) => b.conversationCount - a.conversationCount)
      .slice(0, 10);

    const kpis = {
      totalBots,
      activeBots,
      totalConversationsLast30Days,
      totalTokensThisMonth,
      monthlyTokensLimit,
      tokensUsagePercent,
      totalEmailsThisMonth: totalEmailsInRange,
      monthlyEmailsLimit,
      emailsUsagePercent,
      totalWhatsappLeadsThisMonth: totalLeadTemplatesInRange
    };

    res.json({
      rangeDays,
      rangeStart: rangeStart.toISOString(),
      rangeEnd: today.toISOString(),
      kpis,
      conversationsLast10Days: { dates, series: conversationsSeries },
      tokensLast10Days: { dates, series: tokensSeries },
      tokenBreakdownLast10Days,
      tokenBreakdownByBotLast10Days,
      topBotsByConversationsLast30Days
    });
  }
);

/**
 * GET /api/dashboard/channel-breakdown?days=10
 * Totals by channel for the given time window.
 */
router.get(
  "/dashboard/channel-breakdown",
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const days = parseRangeDays(req, 10);

    const now = new Date();
    const today = startOfDay(now);
    const rangeStart = subDays(today, days - 1);

    const bots = await prisma.bot.findMany({
      where: { userId },
      select: { id: true, knowledgeClientId: true }
    });
    const botIds = bots.map((b) => b.id);

    const openAi = await prisma.openAIUsage.aggregate({
      where: {
        botId: { in: botIds },
        createdAt: { gte: rangeStart, lt: addDays(today, 1) }
      },
      _sum: { totalTokens: true }
    });
    const openAiTokens = openAi._sum.totalTokens || 0;

    let knowledgeTokens = 0;
    await Promise.all(
      bots
        .filter((b) => !!b.knowledgeClientId)
        .map(async (b) => {
          try {
            const summary = await fetchKnowledgeUsageForClient({
              clientId: b.knowledgeClientId as string,
              from: rangeStart,
              to: addDays(today, 1)
            });
            knowledgeTokens += computeCrawlerTokens(summary).totalTokens;
          } catch (err) {
            console.error("Failed to fetch knowledge usage for breakdown", b.id, err);
          }
        })
    );

    const emailCount = await prisma.emailUsage.count({
      where: {
        botId: { in: botIds },
        createdAt: { gte: rangeStart, lt: addDays(today, 1) }
      }
    });
    const whatsappLeadCount = await prisma.metaLead.count({
      where: {
        botId: { in: botIds },
        whatsappStatus: "SENT",
        createdAt: { gte: rangeStart, lt: addDays(today, 1) }
      }
    });

    const emailTokens = emailCount * EMAIL_TOKEN_COST;
    const whatsappTokens = whatsappLeadCount * WHATSAPP_MESSAGE_TOKEN_COST;
    const totalTokens = openAiTokens + knowledgeTokens + emailTokens + whatsappTokens;

    res.json({
      rangeDays: days,
      totals: {
        openAiTokens: openAiTokens + knowledgeTokens,
        emailTokens,
        whatsappTokens,
        totalTokens,
        emailCount,
        whatsappLeadCount
      }
    });
  }
);

/**
 * GET /api/dashboard/bots-health
 * High-level health indicators for each bot.
 */
router.get(
  "/dashboard/bots-health",
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const today = startOfDay(new Date());
    const thirtyDaysAgo = subDays(today, 29);

    const bots = await prisma.bot.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        status: true,
        knowledgeClientId: true,
        useCalendar: true,
        channelWeb: true,
        channelWhatsapp: true,
        channelInstagram: true,
        channelMessenger: true
      }
    });

    const botIds = bots.map((b) => b.id);

    const [convoCounts, lastConversations, channels] = await Promise.all([
      prisma.conversation.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds }, lastMessageAt: { gte: thirtyDaysAgo } },
        _count: { _all: true }
      }),
      prisma.conversation.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds } },
        _max: { lastMessageAt: true }
      }),
      prisma.botChannel.findMany({
        where: { botId: { in: botIds } },
        select: { botId: true, type: true }
      })
    ]);

    const convoCountMap = new Map<string, number>();
    convoCounts.forEach((c) => {
      convoCountMap.set(c.botId, c._count._all);
    });

    const lastConvoMap = new Map<string, Date | null>();
    lastConversations.forEach((c) => {
      lastConvoMap.set(c.botId, c._max.lastMessageAt || null);
    });

    const channelMap = new Map<
      string,
      { WEB: number; WHATSAPP: number; FACEBOOK: number; INSTAGRAM: number }
    >();
    channels.forEach((c) => {
      if (!channelMap.has(c.botId)) {
        channelMap.set(c.botId, {
          WEB: 0,
          WHATSAPP: 0,
          FACEBOOK: 0,
          INSTAGRAM: 0
        });
      }
      const entry = channelMap.get(c.botId)!;
      entry[c.type] += 1;
    });

    const items = bots.map((b) => {
      const counts = channelMap.get(b.id) || {
        WEB: 0,
        WHATSAPP: 0,
        FACEBOOK: 0,
        INSTAGRAM: 0
      };
      const totalChannels =
        counts.WEB + counts.WHATSAPP + counts.FACEBOOK + counts.INSTAGRAM;

      const lastConversationAt = lastConvoMap.get(b.id) || null;
      const conversationsLast30Days = convoCountMap.get(b.id) || 0;

      let score = 100;
      if (b.status !== "ACTIVE") score -= 30;
      if (totalChannels === 0) score -= 25;
      if (!b.knowledgeClientId) score -= 10;
      if (!b.useCalendar) score -= 10;
      if (
        lastConversationAt &&
        differenceInCalendarDays(today, lastConversationAt) > 30
      ) {
        score -= 20;
      }
      score = Math.max(0, Math.min(100, score));

      return {
        botId: b.id,
        botName: b.name,
        status: b.status,
        healthScore: score,
        lastConversationAt: lastConversationAt
          ? lastConversationAt.toISOString()
          : null,
        conversationsLast30Days,
        channels: {
          web: counts.WEB > 0 || b.channelWeb,
          whatsapp: counts.WHATSAPP > 0 || b.channelWhatsapp,
          facebook: counts.FACEBOOK > 0 || b.channelMessenger,
          instagram: counts.INSTAGRAM > 0 || b.channelInstagram
        },
        knowledgeEnabled: !!b.knowledgeClientId,
        calendarEnabled: !!b.useCalendar
      };
    });

    res.json({ items });
  }
);

/**
 * GET /api/dashboard/conversion?days=30
 * Conversations -> leads -> bookings funnel.
 */
router.get(
  "/dashboard/conversion",
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const days = parseRangeDays(req, 30);

    const today = startOfDay(new Date());
    const rangeStart = subDays(today, days - 1);

    const bots = await prisma.bot.findMany({
      where: { userId },
      select: { id: true, name: true }
    });
    const botIds = bots.map((b) => b.id);

    const [convCounts, leadCounts, bookingCounts] = await Promise.all([
      prisma.conversation.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds }, lastMessageAt: { gte: rangeStart } },
        _count: { _all: true }
      }),
      prisma.metaLead.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds }, createdAt: { gte: rangeStart } },
        _count: { _all: true }
      }),
      prisma.booking.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds }, createdAt: { gte: rangeStart } },
        _count: { _all: true }
      })
    ]);

    const convMap = new Map<string, number>();
    convCounts.forEach((c) => convMap.set(c.botId, c._count._all));
    const leadMap = new Map<string, number>();
    leadCounts.forEach((c) => leadMap.set(c.botId, c._count._all));
    const bookingMap = new Map<string, number>();
    bookingCounts.forEach((c) => bookingMap.set(c.botId, c._count._all));

    const perBot = bots.map((b) => {
      const conversations = convMap.get(b.id) || 0;
      const leads = leadMap.get(b.id) || 0;
      const bookings = bookingMap.get(b.id) || 0;
      const leadRate = conversations > 0 ? (leads / conversations) * 100 : 0;
      const bookingDenom = leads > 0 ? leads : conversations;
      const bookingRate = bookingDenom > 0 ? (bookings / bookingDenom) * 100 : 0;
      return {
        botId: b.id,
        botName: b.name,
        conversations,
        leads,
        bookings,
        leadRate,
        bookingRate
      };
    });

    const totals = perBot.reduce(
      (acc, row) => {
        acc.conversations += row.conversations;
        acc.leads += row.leads;
        acc.bookings += row.bookings;
        return acc;
      },
      { conversations: 0, leads: 0, bookings: 0 }
    );

    const leadRate =
      totals.conversations > 0 ? (totals.leads / totals.conversations) * 100 : 0;
    const bookingDenom = totals.leads > 0 ? totals.leads : totals.conversations;
    const bookingRate = bookingDenom > 0 ? (totals.bookings / bookingDenom) * 100 : 0;

    res.json({
      rangeDays: days,
      totals: {
        ...totals,
        leadRate,
        bookingRate
      },
      perBot
    });
  }
);

export default router;
