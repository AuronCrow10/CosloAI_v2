import { Router } from "express";
import Stripe from "stripe";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../prisma/prisma";
import {
  stripe,
  computeBotPricingForBot,
  updateBotSubscriptionForUsagePlanChange,
  botToFeatureFlags,
  buildCompactPlanSnapshot
} from "../services/billingService";
import { getCurrentUsageRangeForBot, getPlanUsageForBot } from "../services/planUsageService";
import { getEmailUsageForBot } from "../services/emailUsageService";
import { userCanAccessBot } from "../services/teamAccessService";
import {
  BillingTerm,
  billingTermMonths,
  classifyPlanChange,
  getPlanTermPrice,
  listPlanTermPrices,
  normalizeBillingTerm
} from "../services/billingTerms";

// ✅ Referrals
import {
  validateReferralCode,
  REFERRAL_COOKIE_NAME
} from "../services/referralService";

const router = Router();

/**
 * IMPORTANT:
 * Your TS setup is strict and your Prisma client types are not being picked up
 * (or they don't export model/types in your environment). So we use structural
 * typing for the fields we actually read from Prisma results.
 */

type UsagePlanLite = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyTokens: number | null;
  monthlyEmails: number | null;
  monthlyWhatsappLeads: number | null;
  monthlyAmountCents: number;
  semiAnnualAmountCents: number | null;
  annualAmountCents: number | null;
  currency: string;
  stripePriceId: string | null;
  stripeSemiAnnualPriceId: string | null;
  stripeAnnualPriceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type StripeCancelInfo = {
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
};

type PaymentWithBotLite = {
  id: string;
  botId: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  stripeInvoiceId: string | null;
  kind: "SUBSCRIPTION" | "TOP_UP";
  bot: {
    id: string;
    name: string;
    userId: string;
  };
};

function formatAmountForUi(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2
  }).format(amountCents / 100);
}

// Require auth for all /billing/* routes
router.use("/billing", requireAuth);

/**
 * GET /api/billing/overview
 * - For logged-in user: lists subscriptions + usage + totals + recent payments.
 */
