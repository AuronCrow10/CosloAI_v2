// src/routes/dashboard.ts
import { Router, Request, Response } from "express";
import { subDays, startOfDay, startOfMonth } from "date-fns";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";

const router = Router();

// Protect everything under /dashboard with auth
router.use("/dashboard", requireAuth);

/**
 * GET /api/dashboard/overview
 *
 * Returns:
 * - KPIs
 * - Conversations last 10 days per bot
 * - Tokens last 10 days per bot
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

    // 1) Load bots, conversations, and usage for this user
    const [bots, conversationsLast30, usageSinceMonthStart] = await Promise.all([
      prisma.bot.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          status: true
        }
      }),
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
          createdAt: { gte: monthStart }
        },
        select: {
          botId: true,
          totalTokens: true,
          createdAt: true
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
    const totalTokensThisMonth = usageSinceMonthStart.reduce(
      (sum, u) => sum + u.totalTokens,
      0
    );

    // Helper: format a date as YYYY-MM-DD
    const toDayString = (d: Date): string => d.toISOString().slice(0, 10);

    // Prebuild the last 10 days array (e.g. ["2025-12-01", ..., "2025-12-10"])
    const dates: string[] = [];
    for (let i = 9; i >= 0; i--) {
      dates.push(toDayString(subDays(today, i)));
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
    const usageLast10 = usageSinceMonthStart.filter(
      (u) => u.createdAt >= tenDaysAgo
    );

    const tokensDailyMap = new Map<string, number>(); // `${day}|${botId}` -> tokens

    usageLast10.forEach((u) => {
      const botId = u.botId;
      if (!botId) return;

      const dayKey = toDayString(startOfDay(u.createdAt));
      const key = `${dayKey}|${botId}`;
      tokensDailyMap.set(key, (tokensDailyMap.get(key) || 0) + u.totalTokens);
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
      if (!existing.lastConversationAt || c.lastMessageAt > existing.lastConversationAt) {
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
        totalTokensThisMonth
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
