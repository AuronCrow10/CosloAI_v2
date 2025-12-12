import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  REFERRAL_COOKIE_NAME,
  REFERRAL_COOKIE_MAX_AGE_DAYS,
  REFERRAL_DEFAULT_COMMISSION_BPS,
  generateReferralCode,
  hashIp,
  monthKeyForDate,
  validateReferralCode
} from "../services/referralService";

const router = Router();

/* =========================
   Helpers
   ========================= */

const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/, "month must be in YYYY-MM format");

function monthStartUtc(monthKey: string): Date {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
}

function nextMonthStartUtc(monthKey: string): Date {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
}

function parseMonthParam(raw: unknown): string {
  if (typeof raw === "string" && monthKeySchema.safeParse(raw).success) return raw;
  return monthKeyForDate(new Date());
}

/* =========================
   Public: track + cookie
   ========================= */

/**
 * GET /api/referrals/track?code=XXXX&path=/pricing
 * - logs click
 * - sets httpOnly cookie containing referral code
 */
router.get("/referrals/track", async (req, res) => {
  const schema = z.object({
    code: z.string().min(1),
    path: z.string().optional()
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query" });

  const { code, path } = parsed.data;

  const valid = await validateReferralCode(code);
  if (!valid) {
    res.clearCookie(REFERRAL_COOKIE_NAME);
    return res.status(404).json({ error: "Referral code not found" });
  }

  const forwarded =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  const ip = forwarded || req.socket.remoteAddress || null;

  await prisma.referralClick.create({
    data: {
      referralCodeId: valid.referralCodeId,
      landingPath: path || undefined,
      referrerUrl: req.get("referer") || undefined,
      userAgent: req.get("user-agent") || undefined,
      ipHash: hashIp(ip)
    }
  });

  const secure = process.env.NODE_ENV === "production";
  res.cookie(REFERRAL_COOKIE_NAME, valid.code, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: REFERRAL_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  });

  return res.json({ ok: true, code: valid.code });
});

/**
 * POST /api/referrals/clear
 */
router.post("/referrals/clear", async (_req, res) => {
  res.clearCookie(REFERRAL_COOKIE_NAME);
  return res.json({ ok: true });
});

/* =========================
   Referrer: self endpoints
   ========================= */

router.get("/referrals/me", requireAuth, async (req, res) => {
  const userId = (req as any).user.id as string;

  const partner = await prisma.referralPartner.findUnique({
    where: { userId },
    include: { codes: { orderBy: { createdAt: "asc" } } }
  });

  if (!partner) return res.status(404).json({ error: "Not a referrer" });

  return res.json({
    id: partner.id,
    status: partner.status,
    commissionBps: partner.commissionBps,
    codes: partner.codes.map((c) => ({ id: c.id, code: c.code, isActive: c.isActive })),
    createdAt: partner.createdAt,
    updatedAt: partner.updatedAt
  });
});

/**
 * GET /api/referrals/me/stats?month=YYYY-MM
 * - counts clients
 * - net revenue/commission for month (earned + reversals)
 * - shows payout period rows for month
 */
router.get("/referrals/me/stats", requireAuth, async (req, res) => {
  const userId = (req as any).user.id as string;
  const month = parseMonthParam(req.query.month);

  const partner = await prisma.referralPartner.findUnique({ where: { userId } });
  if (!partner) return res.status(404).json({ error: "Not a referrer" });

  const from = monthStartUtc(month);
  const to = nextMonthStartUtc(month);

  const [activeAttributions, conversionsThisMonth, payoutRows, agg] = await Promise.all([
    prisma.referralAttribution.count({ where: { partnerId: partner.id, endedAt: null } }),
    prisma.referralAttribution.count({
      where: { partnerId: partner.id, startedAt: { gte: from, lt: to } }
    }),
    prisma.referralPayoutPeriod.findMany({
      where: { partnerId: partner.id, monthKey: month },
      orderBy: { createdAt: "desc" }
    }),
    prisma.referralCommission.groupBy({
      by: ["currency"],
      where: { partnerId: partner.id, monthKey: month },
      _sum: { commissionCents: true, amountBaseCents: true }
    })
  ]);

  return res.json({
    month,
    activeAttributions,
    conversionsThisMonth,
    totalsByCurrency: agg.map((r) => ({
      currency: r.currency,
      revenueCents: r._sum.amountBaseCents ?? 0,
      commissionCents: r._sum.commissionCents ?? 0
    })),
    payoutPeriods: payoutRows.map((p) => ({
      currency: p.currency,
      amountCents: p.amountCents,
      status: p.status,
      paidAt: p.paidAt
    }))
  });
});

/* =========================
   ADMIN endpoints
   ========================= */

/**
 * POST /api/referrals/admin/partners
 * body: { userId?: string, email?: string, commissionBps?: number, createCode?: boolean }
 */
router.post("/referrals/admin/partners", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const schema = z.object({
    userId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    commissionBps: z.number().int().min(1).max(5000).optional(),
    createCode: z.boolean().optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { userId, email, commissionBps, createCode } = parsed.data;

  const user =
    userId
      ? await prisma.user.findUnique({ where: { id: userId } })
      : email
        ? await prisma.user.findUnique({ where: { email } })
        : null;

  if (!user) return res.status(404).json({ error: "User not found" });

  // Ensure role
  await prisma.user.update({
    where: { id: user.id },
    data: { role: "REFERRER" }
  });

  const partner = await prisma.referralPartner.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      status: "ACTIVE",
      commissionBps: commissionBps ?? REFERRAL_DEFAULT_COMMISSION_BPS
    },
    update: {
      commissionBps: commissionBps ?? undefined
    }
  });

  let createdCode: string | null = null;

  if (createCode !== false) {
    const existing = await prisma.referralCode.findFirst({ where: { partnerId: partner.id } });
    if (!existing) {
      let code = generateReferralCode();
      for (let i = 0; i < 10; i++) {
        const exists = await prisma.referralCode.findUnique({ where: { code } });
        if (!exists) break;
        code = generateReferralCode();
      }
      const created = await prisma.referralCode.create({
        data: { partnerId: partner.id, code, isActive: true }
      });
      createdCode = created.code;
    }
  }

  return res.json({
    partnerId: partner.id,
    userId: user.id,
    commissionBps: partner.commissionBps,
    createdCode
  });
});

