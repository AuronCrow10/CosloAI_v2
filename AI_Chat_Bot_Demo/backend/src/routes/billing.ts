import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../prisma/prisma";
import { stripe, computeBotPricingForBot } from "../services/billingService";
import { config } from "../config";

const router = Router();

router.use("/bots/", requireAuth);

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

// Subscription checkout for bot (Stripe Checkout, subscription mode)
// POST /api/bots/:id/checkout
router.post("/bots/:id/checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    const botId = req.params.id;
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: { user: true }
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found" });
    }

    // Compute pricing based on currently stored feature flags
    const pricing = await computeBotPricingForBot({
      useDomainCrawler: bot.useDomainCrawler,
      usePdfCrawler: bot.usePdfCrawler,
      channelWeb: bot.channelWeb,
      channelWhatsapp: bot.channelWhatsapp,
      channelMessenger: bot.channelMessenger,
      channelInstagram: bot.channelInstagram,
      useCalendar: bot.useCalendar
    });

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

    // Optionally mark bot as pending payment
    await prisma.bot.update({
      where: { id: botId },
      data: { status: "PENDING_PAYMENT" }
    });

    const frontendOrigin =
      process.env.FRONTEND_ORIGIN || "http://localhost:3000";

    // Compact plan snapshot for Stripe metadata (keep under 500 chars)
    const compactPlanSnapshot = {
      f: pricing.featureCodes,         // feature codes
      t: pricing.totalAmountCents,     // total cents
      c: pricing.currency              // currency
    };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: pricing.lineItemsForStripe,
      success_url: `${frontendOrigin}/app/bots/${bot.id}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendOrigin}/app/bots/${bot.id}?checkout=cancelled`,

      // >>> TAX & BILLING COLLECTION <<<
      automatic_tax: {
        enabled: true
      },
      // Force user to enter full billing address on Checkout
      billing_address_collection: "required",
      // Save the address (and name) they enter back onto the Customer
      customer_update: {
        address: "auto",
        name: "auto"
      },
      // Optional but often useful if you want tax IDs (VAT, etc.)
      tax_id_collection: {
        enabled: true
      },

      metadata: {
        botId,
        userId: bot.userId,
        featureCodes: pricing.featureCodes.join(","),           // e.g. "CHANNEL_WEB,DOMAIN_CRAWLER"
        totalAmountCents: String(pricing.totalAmountCents),
        currency: pricing.currency,
        planSnapshot: JSON.stringify(compactPlanSnapshot)
      },
      subscription_data: {
        metadata: {
          botId,
          userId: bot.userId
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
      return res.status(400).json({ error: "No active subscription for this bot" });
    }

    const stripeSubscriptionId = bot.subscription.stripeSubscriptionId;

    // Cancella subito la subscription lato Stripe
    if (stripe) {
      try {
        await stripe.subscriptions.cancel(stripeSubscriptionId);
      } catch (err) {
        console.error("Error canceling Stripe subscription", err);
        // anche se Stripe fallisce, non facciamo rollback lato DB per evitare
        // di lasciare il bot attivo se pensiamo di averlo disattivato.
      }
    }

    // Aggiorna stato subscription & bot nel nostro DB
    const updatedSub = await prisma.subscription.update({
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

    // Da qui in poi il bot è DA CONSIDERARE non più utilizzabile in produzione
    // (chat, canali, ecc. devono verificare bot.status === "ACTIVE").

    return res.json(updatedBot);
  } catch (err) {
    console.error("Error canceling subscription", err);
    return res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

export default router;
