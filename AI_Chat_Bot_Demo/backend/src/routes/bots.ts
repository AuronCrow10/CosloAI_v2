// src/routes/bots.ts
import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../prisma/prisma";
import { requireAuth } from "../middleware/auth";
import { listAccessibleBots } from "../services/teamAccessService";
import { updateBotSubscriptionForFeatureChange } from "../services/billingService";
import { deleteKnowledgeClient } from "../services/knowledgeClient";

const router = Router();

// Default system prompt if none provided
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant for this business. Answer using only the provided context from the website and documents.";

const bookingWeeklyScheduleSchema = z
  .record(
    z.enum([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday"
    ]),
    z.array(
      z.object({
        // "HH:MM" 24h format, e.g. "09:00"
        start: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "Must be in HH:MM 24h format"),
        end: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "Must be in HH:MM 24h format"),
        maxSimultaneousBookings: z.number().int().positive()
      })
    )
  )
  .optional()
  .nullable();

const bookingServiceSchema = z.object({
  key: z.string().min(1).optional(),
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  calendarId: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  maxSimultaneousBookings: z.number().int().positive().nullable().optional(),
  weeklySchedule: bookingWeeklyScheduleSchema
});

/**
 * CREATE schema
 * - All new booking-related fields are included.
 * - bookingRequiredFields is an optional *array*, not nullable → matches Prisma String[].
 */
const botCreateSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().optional().nullable(),

  // now optional; we’ll fall back to DEFAULT_SYSTEM_PROMPT
  systemPrompt: z.string().optional(),

  domain: z.string().url().optional().nullable(),

  knowledgeSource: z.enum(["RAG", "SHOPIFY"]).optional().default("RAG"),
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
  autoEvaluateConversations: z.boolean().optional().default(false),

  // --- NEW: Booking configuration fields ---

  // Min hours between "now" and booking start
  bookingMinLeadHours: z.number().int().min(0).optional(),

  // Max days in advance bookings are allowed
  bookingMaxAdvanceDays: z.number().int().min(0).optional(),

  bookingMaxSimultaneousBookings: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional(),

  // Reminder window & min lead
  bookingReminderWindowHours: z.number().int().min(0).optional(),
  bookingReminderMinLeadHours: z.number().int().min(0).optional(),

  // Email toggles
  bookingConfirmationEmailEnabled: z.boolean().optional(),
  bookingReminderEmailEnabled: z.boolean().optional(),

  // Email templates (subject + body)
  bookingConfirmationSubjectTemplate: z.string().max(200).optional().nullable(),
  bookingReminderSubjectTemplate: z.string().max(200).optional().nullable(),
  bookingCancellationSubjectTemplate: z.string().optional().nullable(), // NEW

  bookingConfirmationBodyTextTemplate: z.string().optional().nullable(),
  bookingReminderBodyTextTemplate: z.string().optional().nullable(),
  bookingCancellationBodyTextTemplate: z.string().optional().nullable(),

  bookingConfirmationBodyHtmlTemplate: z.string().optional().nullable(),
  bookingReminderBodyHtmlTemplate: z.string().optional().nullable(),
  bookingCancellationBodyHtmlTemplate: z.string().optional().nullable(),

  // Extra booking fields beyond the base ones (name, email, phone, service, datetime)
  // IMPORTANT: not nullable → matches Prisma String[].
  bookingRequiredFields: z.array(z.string()).optional(),

  bookingWeeklySchedule: bookingWeeklyScheduleSchema,

  bookingServices: z.array(bookingServiceSchema).optional(),

  leadWhatsappMessages200: z.boolean().optional().default(false),
  leadWhatsappMessages500: z.boolean().optional().default(false),
  leadWhatsappMessages1000: z.boolean().optional().default(false)
});

const botUpdateSchema = botCreateSchema.partial().omit({ slug: true });


const metaLeadAutomationSchema = z.object({
  phoneFieldName: z.string().min(1),
  consentFieldName: z.string().optional().nullable(),
  requiresWhatsappOptIn: z.boolean(),
  templateName: z.string().min(1),
  templateLanguage: z.string().min(1)
});