router.get("/billing/overview", async (req, res) => {
  try {
    const userId = (req as any).user.id as string;

    const bots = await prisma.bot.findMany({
      where: { userId },
      include: {
        user: true,
        subscription: {
          include: {
            usagePlan: true
          }
        }
      }
    });

    const subscriptions: any[] = [];

    const cancelInfoMap = new Map<string, StripeCancelInfo>();
    const stripeClient = stripe;
    if (stripeClient) {
      const stripeSubsToFetch = bots
        .map((b) => b.subscription)
        .filter(
          (sub): sub is NonNullable<typeof sub> =>
            !!sub &&
            !!sub.stripeSubscriptionId &&
            !sub.stripeSubscriptionId.startsWith("free_")
        );

      await Promise.all(
        stripeSubsToFetch.map(async (sub) => {
          try {
            const stripeSub = await stripeClient.subscriptions.retrieve(
              sub.stripeSubscriptionId
            );
            cancelInfoMap.set(sub.botId, {
              cancelAtPeriodEnd: !!stripeSub.cancel_at_period_end,
              periodEnd: stripeSub.current_period_end
                ? new Date(stripeSub.current_period_end * 1000).toISOString()
                : null
            });
          } catch (err) {
            console.error(
              "Failed to fetch Stripe subscription cancel info",
              err
            );
          }
        })
      );
    }

    for (const bot of bots) {
      const sub = bot.subscription;
      if (!sub) continue;

      const usagePlan = sub.usagePlan ?? null;

      const normalizedTerm = normalizeBillingTerm(
        (sub as any).billingTerm
      ) as BillingTerm;

      const planUsage = await getPlanUsageForBot(bot.id);
      const fallbackRange = await getCurrentUsageRangeForBot(bot.id);
      const from = planUsage?.periodStart ?? fallbackRange.from;
      const to = planUsage?.periodEnd ?? fallbackRange.to;

      const usedTokens = planUsage?.usedTokensTotal ?? 0;

      let monthlyTokens =
        planUsage?.monthlyTokenLimit ?? usagePlan?.monthlyTokens ?? null;

      const usagePercent =
        monthlyTokens && monthlyTokens > 0
        ? Math.min(100, Math.round((usedTokens / monthlyTokens) * 100))
        : null;

      // Email usage
      const emailUsage = await getEmailUsageForBot({
        botId: bot.id,
        from,
        to
      });
      const usedEmails = emailUsage.count;
      const monthlyEmails = usagePlan?.monthlyEmails ?? null;
      const emailUsagePercent =
        monthlyEmails && monthlyEmails > 0
          ? Math.min(
              100,
              Math.round((usedEmails / monthlyEmails) * 100)
            )
          : null;

      // ✅ WhatsApp lead messages usage (only SENT lead templates)
      const usedWhatsappLeads = await prisma.metaLead.count({
        where: {
          botId: bot.id,
          whatsappStatus: "SENT",
          createdAt: {
            gte: from,
            lt: to
          }
        }
      });

      const monthlyWhatsappLeads =
        (usagePlan as any)?.monthlyWhatsappLeads ?? null;
      const whatsappUsagePercent =
        monthlyWhatsappLeads && monthlyWhatsappLeads > 0
          ? Math.min(
              100,
              Math.round(
                (usedWhatsappLeads / monthlyWhatsappLeads) * 100
              )
            )
          : null;

      const snap: any = sub.planSnapshotJson ?? null;

      // ✅ Features are included in the plan now — always 0 in billing/overview.
      const featuresAmountCents = 0;
      const termPrice = usagePlan
        ? getPlanTermPrice(usagePlan, normalizedTerm)
        : null;

      // Plan amount: prefer snapshot pt, else DB usagePlan
      let planAmountCents: number | null =
        typeof snap?.pt === "number"
          ? snap.pt
          : usagePlan?.monthlyAmountCents ?? null;

      // Currency: snapshot > subscription > usagePlan > default
      const currency: string =
        (snap?.c as string | undefined) ||
        sub.currency ||
        usagePlan?.currency ||
        "eur";

      // ✅ Total must be PLAN ONLY.
      // Even if old snapshots had t/fp that included feature add-ons, we ignore them.
      if (planAmountCents == null && usagePlan) {
        planAmountCents = usagePlan.monthlyAmountCents;
      }

      const totalMonthlyAmountCents =
        typeof snap?.mt === "number"
          ? snap.mt
          : termPrice?.monthlyEquivalentAmountCents ??
            planAmountCents ??
            0;
      const termAmountCents =
        typeof snap?.tm === "number"
          ? snap.tm
          : termPrice?.amountCents ??
            totalMonthlyAmountCents;
      const totalMonthlyAmountFormatted = formatAmountForUi(
        totalMonthlyAmountCents,
        currency
      );

      const cancelInfo = cancelInfoMap.get(bot.id) ?? {
        cancelAtPeriodEnd: false,
        periodEnd: null
      };

      subscriptions.push({
        botId: bot.id,
        botName: bot.name,
        botSlug: bot.slug,
        botStatus: bot.status,
        subscriptionStatus: sub.status,
        currency,
        billingTerm: normalizedTerm,
        billingTermMonths: billingTermMonths(normalizedTerm),
        termAmountCents,
        totalMonthlyAmountCents,
        totalMonthlyAmountFormatted,
        featuresAmountCents,
        planAmountCents: planAmountCents ?? 0,
        usagePlanId: usagePlan?.id ?? null,
        usagePlanName: usagePlan?.name ?? null,
        usagePlanCode: usagePlan?.code ?? null,

        // Tokens
        monthlyTokens,
        usedTokensThisPeriod: usedTokens,
        usagePercent,

        // Emails
        monthlyEmails,
        usedEmailsThisPeriod: usedEmails,
        emailUsagePercent,

        // ✅ WhatsApp leads
        monthlyWhatsappLeads,
        usedWhatsappLeadsThisPeriod: usedWhatsappLeads,
        whatsappUsagePercent,

        periodStart: from,
        periodEnd: to,
        cancelAtPeriodEnd: cancelInfo.cancelAtPeriodEnd,
        cancelAtPeriodEndDate: cancelInfo.periodEnd
      });
    }

    const totalMonthlyAmountCents = subscriptions.reduce(
      (sum, s) => sum + (s.totalMonthlyAmountCents || 0),
      0
    );

    const currency =
      subscriptions[0]?.currency ??
      (subscriptions.length > 0
        ? subscriptions[0].currency
        : "eur");

    const totalMonthlyAmountFormatted = formatAmountForUi(
      totalMonthlyAmountCents,
      currency
    );

    // Payments history (most recent first)
    const payments = (await prisma.payment.findMany({
      where: {
        bot: { userId }
      },
      include: {
        bot: true
      },
      orderBy: { createdAt: "desc" },
      take: 50
    })) as unknown as PaymentWithBotLite[];

    const paymentSummaries = payments.map((p: PaymentWithBotLite) => ({
      id: p.id,
      botId: p.botId,
      botName: p.bot.name,
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      hasInvoice: !!p.stripeInvoiceId,
      kind: p.kind
    }));

    return res.json({
      subscriptions,
      totalMonthlyAmountCents,
      totalMonthlyAmountFormatted,
      payments: paymentSummaries
    });
  } catch (err: any) {
    console.error("Failed to fetch billing overview", err);
    return res
      .status(500)
      .json({ error: "Failed to load billing overview" });
  }
});