/**
 * GET /api/referrals/admin/partners
 */
router.get("/referrals/admin/partners", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const partners = await prisma.referralPartner.findMany({
    include: { user: true, codes: true },
    orderBy: { createdAt: "desc" }
  });

  return res.json(
    partners.map((p) => ({
      id: p.id,
      userId: p.userId,
      email: p.user.email,
      name: p.user.name,
      status: p.status,
      commissionBps: p.commissionBps,
      codes: p.codes.map((c) => ({ code: c.code, isActive: c.isActive })),
      createdAt: p.createdAt
    }))
  );
});

/**
 * PATCH /api/referrals/admin/partners/:id
 */
router.patch("/referrals/admin/partners/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const schema = z.object({
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
    commissionBps: z.number().int().min(1).max(5000).optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const partnerId = req.params.id;

  const partner = await prisma.referralPartner.update({
    where: { id: partnerId },
    data: {
      status: parsed.data.status,
      commissionBps: parsed.data.commissionBps
    }
  });

  return res.json({ ok: true, partner });
});

/**
 * POST /api/referrals/admin/partners/:id/codes
 */
router.post("/referrals/admin/partners/:id/codes", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const partnerId = req.params.id;

  const partner = await prisma.referralPartner.findUnique({ where: { id: partnerId } });
  if (!partner) return res.status(404).json({ error: "Partner not found" });

  let code = generateReferralCode();
  for (let i = 0; i < 10; i++) {
    const exists = await prisma.referralCode.findUnique({ where: { code } });
    if (!exists) break;
    code = generateReferralCode();
  }

  const created = await prisma.referralCode.create({
    data: { partnerId, code, isActive: true }
  });

  return res.json({ ok: true, code: created.code });
});

/**
 * ✅ GET /api/referrals/admin/overview?month=YYYY-MM
 * Dashboard aggregated stats for all partners.
 */
