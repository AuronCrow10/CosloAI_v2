// src/routes/adminBots.ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

const BOT_STATUS_VALUES = ["DRAFT", "PENDING_PAYMENT", "ACTIVE", "SUSPENDED", "CANCELED"] as const;
type BotStatus = (typeof BOT_STATUS_VALUES)[number];

const SUB_STATUS_VALUES = [
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "INCOMPLETE",
  "INCOMPLETE_EXPIRED",
  "TRIALING",
  "UNPAID"
] as const;
type SubscriptionStatus = (typeof SUB_STATUS_VALUES)[number];

function parsePositiveInt(value: unknown, defaultValue: number, max: number): number {
  if (typeof value !== "string") return defaultValue;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(n, max);
}

type AdminBotListItem = {
  id: string;
  name: string;
  slug: string;
  status: BotStatus;
  createdAt: string;

  owner: {
    id: string;
    email: string;
    name: string | null;
  };

  channelWeb: boolean;
  channelWhatsapp: boolean;
  channelInstagram: boolean;
  channelMessenger: boolean;
  externalChannelCount: number;

  subscription: {
    id: string;
    status: SubscriptionStatus;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripePriceId: string;
    currency: string | null;

    usagePlanId: string | null;
    usagePlanCode: string | null;
    usagePlanName: string | null;
    monthlyAmountCents: number | null;
    monthlyTokens: number | null;
    monthlyEmails: number | null;
  } | null;

  booking: {
    enabled: boolean;
    calendarId: string | null;
    timeZone: string | null;
    defaultDurationMinutes: number | null;
    bookingMinLeadHours: number | null;
    bookingMaxAdvanceDays: number | null;
    bookingReminderWindowHours: number | null;
    bookingReminderMinLeadHours: number | null;
    bookingConfirmationEmailEnabled: boolean;
    bookingReminderEmailEnabled: boolean;
  };

  autoEvaluateConversations: boolean;

  tokensLast30Days: number;
  emailsLast30Days: number;
  bookingsLast30Days: number;
};

type AdminBotListResponse = {
  items: AdminBotListItem[];
  page: number;
  pageSize: number;
  total: number;
};

type AdminUsagePlan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyAmountCents: number;
  currency: string;
  monthlyTokens: number | null;
  monthlyEmails: number | null;
  isActive: boolean;
};

type AdminUsagePlanListResponse = {
  items: AdminUsagePlan[];
};

const patchBodySchema = z
  .object({
    status: z.enum(BOT_STATUS_VALUES).optional(),
    autoEvaluateConversations: z.boolean().optional(),
    usagePlanId: z.string().uuid().nullable().optional()
  })
  .refine(
    (data) =>
      data.status !== undefined ||
      data.autoEvaluateConversations !== undefined ||
      data.usagePlanId !== undefined,
    { message: "At least one field must be provided" }
  );

/**
 * GET /api/admin/bots
 *
 * Query params:
 *  - q?: string (search in bot name / slug / owner email)
 *  - status?: BotStatus
 *  - hasSubscription?: "true" | "false"
 *  - planCode?: string (UsagePlan.code)
 *  - page?: number (1-based, default 1)
 *  - pageSize?: number (default 20, max 100)
 */
