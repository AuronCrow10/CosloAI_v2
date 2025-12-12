// src/routes/bots.ts
import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import { updateBotSubscriptionForFeatureChange } from "../services/billingService";
import { deleteKnowledgeClient } from "../services/knowledgeClient";

const router = Router();

// Default system prompt if none provided
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant for this business. Answer using only the provided context from the website and documents.";

const botCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().optional().nullable(),

  // now optional; we’ll fall back to DEFAULT_SYSTEM_PROMPT
  systemPrompt: z.string().optional(),

  domain: z.string().url().optional().nullable(),

  useDomainCrawler: z.boolean().optional().default(false),
  usePdfCrawler: z.boolean().optional().default(false),
  channelWeb: z.boolean().optional().default(true),
  channelWhatsapp: z.boolean().optional().default(false),
  channelInstagram: z.boolean().optional().default(false),
  channelMessenger: z.boolean().optional().default(false),
  useCalendar: z.boolean().optional().default(false),

  calendarId: z.string().optional().nullable(),
  timeZone: z.string().optional().nullable(),
  defaultDurationMinutes: z.number().int().positive().optional().nullable(),

  // NEW: per-bot toggle for automatic conversation evaluation
  autoEvaluateConversations: z.boolean().optional().default(false)
});

const botUpdateSchema = botCreateSchema.partial().omit({ slug: true });

// public info for a bot by slug (for widget/demo)
router.get("/bots/live/:slug", async (req, res) => {
  const { slug } = req.params;

  const bot = await prisma.bot.findFirst({
    where: {
      slug,
      status: "ACTIVE", // only active bots
      channelWeb: true // only bots with web channel enabled
    },
    select: {
      slug: true,
      name: true,
      description: true
    }
  });

  if (!bot) {
    return res.status(404).json({ error: "Not found" });
  }

  res.json(bot);
});

router.use("/bots/", requireAuth);

// List bots
router.get("/bots", async (req: Request, res: Response) => {
  const bots = await prisma.bot.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" }
  });
  res.json(bots);
});

// Create bot
router.post("/bots", async (req: Request, res: Response) => {
  const parsed = botCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const data = parsed.data;

  const existing = await prisma.bot.findUnique({ where: { slug: data.slug } });
  if (existing) {
    return res.status(400).json({ error: "Slug already in use" });
  }

  const bot = await prisma.bot.create({
    data: {
      userId: req.user!.id,
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      systemPrompt: data.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      knowledgeClientId: null, // <-- created later on first crawl/upload
      domain: data.domain ?? null,
      useDomainCrawler: data.useDomainCrawler,
      usePdfCrawler: data.usePdfCrawler,
      channelWeb: data.channelWeb,
      channelWhatsapp: data.channelWhatsapp,
      channelInstagram: data.channelInstagram,
      channelMessenger: data.channelMessenger,
      useCalendar: data.useCalendar,
      calendarId: data.calendarId ?? null,
      timeZone: data.timeZone ?? null,
      defaultDurationMinutes: data.defaultDurationMinutes ?? 30,
      status: "DRAFT",

      autoEvaluateConversations: data.autoEvaluateConversations
    }
  });

  res.status(201).json(bot);
});