/**
 * GET /api/billing/payments/:id/invoice-url
 */
router.get("/billing/payments/:id/invoice-url", async (req, res) => {
  try {
    const userId = (req as any).user.id as string;

    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const paymentId = req.params.id;
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { bot: true }
    });

    if (!payment || (payment as any).bot.userId !== userId) {
      return res.status(404).json({ error: "Payment not found" });
    }

    if (!payment.stripeInvoiceId) {
      return res
        .status(400)
        .json({ error: "No Stripe invoice associated with this payment" });
    }

    const invoice = await stripe.invoices.retrieve(payment.stripeInvoiceId);
    const url =
      invoice.hosted_invoice_url || invoice.invoice_pdf || undefined;

    if (!url) {
      return res
        .status(400)
        .json({ error: "Invoice URL is not available for this payment" });
    }

    return res.json({ url });
  } catch (err: any) {
    console.error("Failed to fetch invoice URL", err);
    return res.status(500).json({ error: "Failed to load invoice URL" });
  }
});

/**
 * POST /api/bots/:id/pricing-preview
 * - Protected + bot access checked
 */
router.post("/bots/:id/pricing-preview", requireAuth, async (req, res) => {
  try {
    const botId = req.params.id;
    const user = (req as any).user as {
      id: string;
      role: "ADMIN" | "CLIENT" | "REFERRER" | "TEAM_MEMBER";
    };

    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    const canAccess = await userCanAccessBot(user, bot.id);
    if (!canAccess) return res.status(403).json({ error: "Forbidden" });

    const body = (req.body || {}) as Partial<{
      useDomainCrawler: boolean;
      usePdfCrawler: boolean;
      channelWeb: boolean;
      channelWhatsapp: boolean;
      channelMessenger: boolean;
      channelInstagram: boolean;
      useCalendar: boolean;
      leadWhatsappMessages200: boolean;
      leadWhatsappMessages500: boolean;
      leadWhatsappMessages1000: boolean;
    }>;

    const flags = {
      useDomainCrawler:
        typeof body.useDomainCrawler === "boolean"
          ? body.useDomainCrawler
          : bot.useDomainCrawler,
      usePdfCrawler:
        typeof body.usePdfCrawler === "boolean"
          ? body.usePdfCrawler
          : bot.usePdfCrawler,
      channelWeb:
        typeof body.channelWeb === "boolean" ? body.channelWeb : bot.channelWeb,
      channelWhatsapp:
        typeof body.channelWhatsapp === "boolean"
          ? body.channelWhatsapp
          : bot.channelWhatsapp,
      channelMessenger:
        typeof body.channelMessenger === "boolean"
          ? body.channelMessenger
          : bot.channelMessenger,
      channelInstagram:
        typeof body.channelInstagram === "boolean"
          ? body.channelInstagram
          : bot.channelInstagram,
      useCalendar:
        typeof body.useCalendar === "boolean" ? body.useCalendar : bot.useCalendar,
        leadWhatsappMessages200:
    typeof body.leadWhatsappMessages200 === "boolean"
      ? body.leadWhatsappMessages200
      : (bot as any).leadWhatsappMessages200,
    leadWhatsappMessages500:
    typeof body.leadWhatsappMessages500 === "boolean"
      ? body.leadWhatsappMessages500
      : (bot as any).leadWhatsappMessages500,
    leadWhatsappMessages1000:
    typeof body.leadWhatsappMessages1000 === "boolean"
      ? body.leadWhatsappMessages1000
      : (bot as any).leadWhatsappMessages1000
    };

    const pricing = await computeBotPricingForBot(botToFeatureFlags(flags));

    return res.json({
      lineItems: pricing.lineItemsForUi,
      totalAmountCents: pricing.totalAmountCents,
      totalAmountFormatted: pricing.totalAmountFormatted,
      currency: pricing.currency
    });
  } catch (err: any) {
    console.error("Failed to compute pricing preview", err);
    return res.status(500).json({ error: "Failed to compute pricing preview" });
  }
});

/**
 * GET /api/usage-plans
 * - Public list of active usage plans
 */
