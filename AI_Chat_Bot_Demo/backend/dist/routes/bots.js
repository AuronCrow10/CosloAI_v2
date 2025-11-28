"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/bots.ts
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../prisma/prisma");
const auth_1 = require("../middleware/auth");
const billingService_1 = require("../services/billingService");
const router = (0, express_1.Router)();
// Default system prompt if none provided
const DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant for this business. Answer using only the provided context from the website and documents.";
const botCreateSchema = zod_1.z.object({
    slug: zod_1.z.string().regex(/^[a-z0-9-]+$/),
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional().nullable(),
    // now optional; we’ll fall back to DEFAULT_SYSTEM_PROMPT
    systemPrompt: zod_1.z.string().optional(),
    domain: zod_1.z.string().url().optional().nullable(),
    useDomainCrawler: zod_1.z.boolean().optional().default(false),
    usePdfCrawler: zod_1.z.boolean().optional().default(false),
    channelWeb: zod_1.z.boolean().optional().default(true),
    channelWhatsapp: zod_1.z.boolean().optional().default(false),
    channelInstagram: zod_1.z.boolean().optional().default(false),
    channelMessenger: zod_1.z.boolean().optional().default(false),
    useCalendar: zod_1.z.boolean().optional().default(false),
    calendarId: zod_1.z.string().optional().nullable(),
    timeZone: zod_1.z.string().optional().nullable(),
    defaultDurationMinutes: zod_1.z.number().int().positive().optional().nullable()
});
const botUpdateSchema = botCreateSchema.partial().omit({ slug: true });
// public info for a bot by slug (for widget/demo)
router.get("/bots/live/:slug", async (req, res) => {
    const { slug } = req.params;
    const bot = await prisma_1.prisma.bot.findFirst({
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
router.use("/bots/", auth_1.requireAuth);
// List bots
router.get("/bots", async (req, res) => {
    const bots = await prisma_1.prisma.bot.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: "desc" }
    });
    res.json(bots);
});
// Create bot
router.post("/bots", async (req, res) => {
    const parsed = botCreateSchema.safeParse(req.body);
    console.log(parsed);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const data = parsed.data;
    const existing = await prisma_1.prisma.bot.findUnique({ where: { slug: data.slug } });
    if (existing) {
        return res.status(400).json({ error: "Slug already in use" });
    }
    const bot = await prisma_1.prisma.bot.create({
        data: {
            userId: req.user.id,
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
            status: "DRAFT"
        }
    });
    // No crawl / knowledge client creation here: that happens from Content & Knowledge.
    res.status(201).json(bot);
});
// Get bot
router.get("/bots/:id", async (req, res) => {
    console.log("ciao");
    const bot = await prisma_1.prisma.bot.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    console.log(bot);
    if (!bot)
        return res.status(404).json({ error: "Not found" });
    res.json(bot);
});
// Update bot (features, basics, etc.)
router.patch("/bots/:id", async (req, res) => {
    const parsed = botUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const data = parsed.data;
    // Carichiamo il bot con la subscription (se esiste)
    const bot = await prisma_1.prisma.bot.findFirst({
        where: { id: req.params.id, userId: req.user.id },
        include: { subscription: true }
    });
    if (!bot)
        return res.status(404).json({ error: "Not found" });
    // Calcoliamo i flag di feature "nuovi" applicando i valori del body sopra quelli esistenti
    const nextFeatureFlags = {
        useDomainCrawler: typeof data.useDomainCrawler === "boolean"
            ? data.useDomainCrawler
            : bot.useDomainCrawler,
        usePdfCrawler: typeof data.usePdfCrawler === "boolean"
            ? data.usePdfCrawler
            : bot.usePdfCrawler,
        channelWeb: typeof data.channelWeb === "boolean" ? data.channelWeb : bot.channelWeb,
        channelWhatsapp: typeof data.channelWhatsapp === "boolean"
            ? data.channelWhatsapp
            : bot.channelWhatsapp,
        channelInstagram: typeof data.channelInstagram === "boolean"
            ? data.channelInstagram
            : bot.channelInstagram,
        channelMessenger: typeof data.channelMessenger === "boolean"
            ? data.channelMessenger
            : bot.channelMessenger,
        useCalendar: typeof data.useCalendar === "boolean"
            ? data.useCalendar
            : bot.useCalendar
    };
    const featuresChanged = nextFeatureFlags.useDomainCrawler !== bot.useDomainCrawler ||
        nextFeatureFlags.usePdfCrawler !== bot.usePdfCrawler ||
        nextFeatureFlags.channelWeb !== bot.channelWeb ||
        nextFeatureFlags.channelWhatsapp !== bot.channelWhatsapp ||
        nextFeatureFlags.channelInstagram !== bot.channelInstagram ||
        nextFeatureFlags.channelMessenger !== bot.channelMessenger ||
        nextFeatureFlags.useCalendar !== bot.useCalendar;
    // Se il bot è attivo e ha una subscription, e i flag sono cambiati,
    // aggiorniamo i prezzi su Stripe con proration.
    if (bot.subscription && bot.status === "ACTIVE" && featuresChanged) {
        try {
            await (0, billingService_1.updateBotSubscriptionForFeatureChange)({
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
            }, "create_prorations");
        }
        catch (err) {
            console.error("Failed to update Stripe subscription for feature change", err);
            return res.status(400).json({
                error: "Failed to update subscription pricing for these features. Your plan has not been changed."
            });
        }
    }
    // A questo punto Stripe è allineato (o non c'era subscription attiva),
    // possiamo salvare le modifiche del bot nel DB.
    const updated = await prisma_1.prisma.bot.update({
        where: { id: bot.id },
        data: {
            ...data
        }
    });
    // Note: no automatic crawl here either.
    res.json(updated);
});
// Delete bot (hard delete for now)
router.delete("/bots/:id", async (req, res) => {
    const bot = await prisma_1.prisma.bot.findFirst({
        where: { id: req.params.id, userId: req.user.id }
    });
    if (!bot)
        return res.status(404).json({ error: "Not found" });
    await prisma_1.prisma.bot.delete({ where: { id: bot.id } });
    res.status(204).send();
});
exports.default = router;
