import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../prisma/prisma";
import {
  stripe,
  computeBotPricingForBot,
  updateBotSubscriptionForUsagePlanChange,
  botToFeatureFlags
} from "../services/billingService";
import { getPlanUsageForBot } from "../services/planUsageService";
import { getEmailUsageForBot } from "../services/emailUsageService";

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
  monthlyAmountCents: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
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

function getCurrentCalendarMonthRange(): { from: Date; to: Date } {
  const now = new Date();
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  return { from, to };
}

async function getCurrentBillingPeriodRangeForBot(
  botId: string
): Promise<{ from: Date; to: Date } | null> {
  const payment = await prisma.payment.findFirst({
    where: {
      botId,
      kind: "SUBSCRIPTION",
      status: "paid",
      periodStart: { not: null },
      periodEnd: { not: null }
    },
    orderBy: { periodStart: "desc" }
  });

  if (!payment?.periodStart || !payment?.periodEnd) {
    return null;
  }

  return { from: payment.periodStart, to: payment.periodEnd };
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

    for (const bot of bots) {
      const sub = bot.subscription;
      if (!sub) continue;

      const usagePlan = sub.usagePlan ?? null;

      const billingRange =
        (await getCurrentBillingPeriodRangeForBot(bot.id)) ??
        getCurrentCalendarMonthRange();
      const { from, to } = billingRange;

// Canonical plan usage snapshot (includes OpenAI + knowledge + emails + WhatsApp,
// and already accounts for paid top-ups in the token limit)
      const planUsage = await getPlanUsageForBot(bot.id);

      const usedTokens = planUsage?.usedTokensTotal ?? 0; 

// If snapshot has a limit, prefer that; otherwise fall back to the raw plan
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

      const totalAmountCents = planAmountCents ?? 0;

      const totalMonthlyAmountCents = totalAmountCents || 0;
      const totalMonthlyAmountFormatted = formatAmountForUi(
        totalMonthlyAmountCents,
        currency
      );

      subscriptions.push({
        botId: bot.id,
        botName: bot.name,
        botSlug: bot.slug,
        botStatus: bot.status,
        subscriptionStatus: sub.status,
        currency,
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
        periodEnd: to
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
 * - Protected + ownership checked
 */
router.post("/bots/:id/pricing-preview", requireAuth, async (req, res) => {
  try {
    const botId = req.params.id;
    const userId = (req as any).user.id as string;

    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (bot.userId !== userId) return res.status(403).json({ error: "Forbidden" });

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
        monthlyAmountCents: p.monthlyAmountCents,
        currency: p.currency,
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
    const { usagePlanId } = (req.body || {}) as { usagePlanId?: string };

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

    const compactPlanSnapshot = {
      f: featurePricing.featureCodes,
      fp: 0,
      p: usagePlan.code,
      pt: usagePlan.monthlyAmountCents,
      t: usagePlan.monthlyAmountCents,
      c: usagePlan.currency
    };

    if (bot.subscription) {
      await prisma.subscription.update({
        where: { id: bot.subscription.id },
        data: {
          usagePlanId: usagePlan.id,
          status: "ACTIVE",
          currency: usagePlan.currency,
          planSnapshotJson: compactPlanSnapshot
        }
      });
    } else {
      await prisma.subscription.create({
        data: {
          botId,
          stripeCustomerId: `free_${bot.userId}`,
          stripeSubscriptionId: `free_${bot.id}`,
          stripePriceId: "",
          status: "ACTIVE",
          currency: usagePlan.currency,
          planSnapshotJson: compactPlanSnapshot,
          usagePlanId: usagePlan.id
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
    const { usagePlanId } = (req.body || {}) as { usagePlanId?: string };

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
    if (!usagePlan.stripePriceId) {
      return res.status(500).json({ error: `Usage plan ${usagePlan.code} has no Stripe price configured` });
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
    const totalAmountCents = usagePlan.monthlyAmountCents;
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

    const lineItemsForStripe = [{ price: usagePlan.stripePriceId, quantity: 1 }];

    const compactPlanSnapshot = {
      f: featurePricing.featureCodes,
      fp: 0,
      p: usagePlan.code,
      pt: usagePlan.monthlyAmountCents,
      t: totalAmountCents,
      c: currency
    };

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
    const botId = req.params.id;
    const userId = (req as any).user.id as string;

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: { subscription: true }
    });

    if (!bot || bot.userId !== userId) {
      return res.status(404).json({ error: "Bot not found" });
    }

    if (!bot.subscription) {
      return res.status(400).json({ error: "No active subscription for this bot" });
    }

    const stripeSubscriptionId = bot.subscription.stripeSubscriptionId;

    if (stripe) {
      try {
        await stripe.subscriptions.cancel(stripeSubscriptionId);
      } catch (err) {
        console.error("Error canceling Stripe subscription", err);
      }
    }

    await prisma.subscription.update({
      where: { id: bot.subscription.id },
      data: { status: "CANCELED" }
    });

    const updatedBot = await prisma.bot.update({
      where: { id: botId },
      data: { status: "CANCELED" }
    });

    return res.json(updatedBot);
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
    const { usagePlanId } = (req.body || {}) as { usagePlanId?: string };

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

    if (bot.subscription.usagePlanId === usagePlanId) {
      return res.json({ ok: true, unchanged: true });
    }

    const targetPlan = await prisma.usagePlan.findFirst({
      where: { id: usagePlanId, isActive: true }
    });
    if (!targetPlan) {
      return res.status(404).json({ error: "Usage plan not found" });
    }

    const currentAmount = bot.subscription.usagePlan?.monthlyAmountCents ?? 0;
    if (currentAmount > 0 && targetPlan.monthlyAmountCents === 0) {
      return res.status(400).json({
        error: "Paid subscriptions cannot be downgraded to the free plan"
      });
    }

    await updateBotSubscriptionForUsagePlanChange({
      botId: bot.id,
      newUsagePlanId: usagePlanId,
      prorationBehavior: "create_prorations"
    });

    const updatedSub = await prisma.subscription.findUnique({
      where: { id: bot.subscription.id },
      include: { usagePlan: true }
    });

    return res.json({ ok: true, subscription: updatedSub });
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

    const snap: any = sub.planSnapshotJson ?? null;

    let planAmountCents: number | null =
      typeof snap?.pt === "number"
        ? snap.pt
        : usagePlan.monthlyAmountCents ?? null;

    if (planAmountCents == null) {
      planAmountCents = usagePlan.monthlyAmountCents;
    }

    if (!planAmountCents || planAmountCents <= 0) {
      return res.status(400).json({
        error: "Top-ups are not available for this plan."
      });
    }

    const currency: string =
      (snap?.c as string | undefined) ||
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
        (planAmountCents! * opt.percentPrice) / 100
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

    const baseMonthlyAmountCents = planAmountCents!;
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

    const snap: any = sub.planSnapshotJson ?? null;

    let planAmountCents: number | null =
      typeof snap?.pt === "number"
        ? snap.pt
        : usagePlan.monthlyAmountCents ?? null;

    if (planAmountCents == null) {
      planAmountCents = usagePlan.monthlyAmountCents;
    }

    if (!planAmountCents || planAmountCents <= 0) {
      return res.status(400).json({
        error: "Top-ups are not available for this plan."
      });
    }

    const currency: string =
      (snap?.c as string | undefined) ||
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
      (planAmountCents! * selected.percentPrice) / 100
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
