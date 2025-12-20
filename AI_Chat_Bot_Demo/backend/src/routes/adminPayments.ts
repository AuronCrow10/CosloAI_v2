// src/routes/adminPayments.ts
import { Router } from "express";
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

function parseDateOnly(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  // Interpreted as midnight local time for the given date
  return d;
}

type AdminPaymentPlan = {
  id: string;
  code: string;
  name: string;
  monthlyAmountCents: number;
  currency: string;
};

type AdminPaymentReferral = {
  id: string;
  partnerId: string;
  partnerUserId: string | null;
  partnerUserEmail: string | null;
  partnerUserName: string | null;
  commissionCents: number;
  amountBaseCents: number;
  currency: string;
  kind: string;
  status: string;
};

type AdminPaymentListItem = {
  id: string;

  bot: {
    id: string;
    name: string;
    slug: string;
    status: BotStatus;
    owner: {
      id: string;
      email: string;
      name: string | null;
    };
  };

  amountCents: number;
  currency: string;
  status: string;

  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  stripeInvoiceId: string | null;
  stripePaymentIntentId: string | null;

  billingEmail: string | null;
  billingName: string | null;
  billingAddressJson: unknown | null;

  periodStart: string | null;
  periodEnd: string | null;

  createdAt: string;
  updatedAt: string;

  plan: AdminPaymentPlan | null;
  referral: AdminPaymentReferral | null;
};

type AdminPaymentTotalsByCurrencyItem = {
  currency: string;
  totalAmountCents: number;
  count: number;
};

type AdminPaymentListResponse = {
  items: AdminPaymentListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalsByCurrency: AdminPaymentTotalsByCurrencyItem[];
};

/**
 * GET /api/admin/payments
 *
 * Query params:
 *  - q?: string             (search billingEmail / billingName / bot name / slug / owner email)
 *  - status?: string        (substring match on status)
 *  - hasReferral?: "true" | "false"
 *  - dateFrom?: string      (YYYY-MM-DD, filter by createdAt >=)
 *  - dateTo?: string        (YYYY-MM-DD, filter by createdAt < next day)
 *  - page?: number          (1-based, default 1)
 *  - pageSize?: number      (default 20, max 100)
 */
router.get("/admin/payments", requireAuth, requireRole("ADMIN"), async (req, res) => {
  try {
    const { q, status, hasReferral, dateFrom, dateTo } = req.query as {
      q?: string;
      status?: string;
      hasReferral?: string;
      dateFrom?: string;
      dateTo?: string;
      page?: string;
      pageSize?: string;
    };

    const page = parsePositiveInt(req.query.page, 1, 1000);
    const pageSize = parsePositiveInt(req.query.pageSize, 20, 100);
    const skip = (page - 1) * pageSize;

    const where: any = {};

    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { billingEmail: { contains: term, mode: "insensitive" as const } },
        { billingName: { contains: term, mode: "insensitive" as const } },
        {
          bot: {
            OR: [
              { name: { contains: term, mode: "insensitive" as const } },
              { slug: { contains: term, mode: "insensitive" as const } },
              {
                user: {
                  email: { contains: term, mode: "insensitive" as const }
                }
              }
            ]
          }
        }
      ];
    }

    if (status && status.trim()) {
      const statusTerm = status.trim();
      // substring match on status, case-insensitive
      where.status = { contains: statusTerm, mode: "insensitive" as const };
    }

    const hasReferralFlag =
      hasReferral === "true" ? true : hasReferral === "false" ? false : null;

    if (hasReferralFlag === true) {
      where.referralCommission = { isNot: null };
    } else if (hasReferralFlag === false) {
      where.referralCommission = { is: null };
    }

    const createdAtFilter: any = {};
    const fromDate = dateFrom ? parseDateOnly(String(dateFrom)) : null;
    const toDate = dateTo ? parseDateOnly(String(dateTo)) : null;

    if (fromDate) {
      createdAtFilter.gte = fromDate;
    }
    if (toDate) {
      const toPlusOne = new Date(toDate);
      toPlusOne.setDate(toPlusOne.getDate() + 1);
      createdAtFilter.lt = toPlusOne;
    }

    if (Object.keys(createdAtFilter).length > 0) {
      where.createdAt = createdAtFilter;
    }

    const [total, payments, totalsAgg] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: {
          bot: {
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
          },
          referralCommission: {
            include: {
              partner: {
                include: {
                  user: {
                    select: {
                      id: true,
                      email: true,
                      name: true
                    }
                  }
                }
              }
            }
          }
        }
      }),
      prisma.payment.groupBy({
        by: ["currency"],
        where,
        _sum: { amountCents: true },
        _count: { _all: true }
      })
    ]);

    const totalsByCurrency: AdminPaymentTotalsByCurrencyItem[] = totalsAgg.map((row) => ({
      currency: row.currency,
      totalAmountCents: row._sum.amountCents ?? 0,
      count: row._count._all ?? 0
    }));

    const items: AdminPaymentListItem[] = payments.map((p) => {
      const bot = p.bot;
      const sub = bot.subscription;
      const plan = sub?.usagePlan ?? null;
      const rc = p.referralCommission;

      return {
        id: p.id,
        bot: {
          id: bot.id,
          name: bot.name,
          slug: bot.slug,
          status: bot.status as BotStatus,
          owner: {
            id: bot.user.id,
            email: bot.user.email,
            name: bot.user.name ?? null
          }
        },
        amountCents: p.amountCents,
        currency: p.currency,
        status: p.status,
        stripeCustomerId: p.stripeCustomerId,
        stripeSubscriptionId: p.stripeSubscriptionId ?? null,
        stripeInvoiceId: p.stripeInvoiceId ?? null,
        stripePaymentIntentId: p.stripePaymentIntentId ?? null,
        billingEmail: p.billingEmail ?? null,
        billingName: p.billingName ?? null,
        billingAddressJson: p.billingAddressJson ?? null,
        periodStart: p.periodStart ? p.periodStart.toISOString() : null,
        periodEnd: p.periodEnd ? p.periodEnd.toISOString() : null,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        plan: plan
          ? {
              id: plan.id,
              code: plan.code,
              name: plan.name,
              monthlyAmountCents: plan.monthlyAmountCents,
              currency: plan.currency
            }
          : null,
        referral: rc
          ? {
              id: rc.id,
              partnerId: rc.partnerId,
              partnerUserId: rc.partner?.user?.id ?? null,
              partnerUserEmail: rc.partner?.user?.email ?? null,
              partnerUserName: rc.partner?.user?.name ?? null,
              commissionCents: rc.commissionCents,
              amountBaseCents: rc.amountBaseCents,
              currency: rc.currency,
              kind: rc.kind,
              status: rc.status
            }
          : null
      };
    });

    const response: AdminPaymentListResponse = {
      items,
      page,
      pageSize,
      total,
      totalsByCurrency
    };

    return res.json(response);
  } catch (err) {
    console.error("Error in GET /api/admin/payments:", err);
    return res.status(500).json({ error: "Failed to load payments" });
  }
});

export default router;