router.get("/referrals/admin/overview", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const month = parseMonthParam(req.query.month);

  const partners = await prisma.referralPartner.findMany({
    include: { user: true, codes: true },
    orderBy: { createdAt: "desc" }
  });

  const partnerIds = partners.map((p) => p.id);

  const [
    totalAttrib,
    activeAttrib,
    lastConv,
    monthAgg,
    lifeAgg,
    payoutThisMonth,
    totalsMonth,
    totalsLifetime,
    dueOpen,
    duePaid
  ] = await Promise.all([
    prisma.referralAttribution.groupBy({
      by: ["partnerId"],
      where: { partnerId: { in: partnerIds } },
      _count: { _all: true }
    }),
    prisma.referralAttribution.groupBy({
      by: ["partnerId"],
      where: { partnerId: { in: partnerIds }, endedAt: null },
      _count: { _all: true }
    }),
    prisma.referralAttribution.groupBy({
      by: ["partnerId"],
      where: { partnerId: { in: partnerIds } },
      _max: { startedAt: true }
    }),
    prisma.referralCommission.groupBy({
      by: ["partnerId", "currency"],
      where: { partnerId: { in: partnerIds }, monthKey: month },
      _sum: { amountBaseCents: true, commissionCents: true }
    }),
    prisma.referralCommission.groupBy({
      by: ["partnerId", "currency"],
      where: { partnerId: { in: partnerIds } },
      _sum: { amountBaseCents: true, commissionCents: true }
    }),
    prisma.referralPayoutPeriod.findMany({
      where: { partnerId: { in: partnerIds }, monthKey: month }
    }),
    prisma.referralCommission.groupBy({
      by: ["currency"],
      where: { monthKey: month },
      _sum: { amountBaseCents: true, commissionCents: true }
    }),
    prisma.referralCommission.groupBy({
      by: ["currency"],
      _sum: { amountBaseCents: true, commissionCents: true }
    }),
    prisma.referralPayoutPeriod.groupBy({
      by: ["currency"],
      where: { monthKey: month, status: "OPEN" },
      _sum: { amountCents: true }
    }),
    prisma.referralPayoutPeriod.groupBy({
      by: ["currency"],
      where: { monthKey: month, status: "PAID" },
      _sum: { amountCents: true }
    })
  ]);

  const totalAttribMap = new Map(totalAttrib.map((r) => [r.partnerId, r._count._all]));
  const activeAttribMap = new Map(activeAttrib.map((r) => [r.partnerId, r._count._all]));
  const lastConvMap = new Map(lastConv.map((r) => [r.partnerId, r._max.startedAt ?? null]));

  const partnerRows = partners.map((p) => {
    const monthByCurrency = monthAgg
      .filter((r) => r.partnerId === p.id)
      .map((r) => ({
        currency: r.currency,
        revenueCents: r._sum.amountBaseCents ?? 0,
        commissionCents: r._sum.commissionCents ?? 0
      }));

    const lifeByCurrency = lifeAgg
      .filter((r) => r.partnerId === p.id)
      .map((r) => ({
        currency: r.currency,
        revenueCents: r._sum.amountBaseCents ?? 0,
        commissionCents: r._sum.commissionCents ?? 0
      }));

    const payouts = payoutThisMonth
      .filter((x) => x.partnerId === p.id)
      .map((x) => ({
        currency: x.currency,
        amountCents: x.amountCents,
        status: x.status,
        paidAt: x.paidAt
      }));

    return {
      partnerId: p.id,
      userId: p.userId,
      email: p.user.email,
      name: p.user.name,
      status: p.status,
      commissionBps: p.commissionBps,
      codes: p.codes.map((c) => ({ code: c.code, isActive: c.isActive })),

      clientsTotal: totalAttribMap.get(p.id) ?? 0,
      clientsActive: activeAttribMap.get(p.id) ?? 0,
      lastConversionAt: lastConvMap.get(p.id) ?? null,

      month: {
        monthKey: month,
        totalsByCurrency: monthByCurrency,
        payoutPeriods: payouts
      },

      lifetime: {
        totalsByCurrency: lifeByCurrency
      }
    };
  });

  return res.json({
    monthKey: month,
    totals: {
      monthByCurrency: totalsMonth.map((t) => ({
        currency: t.currency,
        revenueCents: t._sum.amountBaseCents ?? 0,
        commissionCents: t._sum.commissionCents ?? 0
      })),
      lifetimeByCurrency: totalsLifetime.map((t) => ({
        currency: t.currency,
        revenueCents: t._sum.amountBaseCents ?? 0,
        commissionCents: t._sum.commissionCents ?? 0
      })),
      dueThisMonth: {
        openByCurrency: dueOpen.map((d) => ({
          currency: d.currency,
          amountCents: d._sum.amountCents ?? 0
        })),
        paidByCurrency: duePaid.map((d) => ({
          currency: d.currency,
          amountCents: d._sum.amountCents ?? 0
        }))
      }
    },
    partners: partnerRows
  });
});

/**
 * ✅ GET /api/referrals/admin/partners/:id/detail?month=YYYY-MM&take=50&skip=0
 * Drill-down endpoint for the admin panel.
 */