function slugifyServiceKey(input: string): string {
  const cleaned = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "service";
}

function normalizeBookingServices(
  services: Array<z.infer<typeof bookingServiceSchema>>
): Array<{
  key: string;
  name: string;
  aliases: string[];
  calendarId: string;
  durationMinutes: number;
  maxSimultaneousBookings: number | null;
  weeklySchedule: any | null;
}> {
  const keyCounts = new Map<string, number>();

  return services.map((raw) => {
    const name = raw.name.trim();
    const aliases =
      raw.aliases?.map((a) => a.trim()).filter((a) => a.length > 0) || [];
    const baseKey = slugifyServiceKey(raw.key?.trim() || name);
    const count = (keyCounts.get(baseKey) || 0) + 1;
    keyCounts.set(baseKey, count);
    const key = count === 1 ? baseKey : `${baseKey}-${count}`;

    return {
      key,
      name,
      aliases,
      calendarId: raw.calendarId.trim(),
      durationMinutes: raw.durationMinutes,
      maxSimultaneousBookings:
        typeof raw.maxSimultaneousBookings === "number"
          ? raw.maxSimultaneousBookings
          : null,
      weeklySchedule: raw.weeklySchedule ?? null
    };
  });
}

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
  const bots = await listAccessibleBots(req.user!);
  res.json(bots);
});

