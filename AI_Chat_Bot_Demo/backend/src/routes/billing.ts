// routes/billing.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../prisma/prisma";
import { stripe, computeBotPricingForBot } from "../services/billingService";
import { config } from "../config";
import { getUsageForBot } from "../services/usageAggregationService"; // ⬅️ NEW

const router = Router();

function formatAmountForUi(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2
  }).format(amountCents / 100);
}

// Require auth for all billing routes
router.use(requireAuth);

// GET /api/billing/overview
router.get("/billing/overview", async (req, res) => {
  try {
    const userId = (req as any).user.id as string;

    // 1) Load all bots for this user with subscription + usage plan + user
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

    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const subscriptions: any[] = [];

    for (const bot of bots) {
      const sub = bot.subscription;
      if (!sub) continue;

      const usagePlan = sub.usagePlan ?? null;

      // 2) Usage for current month (tokens)
      const usage = await getUsageForBot({ bot, from, to });
      const usedTokens = usage.totalTokens;
      const monthlyTokens = usagePlan?.monthlyTokens ?? null;
      const usagePercent =
        monthlyTokens && monthlyTokens > 0
          ? Math.min(100, Math.round((usedTokens / monthlyTokens) * 100))
          : null;

      // 3) Money: derive from planSnapshotJson or recompute features if needed
      const snap: any = sub.planSnapshotJson ?? null;

      let featuresAmountCents: number | null =
        typeof snap?.fp === "number" ? snap.fp : null;
      let planAmountCents: number | null =
        typeof snap?.pt === "number"
          ? snap.pt
          : usagePlan?.monthlyAmountCents ?? null;
      let totalAmountCents: number | null =
        typeof snap?.t === "number" ? snap.t : null;
      let currency: string =
        (snap?.c as string | undefined) ||
        sub.currency ||
        usagePlan?.currency ||
        "eur";

      if (featuresAmountCents == null) {
        const pricing = await computeBotPricingForBot({
          useDomainCrawler: bot.useDomainCrawler,
          usePdfCrawler: bot.usePdfCrawler,
          channelWeb: bot.channelWeb,
          channelWhatsapp: bot.channelWhatsapp,
          channelMessenger: bot.channelMessenger,
          channelInstagram: bot.channelInstagram,
          useCalendar: bot.useCalendar
        });
        featuresAmountCents = pricing.totalAmountCents;
        currency = pricing.currency;
      }

      if (planAmountCents == null && usagePlan) {
        planAmountCents = usagePlan.monthlyAmountCents;
      }

      if (totalAmountCents == null) {
        totalAmountCents =
          (featuresAmountCents || 0) + (planAmountCents || 0);
      }

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
        featuresAmountCents: featuresAmountCents || 0,
        planAmountCents: planAmountCents || 0,
        usagePlanId: usagePlan?.id ?? null,
        usagePlanName: usagePlan?.name ?? null,
        usagePlanCode: usagePlan?.code ?? null,
        monthlyTokens,
        usedTokensThisPeriod: usedTokens,
        usagePercent,
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
      (subscriptions.length > 0 ? subscriptions[0].currency : "eur");

    const totalMonthlyAmountFormatted = formatAmountForUi(
      totalMonthlyAmountCents,
      currency
    );

    // 4) Payments history (most recent first)
    const payments = await prisma.payment.findMany({
      where: {
        bot: {
          userId
        }
      },
      include: {
        bot: true
      },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    const paymentSummaries = payments.map((p) => ({
      id: p.id,
      botId: p.botId,
      botName: p.bot.name,
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      hasInvoice: !!p.stripeInvoiceId
    }));

    return res.json({
      subscriptions,
      totalMonthlyAmountCents,
      totalMonthlyAmountFormatted,
      payments: paymentSummaries
    });
  } catch (err: any) {
    console.error("Failed to fetch billing overview", err);
    return res.status(500).json({ error: "Failed to load billing overview" });
  }
});


// GET /api/billing/payments/:id/invoice-url
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

    if (!payment || payment.bot.userId !== userId) {
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


router.post("/bots/:id/pricing-preview", async (req, res) => {
  try {
    const botId = req.params.id;
    const bot = await prisma.bot.findUnique({ where: { id: botId } });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found" });
    }

    const body = (req.body || {}) as Partial<{
      useDomainCrawler: boolean;
      usePdfCrawler: boolean;
      channelWeb: boolean;
      channelWhatsapp: boolean;
      channelMessenger: boolean;
      channelInstagram: boolean;
      useCalendar: boolean;
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
        typeof body.channelWeb === "boolean"
          ? body.channelWeb
          : bot.channelWeb,
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
        typeof body.useCalendar === "boolean"
          ? body.useCalendar
          : bot.useCalendar
    };

    const pricing = await computeBotPricingForBot(flags);

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

// NEW: list active usage plans for selection in frontend
router.get("/usage-plans", async (_req, res) => {
  try {
    const plans = await prisma.usagePlan.findMany({
      where: { isActive: true },
      orderBy: { monthlyAmountCents: "asc" }
    });

    return res.json(
      plans.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        monthlyTokens: p.monthlyTokens,
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

// Subscription checkout for bot (Stripe Checkout, subscription mode)
// Now requires a usagePlanId and charges: features + plan
router.post("/bots/:id/checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const botId = req.params.id;
    const { usagePlanId } = (req.body || {}) as { usagePlanId?: string };

    if (!usagePlanId) {
      return res.status(400).json({ error: "usagePlanId is required" });
    }

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: { user: true }
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found" });
    }

    const usagePlan = await prisma.usagePlan.findFirst({
      where: {
        id: usagePlanId,
        isActive: true
      }
    });

    if (!usagePlan) {
      return res.status(404).json({ error: "Usage plan not found" });
    }

    if (!usagePlan.stripePriceId) {
      return res.status(500).json({
        error: `Usage plan ${usagePlan.code} has no Stripe price configured`
      });
    }

    // Compute pricing based on currently stored feature flags (features-only)
    const featurePricing = await computeBotPricingForBot({
      useDomainCrawler: bot.useDomainCrawler,
      usePdfCrawler: bot.usePdfCrawler,
      channelWeb: bot.channelWeb,
      channelWhatsapp: bot.channelWhatsapp,
      channelMessenger: bot.channelMessenger,
      channelInstagram: bot.channelInstagram,
      useCalendar: bot.useCalendar
    });

    // Ensure currency matches between features and plan
    if (featurePricing.currency !== usagePlan.currency) {
      return res.status(500).json({
        error: `Currency mismatch between features (${featurePricing.currency}) and plan (${usagePlan.currency})`
      });
    }

    const totalAmountCents =
      featurePricing.totalAmountCents + usagePlan.monthlyAmountCents;
    const currency = featurePricing.currency;

    // Find or create Stripe customer for this bot/user
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
        metadata: {
          userId: bot.userId
        }
      });
      stripeCustomerId = customer.id;
    }

    // Mark bot as pending payment
    await prisma.bot.update({
      where: { id: botId },
      data: { status: "PENDING_PAYMENT" }
    });

    const frontendOrigin =
      process.env.FRONTEND_ORIGIN || "http://localhost:3000";

    // Compact snapshot for Stripe metadata (keep under 500 chars)
    const compactPlanSnapshot = {
      f: featurePricing.featureCodes,           // feature codes
      fp: featurePricing.totalAmountCents,      // features amount
      p: usagePlan.code,                        // plan code
      pt: usagePlan.monthlyAmountCents,         // plan amount
      t: totalAmountCents,                      // total (features + plan)
      c: currency                               // currency
    };

    const lineItemsForStripe = [
      ...featurePricing.lineItemsForStripe,
      {
        price: usagePlan.stripePriceId,
        quantity: 1
      }
    ];

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: lineItemsForStripe,
      success_url: `${frontendOrigin}/app/bots/${bot.id}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendOrigin}/app/bots/${bot.id}?checkout=cancelled`,

      // TAX & BILLING COLLECTION
      automatic_tax: {
        enabled: true
      },
      billing_address_collection: "required",
      customer_update: {
        address: "auto",
        name: "auto"
      },
      tax_id_collection: {
        enabled: true
      },

      metadata: {
        botId,
        userId: bot.userId,
        featureCodes: featurePricing.featureCodes.join(","),
        featureAmountCents: String(featurePricing.totalAmountCents),
        planCode: usagePlan.code,
        planId: usagePlan.id,
        planAmountCents: String(usagePlan.monthlyAmountCents),
        totalAmountCents: String(totalAmountCents),
        currency,
        usagePlanId: usagePlan.id,
        planSnapshot: JSON.stringify(compactPlanSnapshot)
      },
      subscription_data: {
        metadata: {
          botId,
          userId: bot.userId,
          usagePlanId: usagePlan.id
        }
      }
    });

    return res.json({ checkoutUrl: session.url });
  } catch (err: any) {
    console.error("Error starting checkout session:", err);
    return res
      .status(500)
      .json({ error: "Unable to start checkout session" });
  }
});

// POST /api/bots/:id/cancel-subscription
router.post("/bots/:id/cancel-subscription", async (req, res) => {
  try {
    const botId = req.params.id;
    const userId = (req as any).user.id;

    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: { subscription: true }
    });

    if (!bot || bot.userId !== userId) {
      return res.status(404).json({ error: "Bot not found" });
    }

    if (!bot.subscription) {
      return res
        .status(400)
        .json({ error: "No active subscription for this bot" });
    }

    const stripeSubscriptionId = bot.subscription.stripeSubscriptionId;

    // Cancel Stripe subscription immediately
    if (stripe) {
      try {
        await stripe.subscriptions.cancel(stripeSubscriptionId);
      } catch (err) {
        console.error("Error canceling Stripe subscription", err);
        // Even if Stripe fails, we still mark bot as canceled
      }
    }

    await prisma.subscription.update({
      where: { id: bot.subscription.id },
      data: {
        status: "CANCELED"
      }
    });

    const updatedBot = await prisma.bot.update({
      where: { id: botId },
      data: {
        status: "CANCELED"
      }
    });

    return res.json(updatedBot);
  } catch (err) {
    console.error("Error canceling subscription", err);
    return res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

export default router;