router.get("/admin/bots", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { q, status, hasSubscription, planCode } = req.query as {
      q?: string;
      status?: string;
      hasSubscription?: string;
      planCode?: string;
      page?: string;
      pageSize?: string;
    };

    const page = parsePositiveInt(req.query.page, 1, 1000);
    const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);
    const skip = (page - 1) * pageSize;

    const where: any = {};

    if (status && BOT_STATUS_VALUES.includes(status as BotStatus)) {
      where.status = status;
    }

    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" as const } },
        { slug: { contains: term, mode: "insensitive" as const } },
        { user: { email: { contains: term, mode: "insensitive" as const } } }
      ];
    }

    let hasSubscriptionFilter: boolean | null = null;
    if (hasSubscription === "true") hasSubscriptionFilter = true;
    else if (hasSubscription === "false") hasSubscriptionFilter = false;

    if (planCode && planCode.trim()) {
      const trimmed = planCode.trim();
      // Only bots whose subscription has a usagePlan with this code
      where.subscription = {
        is: {
          usagePlan: {
            is: { code: trimmed }
          }
        }
      };
      if (hasSubscriptionFilter === false) {
        // Conflicting filters => no results
        where.subscription = { is: null };
      }
    } else if (hasSubscriptionFilter === true) {
      where.subscription = { isNot: null };
    } else if (hasSubscriptionFilter === false) {
      where.subscription = { is: null };
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
            select: { id: true, email: true, name: true }
          },
          subscription: {
            include: {
              usagePlan: true
            }
          },
          _count: {
            select: {
              channels: true,
              bookings: true
            }
          }
        }
      })
    ]);

    if (bots.length === 0) {
      const empty: AdminBotListResponse = {
        items: [],
        page,
        pageSize,
        total
      };
      return res.json(empty);
    }

    const botIds = bots.map((b) => b.id);
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [tokenAgg, emailAgg, bookingsAgg] = await Promise.all([
      prisma.openAIUsage.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds }, createdAt: { gte: since } },
        _sum: { totalTokens: true }
      }),
      prisma.emailUsage.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds }, createdAt: { gte: since } },
        _count: { _all: true }
      }),
      prisma.booking.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds }, start: { gte: since } },
        _count: { _all: true }
      })
    ]);

    const tokensByBotId = new Map<string, number>();
    for (const row of tokenAgg) {
      if (!row.botId) continue;
      tokensByBotId.set(row.botId, row._sum.totalTokens ?? 0);
    }

    const emailsByBotId = new Map<string, number>();
    for (const row of emailAgg) {
      if (!row.botId) continue;
      emailsByBotId.set(row.botId, row._count._all ?? 0);
    }

    const bookingsByBotId = new Map<string, number>();
    for (const row of bookingsAgg) {
      if (!row.botId) continue;
      bookingsByBotId.set(row.botId, row._count._all ?? 0);
    }

    const items: AdminBotListItem[] = bots.map((b) => {
      const sub = b.subscription;
      const plan = sub?.usagePlan ?? null;

      return {
        id: b.id,
        name: b.name,
        slug: b.slug,
        status: b.status as BotStatus,
        createdAt: b.createdAt.toISOString(),
        owner: {
          id: b.user.id,
          email: b.user.email,
          name: b.user.name ?? null
        },
        channelWeb: b.channelWeb,
        channelWhatsapp: b.channelWhatsapp,
        channelInstagram: b.channelInstagram,
        channelMessenger: b.channelMessenger,
        externalChannelCount: b._count.channels,
        subscription: sub
          ? {
              id: sub.id,
              status: sub.status as SubscriptionStatus,
              stripeCustomerId: sub.stripeCustomerId,
              stripeSubscriptionId: sub.stripeSubscriptionId,
              stripePriceId: sub.stripePriceId,
              currency: sub.currency ?? null,
              usagePlanId: sub.usagePlanId ?? null,
              usagePlanCode: plan?.code ?? null,
              usagePlanName: plan?.name ?? null,
              monthlyAmountCents: plan?.monthlyAmountCents ?? null,
              monthlyTokens: plan?.monthlyTokens ?? null,
              monthlyEmails: plan?.monthlyEmails ?? null
            }
          : null,
        booking: {
          enabled: b.useCalendar,
          calendarId: b.calendarId ?? null,
          timeZone: b.timeZone ?? null,
          defaultDurationMinutes: b.defaultDurationMinutes ?? null,
          bookingMinLeadHours: b.bookingMinLeadHours ?? null,
          bookingMaxAdvanceDays: b.bookingMaxAdvanceDays ?? null,
          bookingReminderWindowHours: b.bookingReminderWindowHours ?? null,
          bookingReminderMinLeadHours: b.bookingReminderMinLeadHours ?? null,
          bookingConfirmationEmailEnabled: b.bookingConfirmationEmailEnabled,
          bookingReminderEmailEnabled: b.bookingReminderEmailEnabled
        },
        autoEvaluateConversations: b.autoEvaluateConversations,
        tokensLast30Days: tokensByBotId.get(b.id) ?? 0,
        emailsLast30Days: emailsByBotId.get(b.id) ?? 0,
        bookingsLast30Days: bookingsByBotId.get(b.id) ?? 0
      };
    });

    const response: AdminBotListResponse = {
      items,
      page,
      pageSize,
      total
    };

    return res.json(response);
  } catch (err) {
    console.error("Error in GET /api/admin/bots:", err);
    return res.status(500).json({ error: "Failed to load bots" });
  }
});

/**
 * PATCH /api/admin/bots/:id
 * body: { status?: BotStatus; autoEvaluateConversations?: boolean; usagePlanId?: string | null }
 */
router.patch("/admin/bots/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const idSchema = z.string().uuid();
  const idParsed = idSchema.safeParse(req.params.id);
  if (!idParsed.success) {
    return res.status(400).json({ error: "Invalid bot id" });
  }
  const botId = idParsed.data;

  const bodyParsed = patchBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: bodyParsed.error.flatten() });
  }

  const { status, autoEvaluateConversations, usagePlanId } = bodyParsed.data;

  try {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: { subscription: true }
    });

    if (!bot) {
      return res.status(404).json({ error: "Bot not found" });
    }

    // Prepare what we want to change
    const botUpdateData: Record<string, unknown> = {};
    if (status !== undefined) {
      botUpdateData.status = status;
    }
    if (autoEvaluateConversations !== undefined) {
      botUpdateData.autoEvaluateConversations = autoEvaluateConversations;
    }

    const wantsPlanChange = usagePlanId !== undefined;

    if (!wantsPlanChange && Object.keys(botUpdateData).length === 0) {
      return res.status(400).json({ error: "No changes requested" });
    }

    if (wantsPlanChange && !bot.subscription) {
      return res.status(400).json({ error: "Bot has no subscription to update" });
    }

    await prisma.$transaction(async (tx) => {
      if (Object.keys(botUpdateData).length > 0) {
        await tx.bot.update({
          where: { id: botId },
          data: botUpdateData
        });
      }

      if (wantsPlanChange && bot.subscription) {
        await tx.subscription.update({
          where: { id: bot.subscription.id },
          data: { usagePlanId: usagePlanId ?? null }
        });
      }
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in PATCH /api/admin/bots/:id:", err);
    return res.status(500).json({ error: "Failed to update bot" });
  }
});

/**
 * GET /api/admin/usage-plans
 * - List all usage plans for admin UI
 */
router.get("/admin/usage-plans", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  try {
    const plans = await prisma.usagePlan.findMany({
      orderBy: [
        { isActive: "desc" },
        { monthlyAmountCents: "asc" },
        { code: "asc" }
      ]
    });

    const response: AdminUsagePlanListResponse = {
      items: plans.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description ?? null,
        monthlyAmountCents: p.monthlyAmountCents,
        currency: p.currency,
        monthlyTokens: p.monthlyTokens ?? null,
        monthlyEmails: p.monthlyEmails ?? null,
        isActive: p.isActive
      }))
    };

    return res.json(response);
  } catch (err) {
    console.error("Error in GET /api/admin/usage-plans:", err);
    return res.status(500).json({ error: "Failed to load usage plans" });
  }
});

export default router;
