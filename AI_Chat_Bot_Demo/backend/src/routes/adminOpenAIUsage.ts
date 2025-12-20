// routes/adminOpenAIUsage.ts

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { monthKeyForDate } from "../services/referralService";

const router = Router();

/* =========================
   Helpers
   ========================= */

const monthKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "month must be in YYYY-MM format");

function monthStartUtc(monthKey: string): Date {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
}

function nextMonthStartUtc(monthKey: string): Date {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
}

function parseMonthParam(raw: unknown): string {
  if (typeof raw === "string" && monthKeySchema.safeParse(raw).success) {
    return raw;
  }
  return monthKeyForDate(new Date());
}

function normalizeNumberParam(
  raw: unknown,
  fallback: number,
  opts: { min?: number; max?: number } = {}
): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  let out = Number.isFinite(n) ? n : fallback;

  if (typeof opts.min === "number" && out < opts.min) out = opts.min;
  if (typeof opts.max === "number" && out > opts.max) out = opts.max;

  return out;
}

/**
 * Shapes that roughly match Prisma.groupBy outputs.
 * We avoid importing Prisma types to keep things simple
 * with strict TS config.
 */
type UsageByBotRow = {
  botId: string | null;
  _sum: {
    totalTokens: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
  };
  _count: {
    _all: number;
  };
};

type UsageByModelRow = {
  model: string;
  _sum: {
    totalTokens: number | null;
  };
  _count: {
    _all: number;
  };
};

type UsageByUserRow = {
  userId: string | null;
  _sum: {
    totalTokens: number | null;
  };
  _count: {
    _all: number;
  };
};

/* =========================
   GET /api/admin/openai-usage
   ========================= */

/**
 * ✅ Admin OpenAI usage dashboard
 *
 * Query params:
 * - month: YYYY-MM (defaults to current UTC month)
 * - q: text filter on bot name / slug / owner email
 * - model: exact model id (e.g. "gpt-4o-mini")
 * - take: page size for bot list (1–200, default 50)
 * - skip: offset for bot list (0+, default 0)
 *
 * Response shape:
 * {
 *   monthKey,
 *   window: { from, to },
 *   filters: { q, model },
 *   paging: { take, skip, total, hasMore },
 *   bots: [
 *     {
 *       botId, slug, name, status,
 *       owner: { id, email, name },
 *       plan: { id, code, name, monthlyTokens } | null,
 *       monthTokens: { totalTokens, promptTokens, completionTokens, requests },
 *       createdAt
 *     }
 *   ],
 *   global: {
 *     totalTokens,
 *     requestCount,
 *     byModel: [{ model, totalTokens, requestCount }],
 *     topUsers: [{ userId, email, name, totalTokens, requestCount }]
 *   }
 * }
 */