router.get(
  "/referrals/admin/partners/:id/detail",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const partnerId = req.params.id;
    const month = parseMonthParam(req.query.month);

    const take = Math.min(200, Math.max(1, Number(req.query.take || 50)));
    const skip = Math.max(0, Number(req.query.skip || 0));

    const partner = await prisma.referralPartner.findUnique({
      where: { id: partnerId },
      include: {
        user: true,
        codes: { orderBy: { createdAt: "asc" } }
      }
    });

    if (!partner) return res.status(404).json({ error: "Partner not found" });

    const [clientsTotal, clientsActive, monthAgg, lifeAgg, payoutThisMonth] = await Promise.all([
      prisma.referralAttribution.count({ where: { partnerId } }),
      prisma.referralAttribution.count({ where: { partnerId, endedAt: null } }),
      prisma.referralCommission.groupBy({
        by: ["currency"],
        where: { partnerId, monthKey: month },
        _sum: { amountBaseCents: true, commissionCents: true }
      }),
      prisma.referralCommission.groupBy({
        by: ["currency"],
        where: { partnerId },
        _sum: { amountBaseCents: true, commissionCents: true }
      }),
      prisma.referralPayoutPeriod.findMany({
        where: { partnerId, monthKey: month }
      })
    ]);

    const [attributions, commissions, payoutHistory] = await Promise.all([
      prisma.referralAttribution.findMany({
        where: { partnerId },
        orderBy: { startedAt: "desc" },
        take,
        skip,
        include: {
          referredUser: true,
          bot: true,
          referralCode: true
        }
      }),
      prisma.referralCommission.findMany({
        where: { partnerId },
        orderBy: { createdAt: "desc" },
        take,
        skip
      }),
      prisma.referralPayoutPeriod.findMany({
        where: { partnerId },
        orderBy: [{ monthKey: "desc" }],
        take: 24
      })
    ]);

    return res.json({
      partner: {
        id: partner.id,
        userId: partner.userId,
        email: partner.user.email,
        name: partner.user.name,
        status: partner.status,
        commissionBps: partner.commissionBps,
        codes: partner.codes.map((c) => ({ code: c.code, isActive: c.isActive })),
        createdAt: partner.createdAt
      },
      clients: {
        total: clientsTotal,
        active: clientsActive
      },
      month: {
        monthKey: month,
        totalsByCurrency: monthAgg.map((r) => ({
          currency: r.currency,
          revenueCents: r._sum.amountBaseCents ?? 0,
          commissionCents: r._sum.commissionCents ?? 0
        })),
        payoutPeriods: payoutThisMonth.map((p) => ({
          currency: p.currency,
          amountCents: p.amountCents,
          status: p.status,
          paidAt: p.paidAt
        }))
      },
      lifetime: {
        totalsByCurrency: lifeAgg.map((r) => ({
          currency: r.currency,
          revenueCents: r._sum.amountBaseCents ?? 0,
          commissionCents: r._sum.commissionCents ?? 0
        }))
      },
      recent: {
        attributions: attributions.map((a) => ({
          id: a.id,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
          referralCode: a.referralCode.code,
          referredUser: {
            id: a.referredUserId,
            email: a.referredUser.email
          },
          bot: {
            id: a.botId,
            name: a.bot.name,
            slug: a.bot.slug,
            status: a.bot.status
          },
          stripeSubscriptionId: a.stripeSubscriptionId
        })),
        commissions: commissions.map((c) => ({
          id: c.id,
          createdAt: c.createdAt,
          monthKey: c.monthKey,
          currency: c.currency,
          kind: c.kind,
          status: c.status,
          revenueCents: c.amountBaseCents,
          commissionCents: c.commissionCents,
          stripeInvoiceId: c.stripeInvoiceId,
          stripeSubscriptionId: c.stripeSubscriptionId
        }))
      },
      payoutHistory: payoutHistory.map((p) => ({
        monthKey: p.monthKey,
        currency: p.currency,
        amountCents: p.amountCents,
        status: p.status,
        paidAt: p.paidAt
      }))
    });
  }
);

/**
 * ✅ Manual payout flow:
 * POST /api/referrals/admin/partners/:partnerId/payouts/:monthKey/mark-paid
 */
router.post(
  "/referrals/admin/partners/:partnerId/payouts/:monthKey/mark-paid",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res) => {
    const { partnerId, monthKey } = req.params;

    if (!monthKeySchema.safeParse(monthKey).success) {
      return res.status(400).json({ error: "Invalid monthKey (expected YYYY-MM)" });
    }

    const updated = await prisma.referralPayoutPeriod.updateMany({
      where: { partnerId, monthKey, status: "OPEN" },
      data: { status: "PAID", paidAt: new Date() }
    });

    return res.json({ ok: true, updated: updated.count });
  }
);

export default router;
