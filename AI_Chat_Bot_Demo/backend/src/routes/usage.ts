// routes/usage.ts

import { Router, Request, Response } from "express";
import { prisma } from "../prisma/prisma";
import { getUsageForBot } from "../services/usageAggregationService";

const router = Router();

function parseDateParam(
  value: unknown,
  fieldName: string,
  res: Response
): Date | undefined | null {
  if (!value) return null;
  const s = String(value);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    res
      .status(400)
      .json({ error: `Invalid date format for "${fieldName}". Use ISO8601.` });
    return undefined;
  }
  return d;
}

function computeDateRange(
  req: Request,
  res: Response
): { from: Date | null; to: Date | null } | null {
  const fromParam = req.query.from;
  const toParam = req.query.to;
  const period = (req.query.period as string | undefined)?.toLowerCase();

  let from: Date | null = null;
  let to: Date | null = null;

  if (fromParam) {
    const d = parseDateParam(fromParam, "from", res);
    if (d === undefined) return null;
    from = d;
  }

  if (toParam) {
    const d = parseDateParam(toParam, "to", res);
    if (d === undefined) return null;
    to = d;
  }

  if (!from && !to && period === "month") {
    const now = new Date();
    const startOfMonthUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)
    );
    from = startOfMonthUtc;
    to = now;
  }

  return { from, to };
}

// GET /api/usage/bots
// Optional query:
// - userId: filter bots belonging to a specific owner
// - limit: max number of bots (default 100)
// - from / to: date filters
// - period=month: current month (if from/to omitted)
router.get("/usage/bots", async (req: Request, res: Response) => {
  try {
    const range = computeDateRange(req, res);
    if (!range) return;
    const { from, to } = range;

    const limitRaw = req.query.limit as string | undefined;
    let limit = 100;
    if (limitRaw) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 1000);
      }
    }

    const userId = req.query.userId as string | undefined;

    const where: any = {};
    if (userId) {
      where.userId = userId;
    }

    const bots = await prisma.bot.findMany({
      where,
      include: { user: true },
      take: limit
    });

    const usages = await Promise.all(
      bots.map((bot) => getUsageForBot({ bot, from, to }))
    );

    // Sort by totalTokens desc for convenience
    usages.sort((a, b) => b.totalTokens - a.totalTokens);

    return res.json({
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      bots: usages
    });
  } catch (err) {
    console.error("Error in /api/usage/bots:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/usage/users
// Aggregates per owner (User), across all their bots.
//
// Optional query:
// - limit: max number of users (default 100)
// - from / to: date filters
// - period=month
router.get("/usage/users", async (req: Request, res: Response) => {
  try {
    const range = computeDateRange(req, res);
    if (!range) return;
    const { from, to } = range;

    const limitRaw = req.query.limit as string | undefined;
    let limit = 100;
    if (limitRaw) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 1000);
      }
    }

    // We want all bots with their users to aggregate by user
    const bots = await prisma.bot.findMany({
      include: { user: true }
    });

    const botUsages = await Promise.all(
      bots.map((bot) => getUsageForBot({ bot, from, to }))
    );

    type UserUsage = {
      userId: string;
      userEmail: string | null;
      trainingTokens: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };

    const userMap = new Map<string, UserUsage>();

    for (const bu of botUsages) {
      const key = bu.userId;
      const existing = userMap.get(key) ?? {
        userId: bu.userId,
        userEmail: bu.userEmail,
        trainingTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      };

      existing.trainingTokens += bu.trainingTokens;
      existing.inputTokens += bu.inputTokens;
      existing.outputTokens += bu.outputTokens;
      existing.totalTokens += bu.totalTokens;

      userMap.set(key, existing);
    }

    let users = Array.from(userMap.values());
    // Sort by totalTokens desc
    users.sort((a, b) => b.totalTokens - a.totalTokens);
    // Apply limit
    users = users.slice(0, limit);

    return res.json({
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      users
    });
  } catch (err) {
    console.error("Error in /api/usage/users:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