// Team members are restricted to bots list only
router.use("/bots/:id", (req: Request, res: Response, next) => {
  if (req.user?.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
});

// Create bot
router.post("/bots", async (req: Request, res: Response) => {
  if (req.user?.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }
  const parsed = botCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const data = parsed.data;
  const knowledgeSource = data.knowledgeSource ?? "RAG";

  const useDomainCrawler =
    knowledgeSource === "SHOPIFY" ? false : data.useDomainCrawler;
  const usePdfCrawler =
    knowledgeSource === "SHOPIFY" ? false : data.usePdfCrawler;

  const existing = await prisma.bot.findUnique({ where: { slug: data.slug } });
  if (existing) {
    return res.status(400).json({ error: "Slug already in use" });
  }

  let lead200 = data.leadWhatsappMessages200;
  let lead500 = data.leadWhatsappMessages500;
  let lead1000 = data.leadWhatsappMessages1000;

  if (!data.channelWhatsapp) {
    lead200 = false;
    lead500 = false;
    lead1000 = false;
  }

// Ensure at most one tier
const selectedCount = [lead200, lead500, lead1000].filter(Boolean).length;
if (selectedCount > 1) {
  return res.status(400).json({
    error: "Only one Lead Ads WhatsApp tier can be selected."
  });
}

  const bot = await prisma.bot.create({
    data: {
      userId: req.user!.id,
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      systemPrompt: data.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      knowledgeSource,
      knowledgeClientId: null, // <-- created later on first crawl/upload
      domain: data.domain ?? null,
      useDomainCrawler,
      usePdfCrawler,
      channelWeb: data.channelWeb,
      channelWhatsapp: data.channelWhatsapp,
      channelInstagram: data.channelInstagram,
      channelMessenger: data.channelMessenger,
      useCalendar: data.useCalendar,
      calendarId: data.calendarId ?? null,
      timeZone: data.timeZone ?? null,
      defaultDurationMinutes: data.defaultDurationMinutes ?? 30,
      status: "DRAFT",

      autoEvaluateConversations: data.autoEvaluateConversations,

      // --- NEW: booking config persisted on Bot ---

      bookingMinLeadHours: data.bookingMinLeadHours ?? null,
      bookingMaxAdvanceDays: data.bookingMaxAdvanceDays ?? null,
      bookingMaxSimultaneousBookings:
        data.bookingMaxSimultaneousBookings ?? null,
      bookingReminderWindowHours: data.bookingReminderWindowHours ?? null,
      bookingReminderMinLeadHours: data.bookingReminderMinLeadHours ?? null,

      bookingConfirmationEmailEnabled:
        typeof data.bookingConfirmationEmailEnabled === "boolean"
          ? data.bookingConfirmationEmailEnabled
          : true,
      bookingReminderEmailEnabled:
        typeof data.bookingReminderEmailEnabled === "boolean"
          ? data.bookingReminderEmailEnabled
          : true,

      bookingConfirmationSubjectTemplate:
        data.bookingConfirmationSubjectTemplate ?? null,
      bookingReminderSubjectTemplate:
        data.bookingReminderSubjectTemplate ?? null,

      bookingConfirmationBodyTextTemplate:
        data.bookingConfirmationBodyTextTemplate ?? null,
      bookingReminderBodyTextTemplate:
        data.bookingReminderBodyTextTemplate ?? null,

      bookingConfirmationBodyHtmlTemplate:
        data.bookingConfirmationBodyHtmlTemplate ?? null,
      bookingReminderBodyHtmlTemplate:
        data.bookingReminderBodyHtmlTemplate ?? null,

      // Stored as extra-required fields (base fields are always enforced in code)
      bookingRequiredFields: data.bookingRequiredFields ?? [],

      bookingWeeklySchedule: data.bookingWeeklySchedule ?? undefined,

      leadWhatsappMessages200: lead200,
      leadWhatsappMessages500: lead500,
      leadWhatsappMessages1000: lead1000,
    }
  });

  if (data.bookingServices && data.bookingServices.length > 0) {
    const normalized = normalizeBookingServices(data.bookingServices);
    await prisma.bookingService.createMany({
      data: normalized.map((s) => ({
        botId: bot.id,
        key: s.key,
        name: s.name,
        aliases: s.aliases,
        calendarId: s.calendarId,
        durationMinutes: s.durationMinutes,
        maxSimultaneousBookings: s.maxSimultaneousBookings,
        weeklySchedule: s.weeklySchedule
      }))
    });
  }

  res.status(201).json(bot);
});

// Update bot (features, basics, etc.)
router.patch("/bots/:id", async (req: Request, res: Response) => {
  if (req.user?.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }
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

  const nextKnowledgeSource =
    typeof data.knowledgeSource === "string"
      ? data.knowledgeSource
      : (bot as any).knowledgeSource ?? "RAG";

  const bookingServicesPayload = Array.isArray(
    (data as any).bookingServices
  )
    ? (data as any).bookingServices
    : undefined;


  let lead200 =
  typeof data.leadWhatsappMessages200 === "boolean"
    ? data.leadWhatsappMessages200
    : bot.leadWhatsappMessages200;

let lead500 =
  typeof data.leadWhatsappMessages500 === "boolean"
    ? data.leadWhatsappMessages500
    : bot.leadWhatsappMessages500;

let lead1000 =
  typeof data.leadWhatsappMessages1000 === "boolean"
    ? data.leadWhatsappMessages1000
    : bot.leadWhatsappMessages1000;

// If WhatsApp channel is off (next state), force tiers off
const nextChannelWhatsapp =
  typeof data.channelWhatsapp === "boolean"
    ? data.channelWhatsapp
    : bot.channelWhatsapp;

if (!nextChannelWhatsapp) {
  lead200 = false;
  lead500 = false;
  lead1000 = false;
}

// Ensure at most one tier
const selectedCount = [lead200, lead500, lead1000].filter(Boolean).length;
if (selectedCount > 1) {
  return res.status(400).json({
    error: "Only one Lead Ads WhatsApp tier can be selected."
  });
}

  // feature flags for pricing (unchanged)
  const nextFeatureFlags = {
    useDomainCrawler:
      nextKnowledgeSource === "SHOPIFY"
        ? false
        : typeof data.useDomainCrawler === "boolean"
        ? data.useDomainCrawler
        : bot.useDomainCrawler,
    usePdfCrawler:
      nextKnowledgeSource === "SHOPIFY"
        ? false
        : typeof data.usePdfCrawler === "boolean"
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
        : bot.useCalendar,
    leadWhatsappMessages200: lead200,
    leadWhatsappMessages500: lead500,
    leadWhatsappMessages1000: lead1000
  };

  const featuresChanged =
    nextFeatureFlags.useDomainCrawler !== bot.useDomainCrawler ||
    nextFeatureFlags.usePdfCrawler !== bot.usePdfCrawler ||
    nextFeatureFlags.channelWeb !== bot.channelWeb ||
    nextFeatureFlags.channelWhatsapp !== bot.channelWhatsapp ||
    nextFeatureFlags.channelInstagram !== bot.channelInstagram ||
    nextFeatureFlags.channelMessenger !== bot.channelMessenger ||
    nextFeatureFlags.useCalendar !== bot.useCalendar ||
    nextFeatureFlags.leadWhatsappMessages200 !== bot.leadWhatsappMessages200 ||
    nextFeatureFlags.leadWhatsappMessages500 !== bot.leadWhatsappMessages500 ||
    nextFeatureFlags.leadWhatsappMessages1000 !== bot.leadWhatsappMessages1000;

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
          leadWhatsappMessages200: nextFeatureFlags.leadWhatsappMessages200,
          leadWhatsappMessages500: nextFeatureFlags.leadWhatsappMessages500,
          leadWhatsappMessages1000: nextFeatureFlags.leadWhatsappMessages1000,
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

  // Build update data. We mostly spread `data`, which now has types that align
  // with Prisma, especially `bookingRequiredFields` (string[] | undefined).
  const updateData: any = {
    ...data,
    channelWhatsapp: nextChannelWhatsapp,
    leadWhatsappMessages200: lead200,
    leadWhatsappMessages500: lead500,
    leadWhatsappMessages1000: lead1000
  };

  if (nextKnowledgeSource === "SHOPIFY") {
    updateData.useDomainCrawler = false;
    updateData.usePdfCrawler = false;
  }

  delete updateData.bookingServices;

  // If client explicitly *omits* bookingRequiredFields, Prisma won't touch it.
  // If they provide [], we store [] (clears extra required fields).
  // No special null handling needed since Zod no longer allows null here.

  await prisma.$transaction(async (tx) => {
    if (bookingServicesPayload) {
      const normalized = normalizeBookingServices(bookingServicesPayload);
      await tx.bookingService.deleteMany({ where: { botId: bot.id } });
      if (normalized.length > 0) {
        await tx.bookingService.createMany({
          data: normalized.map((s) => ({
            botId: bot.id,
            key: s.key,
            name: s.name,
            aliases: s.aliases,
            calendarId: s.calendarId,
            durationMinutes: s.durationMinutes,
            maxSimultaneousBookings: s.maxSimultaneousBookings,
            weeklySchedule: s.weeklySchedule
          }))
        });
      }
    }

    await tx.bot.update({
      where: { id: bot.id },
      data: updateData
    });
  });

  const updated = await prisma.bot.findUnique({
    where: { id: bot.id },
    include: { bookingServices: true }
  });

  res.json(updated);
});

// Get bot
router.get("/bots/:id", async (req: Request, res: Response) => {
  if (req.user?.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }
  const bot = await prisma.bot.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: { bookingServices: true }
  });
  if (!bot) return res.status(404).json({ error: "Not found" });
  res.json(bot);
});