// Update bot (features, basics, etc.)
router.patch("/bots/:id", async (req: Request, res: Response) => {
  const parsed = botUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const data = parsed.data;

  // load bot with subscription (if any)
  const bot = await prisma.bot.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: { subscription: true }
  });
  if (!bot) return res.status(404).json({ error: "Not found" });

  // feature flags for pricing (unchanged)
  const nextFeatureFlags = {
    useDomainCrawler:
      typeof data.useDomainCrawler === "boolean"
        ? data.useDomainCrawler
        : bot.useDomainCrawler,
    usePdfCrawler:
      typeof data.usePdfCrawler === "boolean"
        ? data.usePdfCrawler
        : bot.usePdfCrawler,
    channelWeb:
      typeof data.channelWeb === "boolean" ? data.channelWeb : bot.channelWeb,
    channelWhatsapp:
      typeof data.channelWhatsapp === "boolean"
        ? data.channelWhatsapp
        : bot.channelWhatsapp,
    channelInstagram:
      typeof data.channelInstagram === "boolean"
        ? data.channelInstagram
        : bot.channelInstagram,
    channelMessenger:
      typeof data.channelMessenger === "boolean"
        ? data.channelMessenger
        : bot.channelMessenger,
    useCalendar:
      typeof data.useCalendar === "boolean"
        ? data.useCalendar
        : bot.useCalendar
  };

  const featuresChanged =
    nextFeatureFlags.useDomainCrawler !== bot.useDomainCrawler ||
    nextFeatureFlags.usePdfCrawler !== bot.usePdfCrawler ||
    nextFeatureFlags.channelWeb !== bot.channelWeb ||
    nextFeatureFlags.channelWhatsapp !== bot.channelWhatsapp ||
    nextFeatureFlags.channelInstagram !== bot.channelInstagram ||
    nextFeatureFlags.channelMessenger !== bot.channelMessenger ||
    nextFeatureFlags.useCalendar !== bot.useCalendar;

  if (bot.subscription && bot.status === "ACTIVE" && featuresChanged) {
    try {
      await updateBotSubscriptionForFeatureChange(
        {
          id: bot.id,
          userId: bot.userId,
          useDomainCrawler: nextFeatureFlags.useDomainCrawler,
          usePdfCrawler: nextFeatureFlags.usePdfCrawler,
          channelWeb: nextFeatureFlags.channelWeb,
          channelWhatsapp: nextFeatureFlags.channelWhatsapp,
          channelMessenger: nextFeatureFlags.channelMessenger,
          channelInstagram: nextFeatureFlags.channelInstagram,
          useCalendar: nextFeatureFlags.useCalendar,
          subscription: {
            id: bot.subscription.id,
            stripeSubscriptionId: bot.subscription.stripeSubscriptionId
          }
        },
        "create_prorations"
      );
    } catch (err) {
      console.error(
        "Failed to update Stripe subscription for feature change",
        err
      );
      return res.status(400).json({
        error:
          "Failed to update subscription pricing for these features. Your plan has not been changed."
      });
    }
  }

  const updated = await prisma.bot.update({
    where: { id: bot.id },
    data: {
      ...data
    }
  });

  res.json(updated);
});

// Get bot
router.get("/bots/:id", async (req: Request, res: Response) => {
  console.log("ciao");
  const bot = await prisma.bot.findFirst({
    where: { id: req.params.id, userId: req.user!.id }
  });
  console.log(bot);
  if (!bot) return res.status(404).json({ error: "Not found" });
  res.json(bot);
});


// Delete bot (hard delete with slug confirmation and full cascade)
router.delete("/bots/:id", async (req: Request, res: Response) => {
  const { slug } = req.body as { slug?: string };

  if (!slug) {
    return res.status(400).json({ error: "Slug is required for deletion." });
  }

  const bot = await prisma.bot.findFirst({
    where: { id: req.params.id, userId: req.user!.id }
  });
  if (!bot) return res.status(404).json({ error: "Not found" });

  if (slug !== bot.slug) {
    return res.status(400).json({ error: "Slug does not match this bot." });
  }

  // 1) Delete knowledge client (if any) in knowledge backend
  if (bot.knowledgeClientId) {
    try {
      await deleteKnowledgeClient(bot.knowledgeClientId);
    } catch (err) {
      console.error(
        `Failed to delete knowledge client for bot ${bot.id} (${bot.knowledgeClientId})`,
        err
      );
      return res
        .status(500)
        .json({ error: "Failed to delete bot knowledge data." });
    }
  }

  // 2) Delete all bot-related data in a transaction
  await prisma.$transaction(async (tx) => {
    // Messages -> Conversations
    await tx.message.deleteMany({
      where: {
        conversation: { botId: bot.id }
      }
    });
    await tx.conversation.deleteMany({ where: { botId: bot.id } });

    // Channels
    await tx.botChannel.deleteMany({ where: { botId: bot.id } });

    // Billing / payments / subscriptions
    await tx.payment.deleteMany({ where: { botId: bot.id } });
    await tx.subscription.deleteMany({ where: { botId: bot.id } });

    // Meta & WhatsApp sessions
    await tx.metaConnectSession.deleteMany({ where: { botId: bot.id } });
    await tx.whatsappConnectSession.deleteMany({ where: { botId: bot.id } });

    // Usage
    await tx.openAIUsage.deleteMany({ where: { botId: bot.id } });

    // Finally the bot itself
    await tx.bot.delete({ where: { id: bot.id } });
  });

  return res.status(204).send();
});

export default router;