router.get("/usage-plans", async (_req, res) => {
  try {
    const plans = (await prisma.usagePlan.findMany({
      where: { isActive: true },
      orderBy: { monthlyAmountCents: "asc" }
    })) as unknown as UsagePlanLite[];

    return res.json(
      plans.map((p: UsagePlanLite) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        monthlyTokens: p.monthlyTokens,
        monthlyEmails: p.monthlyEmails,
        monthlyWhatsappLeads: p.monthlyWhatsappLeads,
        monthlyAmountCents: p.monthlyAmountCents,
        currency: p.currency,
        termPrices: listPlanTermPrices(p).map((tp) => ({
          billingTerm: tp.billingTerm,
          months: tp.months,
          amountCents: tp.amountCents,
          monthlyEquivalentAmountCents: tp.monthlyEquivalentAmountCents,
          currency: tp.currency
        })),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      }))
    );
  } catch (err: any) {
    console.error("Failed to fetch usage plans", err);
    return res.status(500).json({ error: "Failed to fetch usage plans" });
  }
});

/**
 * POST /api/bots/:id/activate-free
 * - Protected + ownership checked
 * - Activates a free plan without Stripe Checkout redirect
 */
router.post("/bots/:id/activate-free", requireAuth, async (req, res) => {
  try {
    const botId = req.params.id;
    const userId = (req as any).user.id as string;
    const { usagePlanId, billingTerm } = (req.body || {}) as {
      usagePlanId?: string;
      billingTerm?: BillingTerm;
    };

    if (!usagePlanId) {
      return res.status(400).json({ error: "usagePlanId is required" });
    }

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: {
        user: true,
        subscription: {
          include: { usagePlan: true }
        }
      }
    });

    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (bot.userId !== userId) return res.status(403).json({ error: "Forbidden" });

    const usagePlan = await prisma.usagePlan.findFirst({
      where: { id: usagePlanId, isActive: true }
    });
    if (!usagePlan) return res.status(404).json({ error: "Usage plan not found" });
    if (usagePlan.monthlyAmountCents !== 0) {
      return res
        .status(400)
        .json({ error: "activate-free is only allowed for free plans" });
    }
    if (bot.subscription?.usagePlan?.monthlyAmountCents) {
      return res.status(400).json({
        error: "Paid subscriptions cannot be downgraded to the free plan"
      });
    }

    const featurePricing = await computeBotPricingForBot(
      botToFeatureFlags({
        useDomainCrawler: bot.useDomainCrawler,
        usePdfCrawler: bot.usePdfCrawler,
        channelWeb: bot.channelWeb,
        channelWhatsapp: bot.channelWhatsapp,
        channelMessenger: bot.channelMessenger,
        channelInstagram: bot.channelInstagram,
        useCalendar: bot.useCalendar,
        leadWhatsappMessages200: (bot as any).leadWhatsappMessages200,
        leadWhatsappMessages500: (bot as any).leadWhatsappMessages500,
        leadWhatsappMessages1000: (bot as any).leadWhatsappMessages1000
      })
    );

    const monthlyTermPrice = getPlanTermPrice(usagePlan, "MONTHLY");
    const compactPlanSnapshot = buildCompactPlanSnapshot({
      featureCodes: featurePricing.featureCodes,
      usagePlan,
      billingTerm: "MONTHLY",
      termAmountCents: monthlyTermPrice.amountCents,
      monthlyEquivalentAmountCents:
        monthlyTermPrice.monthlyEquivalentAmountCents,
      currency: usagePlan.currency
    });
    const usageAnchorAt = new Date();

    if (bot.subscription) {
      await prisma.subscription.update({
        where: { id: bot.subscription.id },
        data: {
          usagePlanId: usagePlan.id,
          billingTerm: "MONTHLY",
          status: "ACTIVE",
          currency: usagePlan.currency,
          planSnapshotJson: compactPlanSnapshot,
          usageAnchorAt,
          pendingUsagePlanId: null,
          pendingBillingTerm: null,
          pendingSwitchAt: null
        }
      });
    } else {
      await prisma.subscription.create({
        data: {
          botId,
          stripeCustomerId: `free_${bot.userId}`,
          stripeSubscriptionId: `free_${bot.id}`,
          stripePriceId: "",
          billingTerm: "MONTHLY",
          status: "ACTIVE",
          currency: usagePlan.currency,
          planSnapshotJson: compactPlanSnapshot,
          usagePlanId: usagePlan.id,
          usageAnchorAt
        }
      });
    }

    await prisma.bot.update({
      where: { id: botId },
      data: { status: "ACTIVE" }
    });

    return res.json({ ok: true });
  } catch (err: any) {
    console.error("Error activating free plan:", err);
    return res.status(500).json({ error: "Failed to activate free plan" });
  }
});

/**
 * POST /api/bots/:id/checkout
 * - Protected + ownership checked
 * - Adds referralCode to Stripe metadata (cookie or body)
 */