// Delete bot (hard delete with slug confirmation and full cascade)
router.delete("/bots/:id", async (req: Request, res: Response) => {
  if (req.user?.role === "TEAM_MEMBER") {
    return res.status(403).json({ error: "Forbidden" });
  }
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

    // Email usage
    await tx.emailUsage.deleteMany({ where: { botId: bot.id } });

    // Booking services
    await tx.bookingService.deleteMany({ where: { botId: bot.id } });

    // Finally the bot itself
    await tx.bot.delete({ where: { id: bot.id } });
  });

  return res.status(204).send();
});


// ---- Meta leads (Lead Ads → WhatsApp automation) ----

// Get current automation settings for a bot
router.get("/bots/:id/meta-leads/automation", async (req: Request, res: Response) => {
  const bot = await prisma.bot.findFirst({
    where: { id: req.params.id, userId: req.user!.id }
  });

  if (!bot) {
    return res.status(404).json({ error: "Not found" });
  }

  const automation = await prisma.metaLeadAutomation.findFirst({
    where: {
      botId: bot.id,
      enabled: true
    },
    orderBy: { createdAt: "desc" }
  });

  if (!automation) {
    // Frontend expects `null` when nothing is configured
    return res.json(null);
  }

  return res.json({
    phoneFieldName: automation.phoneFieldName || "phone_number",
    consentFieldName: automation.consentFieldName ?? "",
    requiresWhatsappOptIn: automation.requiresWhatsappOptIn,
    templateName: automation.whatsappTemplateName,
    templateLanguage: automation.whatsappTemplateLanguage
  });
});

