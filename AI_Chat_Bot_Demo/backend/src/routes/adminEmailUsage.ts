// src/routes/adminEmailUsage.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const BOT_STATUS_VALUES = ["DRAFT", "PENDING_PAYMENT", "ACTIVE", "SUSPENDED", "CANCELED"] as const;
type BotStatus = (typeof BOT_STATUS_VALUES)[number];

function parsePositiveInt(value: unknown, defaultValue: number, max: number): number {
  if (typeof value !== "string") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(n, max);
}

type AdminEmailUsageBotItem = {
  botId: string;
  botName: string;
  botSlug: string;
  botStatus: BotStatus;
  botCreatedAt: string;

  owner: {
    id: string;
    email: string;
    name: string | null;
  };

  usagePlan: {
    id: string;
    code: string;
    name: string;
    monthlyEmails: number | null;
    monthlyAmountCents: number;
    currency: string;
  } | null;

  emailsThisMonth: number;
  monthlyEmailLimit: number | null;
  usageRatio: number | null; // 0–1 when limit is set
  isOverLimit: boolean;
};

type AdminEmailUsageSummaryByPlanItem = {
  usagePlanId: string | null;
  usagePlanCode: string | null;
  usagePlanName: string | null;
  monthlyEmails: number | null;
  botsCount: number;
  overLimitBotsCount: number;
  totalEmailsThisMonth: number;
};

type AdminEmailUsageListResponse = {
  items: AdminEmailUsageBotItem[];
  page: number;
  pageSize: number;
  total: number;
  monthStart: string;
  monthEndExclusive: string;
  summaryByPlan: AdminEmailUsageSummaryByPlanItem[];
};

/**
 * GET /api/admin/email-usage
 *
 * Email usage per bot for the **current calendar month**.
 *
 * Query params:
 *  - q?: string          (search in bot name / slug / owner email)
 *  - status?: BotStatus  (filter by bot.status)
 *  - planCode?: string   (filter by UsagePlan.code)
 *  - overLimitOnly?: "true" | "false"  (optional: hide bots under limit on this page)
 *  - page?: number       (1-based, default 1)
 *  - pageSize?: number   (default 20, max 100)
 */
router.get("/admin/email-usage", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { q, status, planCode, overLimitOnly } = req.query as {
      q?: string;
      status?: string;
      planCode?: string;
      overLimitOnly?: string;
      page?: string;
      pageSize?: string;
    };

    const page = parsePositiveInt(req.query.page, 1, 1000);
    const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);
    const skip = (page - 1) * pageSize;

    // Month boundaries (current calendar month in server time)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const where: any = {};

    if (status && BOT_STATUS_VALUES.includes(status as BotStatus)) {
      where.status = status;
    }

    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" as const } },
        { slug: { contains: term, mode: "insensitive" as const } },
        {
          user: {
            email: { contains: term, mode: "insensitive" as const }
          }
        }
      ];
    }

    if (planCode && planCode.trim()) {
      const trimmed = planCode.trim();
      where.subscription = {
        is: {
          usagePlan: {
            is: { code: trimmed }
          }
        }
      };
    }

    const [total, bots] = await Promise.all([
      prisma.bot.count({ where }),
      prisma.bot.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true
            }
          },
          subscription: {
            include: {
              usagePlan: true
            }
          }
        }
      })
    ]);

    if (bots.length === 0) {
      const emptyResponse: AdminEmailUsageListResponse = {
        items: [],
        page,
        pageSize,
        total,
        monthStart: monthStart.toISOString(),
        monthEndExclusive: monthEnd.toISOString(),
        summaryByPlan: []
      };
      return res.json(emptyResponse);
    }

    const botIds = bots.map((b) => b.id);

    const emailAgg = await prisma.emailUsage.groupBy({
      by: ["botId"],
      where: {
        botId: { in: botIds },
        createdAt: {
          gte: monthStart,
          lt: monthEnd
        }
      },
      _count: { _all: true }
    });

    const emailsByBotId = new Map<string, number>();
    for (const row of emailAgg) {
      if (!row.botId) continue;
      emailsByBotId.set(row.botId, row._count._all ?? 0);
    }

    const items: AdminEmailUsageBotItem[] = bots.map((b) => {
      const sub = b.subscription;
      const plan = sub?.usagePlan ?? null;

      const emailsThisMonth = emailsByBotId.get(b.id) ?? 0;
      const limit = plan?.monthlyEmails ?? null;

      let usageRatio: number | null = null;
      let isOverLimit = false;

      if (limit != null && limit > 0) {
        usageRatio = emailsThisMonth / limit;
        isOverLimit = emailsThisMonth > limit;
      }

      return {
        botId: b.id,
        botName: b.name,
        botSlug: b.slug,
        botStatus: b.status as BotStatus,
        botCreatedAt: b.createdAt.toISOString(),
        owner: {
          id: b.user.id,
          email: b.user.email,
          name: b.user.name ?? null
        },
        usagePlan: plan
          ? {
              id: plan.id,
              code: plan.code,
              name: plan.name,
              monthlyEmails: plan.monthlyEmails ?? null,
              monthlyAmountCents: plan.monthlyAmountCents,
              currency: plan.currency
            }
          : null,
        emailsThisMonth,
        monthlyEmailLimit: limit,
        usageRatio,
        isOverLimit
      };
    });

    const overLimitOnlyFlag = overLimitOnly === "true";

    const visibleItems = overLimitOnlyFlag
      ? items.filter((i) => i.isOverLimit)
      : items;

    // Summary by plan (based on visible items)
    const summaryMap = new Map<string, AdminEmailUsageSummaryByPlanItem>();

    const keyFor = (plan: AdminEmailUsageBotItem["usagePlan"]) =>
      plan ? plan.id : "NO_PLAN";

    for (const i of visibleItems) {
      const key = keyFor(i.usagePlan);
      let entry = summaryMap.get(key);
      if (!entry) {
        entry = {
          usagePlanId: i.usagePlan?.id ?? null,
          usagePlanCode: i.usagePlan?.code ?? null,
          usagePlanName: i.usagePlan?.name ?? null,
          monthlyEmails: i.monthlyEmailLimit,
          botsCount: 0,
          overLimitBotsCount: 0,
          totalEmailsThisMonth: 0
        };
        summaryMap.set(key, entry);
      }

      entry.botsCount += 1;
      entry.totalEmailsThisMonth += i.emailsThisMonth;
      if (i.isOverLimit) {
        entry.overLimitBotsCount += 1;
      }
    }

    const summaryByPlan = Array.from(summaryMap.values()).sort((a, b) => {
      const codeA = a.usagePlanCode || "";
      const codeB = b.usagePlanCode || "";
      return codeA.localeCompare(codeB);
    });

    const response: AdminEmailUsageListResponse = {
      items: visibleItems,
      page,
      pageSize,
      total,
      monthStart: monthStart.toISOString(),
      monthEndExclusive: monthEnd.toISOString(),
      summaryByPlan
    };

    return res.json(response);
  } catch (err) {
    console.error("Error in GET /api/admin/email-usage:", err);
    return res.status(500).json({ error: "Failed to load email usage" });
  }
});

export default router;