router.post("/bots/:id/checkout", requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe is not configured" });

    const botId = req.params.id;
    const userId = (req as any).user.id as string;
    const { usagePlanId, billingTerm } = (req.body || {}) as {
      usagePlanId?: string;
      billingTerm?: BillingTerm | string;
    };

    if (!usagePlanId) return res.status(400).json({ error: "usagePlanId is required" });

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: { user: true }
    });
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (bot.userId !== userId) return res.status(403).json({ error: "Forbidden" });

    const usagePlan = await prisma.usagePlan.findFirst({
      where: { id: usagePlanId, isActive: true }
    });
    if (!usagePlan) return res.status(404).json({ error: "Usage plan not found" });
    if ((usagePlan.monthlyAmountCents ?? 0) === 0) {
      return res.status(400).json({
        error: "Use activate-free for free plans"
      });
    }

    const normalizedTerm = normalizeBillingTerm(billingTerm);
    const selectedTermPrice = getPlanTermPrice(usagePlan, normalizedTerm);
    if ((usagePlan.monthlyAmountCents ?? 0) > 0 && !selectedTermPrice.stripePriceId) {
      return res.status(500).json({
        error: `Usage plan ${usagePlan.code} has no Stripe price configured for ${normalizedTerm}`
      });
    }

    // Keep featureCodes for metadata/snapshot compatibility, but it costs 0 now.
    const featurePricing = await computeBotPricingForBot(
      botToFeatureFlags({
        useDomainCrawler: bot.useDomainCrawler,
        usePdfCrawler: bot.usePdfCrawler,
        channelWeb: bot.channelWeb,
        channelWhatsapp: bot.channelWhatsapp,
        channelMessenger: bot.channelMessenger,
        channelInstagram: bot.channelInstagram,
        useCalendar: bot.useCalendar,
        leadWhatsappMessages200: (bot as any).leadWhatsappMessages200,
        leadWhatsappMessages500: (bot as any).leadWhatsappMessages500,
        leadWhatsappMessages1000: (bot as any).leadWhatsappMessages1000
      })
    );

    // ✅ total is PLAN ONLY now
    const totalAmountCents = selectedTermPrice.amountCents;
    const monthlyEquivalentAmountCents =
      selectedTermPrice.monthlyEquivalentAmountCents;
    const currency = usagePlan.currency;

    // Referral attribution (cookie-first, optional body override)
    const rawReferral =
      (req.body?.referralCode as string | undefined) ||
      (req as any).cookies?.[REFERRAL_COOKIE_NAME];

    let referralCodeToApply: string | null = null;

    if (rawReferral) {
      const valid = await validateReferralCode(rawReferral);

      // Prevent self-referral
      if (valid && valid.partnerUserId !== bot.userId) {
        referralCodeToApply = valid.code;
      }
    }

    if (!referralCodeToApply && bot.user.referralCodeId) {
      const userReferral = await prisma.referralCode.findUnique({
        where: { id: bot.user.referralCodeId },
        include: { partner: true }
      });

      if (
        userReferral &&
        userReferral.isActive &&
        userReferral.partner.status === "ACTIVE" &&
        userReferral.partner.userId !== bot.userId
      ) {
        referralCodeToApply = userReferral.code;
      }
    }

    let stripeCustomerId: string | null = null;
    const existingSub = await prisma.subscription.findUnique({
      where: { botId }
    });
    if (existingSub) {
      stripeCustomerId = existingSub.stripeCustomerId;
    }

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: bot.user.email,
        metadata: { userId: bot.userId }
      });
      stripeCustomerId = customer.id;
    }

    await prisma.bot.update({
      where: { id: botId },
      data: { status: "PENDING_PAYMENT" }
    });

    const frontendOrigin =
      process.env.FRONTEND_ORIGIN || "http://localhost:3000";

    const lineItemsForStripe = [
      { price: selectedTermPrice.stripePriceId!, quantity: 1 }
    ];

    const compactPlanSnapshot = buildCompactPlanSnapshot({
      featureCodes: featurePricing.featureCodes,
      usagePlan,
      billingTerm: normalizedTerm,
      termAmountCents: selectedTermPrice.amountCents,
      monthlyEquivalentAmountCents,
      currency
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: lineItemsForStripe,
      success_url: `${frontendOrigin}/onboarding/bots/${bot.id}/knowledge?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendOrigin}/onboarding/bots/${bot.id}/plan?checkout=cancelled`,

      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      tax_id_collection: { enabled: true },

      metadata: {
        botId,
        userId: bot.userId,
        featureCodes: featurePricing.featureCodes.join(","),
        featureAmountCents: "0",
        planCode: usagePlan.code,
        planId: usagePlan.id,
        planAmountCents: String(usagePlan.monthlyAmountCents),
        billingTerm: normalizedTerm,
        billingTermMonths: String(selectedTermPrice.months),
        termAmountCents: String(selectedTermPrice.amountCents),
        monthlyEquivalentAmountCents: String(monthlyEquivalentAmountCents),
        totalAmountCents: String(totalAmountCents),
        currency,
        usagePlanId: usagePlan.id,
        planSnapshot: JSON.stringify(compactPlanSnapshot),

        referralCode: referralCodeToApply ?? ""
      },

      subscription_data: {
        metadata: {
          botId,
          userId: bot.userId,
          usagePlanId: usagePlan.id,
          billingTerm: normalizedTerm,
          referralCode: referralCodeToApply ?? ""
        }
      }
    });

    return res.json({ checkoutUrl: session.url });
  } catch (err: any) {
    console.error("Error starting checkout session:", err);
    return res.status(500).json({ error: "Unable to start checkout session" });
  }
});