// Create/update automation settings for a bot
router.put("/bots/:id/meta-leads/automation", async (req: Request, res: Response) => {
  const parsed = metaLeadAutomationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const {
    phoneFieldName,
    consentFieldName,
    requiresWhatsappOptIn,
    templateName,
    templateLanguage
  } = parsed.data;

  const bot = await prisma.bot.findFirst({
    where: { id: req.params.id, userId: req.user!.id }
  });

  if (!bot) {
    return res.status(404).json({ error: "Not found" });
  }

  // Require at least one connected Facebook page, otherwise we don't know which pageId to bind to.
  const fbChannel = await prisma.botChannel.findFirst({
    where: { botId: bot.id, type: "FACEBOOK" }
  });

  if (!fbChannel) {
    return res.status(400).json({
      error: "FACEBOOK_PAGE_NOT_CONNECTED",
      message: "Connect a Facebook page before configuring Lead Ads automation."
    });
  }

  const pageId = fbChannel.externalId;
  const formId = "*"; // single global config per page for now

  // Use the composite unique key @@unique([botId, pageId, formId], name: "bot_page_form")
  const automation = await prisma.metaLeadAutomation.upsert({
    where: {
      bot_page_form: {
        botId: bot.id,
        pageId,
        formId
      }
    },
    update: {
      enabled: true,
      phoneFieldName,
      consentFieldName: consentFieldName && consentFieldName.trim() ? consentFieldName : null,
      requiresWhatsappOptIn,
      whatsappTemplateName: templateName,
      whatsappTemplateLanguage: templateLanguage
    },
    create: {
      botId: bot.id,
      pageId,
      formId,
      enabled: true,
      phoneFieldName,
      consentFieldName: consentFieldName && consentFieldName.trim() ? consentFieldName : null,
      requiresWhatsappOptIn,
      whatsappTemplateName: templateName,
      whatsappTemplateLanguage: templateLanguage
    }
  });

  return res.json({
    phoneFieldName: automation.phoneFieldName || "phone_number",
    consentFieldName: automation.consentFieldName ?? "",
    requiresWhatsappOptIn: automation.requiresWhatsappOptIn,
    templateName: automation.whatsappTemplateName,
    templateLanguage: automation.whatsappTemplateLanguage
  });
});

// List recent Meta leads for a bot
router.get("/bots/:id/meta-leads", async (req: Request, res: Response) => {
  const bot = await prisma.bot.findFirst({
    where: { id: req.params.id, userId: req.user!.id }
  });

  if (!bot) {
    return res.status(404).json({ error: "Not found" });
  }

  let limit = 50;
  const rawLimit = req.query.limit;
  if (typeof rawLimit === "string") {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 200) {
      limit = parsed;
    }
  }

  const leads = await prisma.metaLead.findMany({
    where: { botId: bot.id },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      pageId: true,
      leadgenId: true,
      formId: true,
      phone: true,
      whatsappStatus: true,
      whatsappError: true
    }
  });

  return res.json({ items: leads });
});

export default router;
