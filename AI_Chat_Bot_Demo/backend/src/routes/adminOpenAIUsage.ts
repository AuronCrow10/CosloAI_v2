// routes/adminOpenAIUsage.ts

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import { monthKeyForDate } from "../services/referralService";
import {
  fetchKnowledgeUsageForClient,
  KnowledgeUsageSummary
} from "../services/knowledgeUsageService";

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
 * Given a knowledge usage summary, compute crawler training + search tokens.
 * We use totalTokens here because that's what you pay on.
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
 * Shapes that roughly match Prisma.groupBy outputs.
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

/* =========================
   GET /api/admin/openai-usage
   ========================= */

/**
 * ✅ Admin OpenAI + Crawler usage dashboard
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

    // Fetch a page of bots (with owner + plan info + knowledgeClientId)
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

    // ----- OpenAI aggregations -----
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

    const [usageByBot, usageByModelRaw] = await Promise.all([
      usageByBotPromise,
      usageByModelPromise
    ]);

    const usageByBotMap = new Map<string, UsageByBotRow>();
    for (const row of usageByBot) {
      if (row.botId) {
        usageByBotMap.set(row.botId, row);
      }
    }

    // OpenAI models only
    const byModelOpenAI = usageByModelRaw
      .map((row) => ({
        model: row.model,
        totalTokens: row._sum.totalTokens ?? 0,
        requestCount: row._count._all ?? 0
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    // ----- Knowledge usage ("Crawler") per bot -----
    const knowledgeUsageByBot: Record<string, number> = {};

    const botsWithKnowledge = bots.filter(
      (b) => b.knowledgeClientId != null
    ) as Array<(typeof bots)[number] & { knowledgeClientId: string }>;

    if (botsWithKnowledge.length > 0) {
      await Promise.all(
        botsWithKnowledge.map(async (bot) => {
          try {
            const summary = await fetchKnowledgeUsageForClient({
              clientId: bot.knowledgeClientId,
              from,
              to
            });

            const crawlerTokens = computeCrawlerTokens(summary).totalTokens;
            knowledgeUsageByBot[bot.id] = crawlerTokens;
          } catch (err) {
            console.error(
              "Failed to fetch knowledge usage for bot in admin openai-usage",
              bot.id,
              err
            );
            knowledgeUsageByBot[bot.id] = 0;
          }
        })
      );
    }

    // ----- Global totals (OpenAI + Crawler) -----
    const totalTokensOpenAI = byModelOpenAI.reduce(
      (sum, m) => sum + m.totalTokens,
      0
    );
    const totalRequestsGlobal = byModelOpenAI.reduce(
      (sum, m) => sum + m.requestCount,
      0
    );

    const totalTokensKnowledge = Object.values(knowledgeUsageByBot).reduce(
      (sum, v) => sum + v,
      0
    );
    const totalTokensGlobal = totalTokensOpenAI + totalTokensKnowledge;

    // Build combined model list including synthetic "Crawler" model
    const byModelCombined: {
      model: string;
      totalTokens: number;
      requestCount: number;
    }[] = [...byModelOpenAI];

    if (totalTokensKnowledge > 0) {
      byModelCombined.push({
        model: "Crawler",
        totalTokens: totalTokensKnowledge,
        requestCount: 0 // "requests" isn't meaningful for crawler at this level
      });
    }

    const byModel = byModelCombined.sort(
      (a, b) => b.totalTokens - a.totalTokens
    );

    // ----- Per-bot rows -----
    const botRows = bots.map((bot) => {
      const agg = usageByBotMap.get(bot.id);
      const totalTokensOpenAiBot = agg?._sum?.totalTokens ?? 0;
      const promptTokens = agg?._sum?.promptTokens ?? 0;
      const completionTokens = agg?._sum?.completionTokens ?? 0;
      const requests = agg?._count?._all ?? 0;

      const knowledgeTokens = knowledgeUsageByBot[bot.id] ?? 0;
      const totalTokensAll = totalTokensOpenAiBot + knowledgeTokens;

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
          totalTokens: totalTokensOpenAiBot,
          promptTokens,
          completionTokens,
          requests
        },
        knowledgeTokens,
        totalTokensAll,
        createdAt: bot.createdAt
      };
    });

    // ----- Top users (overall: OpenAI + Crawler) -----
    type UserAgg = {
      userId: string;
      email: string;
      name: string | null;
      totalTokens: number; // combined OpenAI + Crawler
      requestCount: number; // OpenAI requests
    };

    const userAggMap = new Map<string, UserAgg>();

    for (const row of botRows) {
      const userId = row.owner.id;
      const existing = userAggMap.get(userId);
      const combinedTokens = row.totalTokensAll;
      const requests = row.monthTokens.requests;

      if (existing) {
        existing.totalTokens += combinedTokens;
        existing.requestCount += requests;
      } else {
        userAggMap.set(userId, {
          userId,
          email: row.owner.email,
          name: row.owner.name,
          totalTokens: combinedTokens,
          requestCount: requests
        });
      }
    }

    const topUsers = Array.from(userAggMap.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 50);

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
        totalTokensOpenAI,
        totalTokensKnowledge,
        totalTokens: totalTokensGlobal,
        requestCount: totalRequestsGlobal,
        byModel,
        topUsers
      }
    });
  }
);

export default router;