/**
 * POST /api/bots/:id/cancel-subscription
 * - Protected + ownership checked
 */
router.post("/bots/:id/cancel-subscription", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const botId = req.params.id;
    const userId = (req as any).user.id as string;

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: { subscription: { include: { usagePlan: true } } }
    });

    if (!bot || bot.userId !== userId) {
      return res.status(404).json({ error: "Bot not found" });
    }

    if (!bot.subscription) {
      return res.status(400).json({ error: "No active subscription for this bot" });
    }

    const isFreePlan =
      (bot.subscription.usagePlan?.monthlyAmountCents ?? 0) === 0;
    if (isFreePlan || bot.subscription.stripeSubscriptionId.startsWith("free_")) {
      return res.status(400).json({ error: "Free plans cannot be canceled" });
    }

    const stripeSubscriptionId = bot.subscription.stripeSubscriptionId;

    const updatedStripeSub = await stripe.subscriptions.update(
      stripeSubscriptionId,
      {
        cancel_at_period_end: true,
        metadata: {
          botId: bot.id,
          userId: String(bot.userId),
          usagePlanId: bot.subscription.usagePlanId ?? ""
        }
      }
    );

    return res.json({
      ok: true,
      cancelAtPeriodEnd: !!updatedStripeSub.cancel_at_period_end,
      periodEnd: updatedStripeSub.current_period_end
        ? new Date(updatedStripeSub.current_period_end * 1000).toISOString()
        : null
    });
  } catch (err) {
    console.error("Error canceling subscription", err);
    return res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

/**
 * POST /api/bots/:id/change-plan
 */
router.post("/bots/:id/change-plan", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const botId = req.params.id;
    const userId = (req as any).user.id as string;
    const { usagePlanId, billingTerm, acknowledgeImmediateCharge } =
      (req.body || {}) as {
        usagePlanId?: string;
        billingTerm?: BillingTerm;
        acknowledgeImmediateCharge?: boolean;
      };

    if (!usagePlanId) {
      return res.status(400).json({ error: "usagePlanId is required" });
    }

    const bot = await prisma.bot.findFirst({
      where: { id: botId, userId },
      include: {
        subscription: {
          include: { usagePlan: true }
        }
      }
    });

    if (!bot || !bot.subscription) {
      return res.status(404).json({ error: "Bot or subscription not found" });
    }

    if (bot.status !== "ACTIVE") {
      return res.status(400).json({ error: "Bot must be ACTIVE to change plan" });
    }

    if (!bot.subscription.usagePlanId) {
      return res.status(400).json({
        error:
          "This subscription is not linked to a usage plan and cannot change using this endpoint."
      });
    }

    const targetPlan = await prisma.usagePlan.findFirst({
      where: { id: usagePlanId, isActive: true }
    });
    if (!targetPlan) {
      return res.status(404).json({ error: "Usage plan not found" });
    }

    const currentPlan = bot.subscription.usagePlan;
    const currentAmount = currentPlan?.monthlyAmountCents ?? 0;
    if (currentAmount > 0 && targetPlan.monthlyAmountCents === 0) {
      return res.status(400).json({
        error: "Paid subscriptions cannot be downgraded to the free plan"
      });
    }

    const currentTerm = normalizeBillingTerm(
      (bot.subscription as any).billingTerm
    ) as BillingTerm;
    const targetTerm = normalizeBillingTerm(billingTerm);
    const targetTermPrice = getPlanTermPrice(targetPlan, targetTerm);

    if ((targetPlan.monthlyAmountCents ?? 0) > 0 && !targetTermPrice.stripePriceId) {
      return res.status(400).json({
        error: `Selected billing term is not configured for ${targetPlan.name}`
      });
    }

    if (bot.subscription.usagePlanId === usagePlanId && currentTerm === targetTerm) {
      return res.json({ ok: true, unchanged: true });
    }

    if (bot.subscription.stripeSubscriptionId.startsWith("free_")) {
      return res.status(400).json({
        error:
          "This bot is on a free subscription. Use checkout to move to a paid term."
      });
    }

    const changeDirection = classifyPlanChange({
      currentMonthlyAmountCents: currentAmount,
      targetMonthlyAmountCents: targetPlan.monthlyAmountCents ?? 0,
      currentBillingTerm: currentTerm,
      targetBillingTerm: targetTerm
    });

    if (changeDirection === "UPGRADE") {
      if (!acknowledgeImmediateCharge) {
        return res.status(400).json({
          error:
            "You must acknowledge immediate full charge and forfeiture of unused prepaid time for upgrades."
        });
      }

      await updateBotSubscriptionForUsagePlanChange({
        botId: bot.id,
        newUsagePlanId: usagePlanId,
        billingTerm: targetTerm,
        prorationBehavior: "none",
        billingCycleAnchor: "now",
        resetUsageAnchor: true
      });

      const updatedSub = await prisma.subscription.findUnique({
        where: { id: bot.subscription.id },
        include: { usagePlan: true }
      });

      return res.json({
        ok: true,
        changeType: "UPGRADE_IMMEDIATE",
        chargedImmediately: true,
        subscription: updatedSub
      });
    }

    const stripeSub = await stripe.subscriptions.retrieve(
      bot.subscription.stripeSubscriptionId,
      { expand: ["items.data.price"] }
    );

    const items: Stripe.SubscriptionUpdateParams.Item[] = stripeSub.items.data.map(
      (item) => ({
        id: item.id,
        deleted: true
      })
    );
    items.push({ price: targetTermPrice.stripePriceId!, quantity: 1 });

    await stripe.subscriptions.update(bot.subscription.stripeSubscriptionId, {
      items,
      proration_behavior: "none",
      billing_cycle_anchor: "unchanged",
      metadata: {
        botId: bot.id,
        userId: String(bot.userId),
        usagePlanId: targetPlan.id,
        billingTerm: targetTerm,
        changeType: "DOWNGRADE_SCHEDULED"
      }
    });

    const effectiveAt = stripeSub.current_period_end
      ? new Date(stripeSub.current_period_end * 1000)
      : null;

    await prisma.subscription.update({
      where: { id: bot.subscription.id },
      data: {
        pendingUsagePlanId: targetPlan.id,
        pendingBillingTerm: targetTerm,
        pendingSwitchAt: effectiveAt
      }
    });

    const updatedSub = await prisma.subscription.findUnique({
      where: { id: bot.subscription.id },
      include: { usagePlan: true }
    });

    return res.json({
      ok: true,
      changeType: "DOWNGRADE_SCHEDULED",
      effectiveAt: effectiveAt ? effectiveAt.toISOString() : null,
      subscription: updatedSub
    });
  } catch (err) {
    console.error("Error changing usage plan", err);
    return res.status(500).json({ error: "Failed to change usage plan" });
  }
});