router.get(
  "/admin/openai-usage",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const monthKey = parseMonthParam(req.query.month);
    const from = monthStartUtc(monthKey);
    const to = nextMonthStartUtc(monthKey);

    const rawQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const q = rawQ.length > 0 ? rawQ : null;

    const rawModel =
      typeof req.query.model === "string" ? req.query.model.trim() : "";
    const model = rawModel.length > 0 ? rawModel : null;

    const take = normalizeNumberParam(req.query.take, 50, {
      min: 1,
      max: 200
    });
    const skip = normalizeNumberParam(req.query.skip, 0, {
      min: 0,
      max: 100_000
    });

    const botWhere: Record<string, unknown> = {};

    if (q) {
      botWhere.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { slug: { contains: q, mode: "insensitive" } },
        {
          user: {
            email: { contains: q, mode: "insensitive" }
          }
        }
      ];
    }

    // Fetch a page of bots (with owner + plan info)
    const [totalBots, bots] = await Promise.all([
      prisma.bot.count({ where: botWhere }),
      prisma.bot.findMany({
        where: botWhere,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: {
          user: true,
          subscription: {
            include: { usagePlan: true }
          }
        }
      })
    ]);

    const botIds = bots.map((b) => b.id);

    const baseUsageWhere: Record<string, unknown> = {
      createdAt: { gte: from, lt: to }
    };
    if (model) {
      baseUsageWhere.model = model;
    }

    const usageByBotPromise: Promise<UsageByBotRow[]> = botIds.length
      ? (prisma.openAIUsage.groupBy({
          by: ["botId"],
          where: {
            ...baseUsageWhere,
            botId: { in: botIds }
          },
          _sum: {
            totalTokens: true,
            promptTokens: true,
            completionTokens: true
          },
          _count: { _all: true }
        }) as unknown as Promise<UsageByBotRow[]>)
      : Promise.resolve([]);

    const usageByModelPromise: Promise<UsageByModelRow[]> =
      prisma.openAIUsage.groupBy({
        by: ["model"],
        where: baseUsageWhere,
        _sum: { totalTokens: true },
        _count: { _all: true }
      }) as unknown as Promise<UsageByModelRow[]>;

    const usageByUserPromise: Promise<UsageByUserRow[]> =
      prisma.openAIUsage.groupBy({
        by: ["userId"],
        where: {
          ...baseUsageWhere,
          userId: { not: null }
        },
        _sum: { totalTokens: true },
        _count: { _all: true }
      }) as unknown as Promise<UsageByUserRow[]>;

    const [usageByBot, usageByModelRaw, usageByUserRaw] = await Promise.all([
      usageByBotPromise,
      usageByModelPromise,
      usageByUserPromise
    ]);

    const usageByBotMap = new Map<string, UsageByBotRow>();
    for (const row of usageByBot) {
      if (row.botId) {
        usageByBotMap.set(row.botId, row);
      }
    }

    const byModel = usageByModelRaw
      .map((row) => ({
        model: row.model,
        totalTokens: row._sum.totalTokens ?? 0,
        requestCount: row._count._all ?? 0
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const usageByUserSorted = usageByUserRaw
      .filter((row) => !!row.userId)
      .map((row) => ({
        userId: row.userId as string,
        totalTokens: row._sum.totalTokens ?? 0,
        requestCount: row._count._all ?? 0
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const topUserUsage = usageByUserSorted.slice(0, 50);
    const topUserIds = topUserUsage.map((u) => u.userId);

    const users = topUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: topUserIds } }
        })
      : [];

    const userMap = new Map(users.map((u) => [u.id, u]));

    const topUsers = topUserUsage.map((u) => {
      const user = userMap.get(u.userId);
      return {
        userId: u.userId,
        email: user?.email ?? "",
        name: user?.name ?? null,
        totalTokens: u.totalTokens,
        requestCount: u.requestCount
      };
    });

    const totalTokensGlobal = byModel.reduce(
      (sum, m) => sum + m.totalTokens,
      0
    );
    const totalRequestsGlobal = byModel.reduce(
      (sum, m) => sum + m.requestCount,
      0
    );

    const botRows = bots.map((bot) => {
      const agg = usageByBotMap.get(bot.id);
      const totalTokens = agg?.[ "_sum" ]?.totalTokens ?? 0;
      const promptTokens = agg?.[ "_sum" ]?.promptTokens ?? 0;
      const completionTokens = agg?.[ "_sum" ]?.completionTokens ?? 0;
      const requests = agg?._count?._all ?? 0;

      return {
        botId: bot.id,
        slug: bot.slug,
        name: bot.name,
        status: bot.status,
        owner: {
          id: bot.userId,
          email: bot.user.email,
          name: bot.user.name
        },
        plan: bot.subscription?.usagePlan
          ? {
              id: bot.subscription.usagePlan.id,
              code: bot.subscription.usagePlan.code,
              name: bot.subscription.usagePlan.name,
              monthlyTokens: bot.subscription.usagePlan.monthlyTokens
            }
          : null,
        monthTokens: {
          totalTokens,
          promptTokens,
          completionTokens,
          requests
        },
        createdAt: bot.createdAt
      };
    });

    return res.json({
      monthKey,
      window: {
        from: from.toISOString(),
        to: to.toISOString()
      },
      filters: {
        q,
        model: model ?? null
      },
      paging: {
        take,
        skip,
        total: totalBots,
        hasMore: skip + take < totalBots
      },
      bots: botRows,
      global: {
        totalTokens: totalTokensGlobal,
        requestCount: totalRequestsGlobal,
        byModel,
        topUsers
      }
    });
  }
);

export default router;