router.get("/bots/:id/topup-options", requireAuth, async (req, res) => {
  try {
    const botId = req.params.id;
    const userId = (req as any).user.id as string;

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: {
        subscription: {
          include: { usagePlan: true }
        }
      }
    });

    if (!bot || bot.userId !== userId) {
      return res.status(404).json({ error: "Bot not found" });
    }

    const sub = bot.subscription;
    const usagePlan = sub?.usagePlan ?? null;

    if (!sub || !usagePlan) {
      return res
        .status(400)
        .json({ error: "Bot has no active usage plan for top-ups" });
    }

    if (usagePlan.monthlyAmountCents <= 0) {
      return res.status(400).json({
        error: "Top-ups are not available for free plans"
      });
    }

    const baseMonthlyTokens = usagePlan.monthlyTokens ?? null;
    if (!baseMonthlyTokens || baseMonthlyTokens <= 0) {
      return res.status(400).json({
        error:
          "Top-ups are only available for plans with a monthly token limit"
      });
    }

    const planAmountCents: number = usagePlan.monthlyAmountCents;

    if (!planAmountCents || planAmountCents <= 0) {
      return res.status(400).json({
        error: "Top-ups are not available for this plan."
      });
    }

    const currency: string =
      sub.currency ||
      usagePlan.currency ||
      "eur";

    const rawOptions = [
      { code: "TOPUP_10", percentTokens: 10, percentPrice: 20 },
      { code: "TOPUP_20", percentTokens: 20, percentPrice: 30 },
      { code: "TOPUP_30", percentTokens: 30, percentPrice: 40 }
    ] as const;

    const options = rawOptions.map((opt) => {
      const extraTokens = Math.round(
        (baseMonthlyTokens * opt.percentTokens) / 100
      );
      const priceCents = Math.round(
        (planAmountCents * opt.percentPrice) / 100
      );

      return {
        code: opt.code,
        percentTokens: opt.percentTokens,
        percentPrice: opt.percentPrice,
        extraTokens,
        priceCents,
        priceFormatted: formatAmountForUi(priceCents, currency)
      };
    });

    const baseMonthlyAmountCents = planAmountCents;
    const baseMonthlyAmountFormatted = formatAmountForUi(
      baseMonthlyAmountCents,
      currency
    );

    return res.json({
      botId: bot.id,
      botName: bot.name,
      usagePlanName: usagePlan.name,
      currency,
      baseMonthlyTokens,
      baseMonthlyAmountCents,
      baseMonthlyAmountFormatted,
      options
    });
  } catch (err) {
    console.error("Failed to load top-up options", err);
    return res.status(500).json({ error: "Failed to load top-up options" });
  }
});



router.post("/bots/:id/topup-checkout", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(500)
        .json({ error: "Stripe is not configured" });
    }

    const botId = req.params.id;
    const userId = (req as any).user.id as string;
    const { optionCode } = (req.body || {}) as { optionCode?: string };

    if (!optionCode) {
      return res.status(400).json({ error: "optionCode is required" });
    }

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: {
        user: true,
        subscription: {
          include: { usagePlan: true }
        }
      }
    });

    if (!bot || bot.userId !== userId) {
      return res.status(404).json({ error: "Bot not found" });
    }

    const sub = bot.subscription;
    const usagePlan = sub?.usagePlan ?? null;

    if (!sub || !usagePlan) {
      return res
        .status(400)
        .json({ error: "Bot has no active usage plan for top-ups" });
    }

    if (usagePlan.monthlyAmountCents <= 0) {
      return res.status(400).json({
        error: "Top-ups are not available for free plans"
      });
    }

    const baseMonthlyTokens = usagePlan.monthlyTokens ?? null;
    if (!baseMonthlyTokens || baseMonthlyTokens <= 0) {
      return res.status(400).json({
        error:
          "Top-ups are only available for plans with a monthly token limit"
      });
    }

    const planAmountCents: number = usagePlan.monthlyAmountCents;

    if (!planAmountCents || planAmountCents <= 0) {
      return res.status(400).json({
        error: "Top-ups are not available for this plan."
      });
    }

    const currency: string =
      sub.currency ||
      usagePlan.currency ||
      "eur";

    const rawOptions = [
      { code: "TOPUP_10", percentTokens: 10, percentPrice: 20 },
      { code: "TOPUP_20", percentTokens: 20, percentPrice: 30 },
      { code: "TOPUP_30", percentTokens: 30, percentPrice: 40 }
    ] as const;

    const selected = rawOptions.find((o) => o.code === optionCode);
    if (!selected) {
      return res.status(400).json({ error: "Invalid top-up option" });
    }

    const extraTokens = Math.round(
      (baseMonthlyTokens * selected.percentTokens) / 100
    );
    const priceCents = Math.round(
      (planAmountCents * selected.percentPrice) / 100
    );

    // Reuse Stripe customer from subscription
    let stripeCustomerId = sub.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: bot.user.email,
        metadata: { userId: bot.userId }
      });
      stripeCustomerId = customer.id;

      await prisma.subscription.update({
        where: { id: sub.id },
        data: { stripeCustomerId }
      });
    }

    const frontendOrigin =
      process.env.FRONTEND_ORIGIN || "http://localhost:3000";

    // NOTE: adjust these URLs to whatever route renders your BillingPage
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: stripeCustomerId,
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: `Token top-up for ${bot.name}`
            },
            unit_amount: priceCents
          },
          quantity: 1
        }
      ],
      success_url: `${frontendOrigin}/app/billing?topup=success&bot=${bot.id}`,
      cancel_url: `${frontendOrigin}/app/billing?topup=cancelled&bot=${bot.id}`,

      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      tax_id_collection: { enabled: true },

      metadata: {
        kind: "TOP_UP",
        botId,
        userId: bot.userId,
        usagePlanId: usagePlan.id,
        topupCode: selected.code,
        topupPercentTokens: String(selected.percentTokens),
        topupPercentPrice: String(selected.percentPrice),
        topupTokens: String(extraTokens),
        topupPriceCents: String(priceCents)
      },

      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata: {
            kind: "TOP_UP",
            botId,
            userId: bot.userId,
            usagePlanId: usagePlan.id,
            topupCode: selected.code,
            topupPercentTokens: String(selected.percentTokens),
            topupPercentPrice: String(selected.percentPrice),
            topupTokens: String(extraTokens),
            topupPriceCents: String(priceCents)
          }
        }
      }
    });

    return res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("Error starting top-up checkout session:", err);
    return res
      .status(500)
      .json({ error: "Unable to start top-up checkout" });
  }
});



export default router;
