"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/botKnowledge.ts
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const prisma_1 = require("../prisma/prisma");
const auth_1 = require("../middleware/auth");
const knowledgeClient_1 = require("../services/knowledgeClient");
const router = (0, express_1.Router)();
// For PDF uploads
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024 // 20 MB
    }
});
// Make all routes here auth-protected
router.use("/bots", auth_1.requireAuth);
// Small helper to load bot & ensure it belongs to current user
async function getUserBot(botId, userId) {
    const bot = await prisma_1.prisma.bot.findFirst({
        where: { id: botId, userId }
    });
    return bot;
}
// Ensure knowledgeClientId exists; create if needed
// NOW also enforces: bot.status must be ACTIVE
async function ensureKnowledgeClient(botId, userId) {
    const bot = await getUserBot(botId, userId);
    if (!bot) {
        throw new Error("BOT_NOT_FOUND");
    }
    if (bot.status !== "ACTIVE") {
        // Backend guard: only active bots can use knowledge operations
        throw new Error("BOT_NOT_ACTIVE");
    }
    if (bot.knowledgeClientId) {
        return { bot, knowledgeClientId: bot.knowledgeClientId };
    }
    // Create new client in knowledge backend
    const kc = await (0, knowledgeClient_1.createKnowledgeClient)({
        name: `${bot.userId}-${bot.slug}`,
        domain: bot.domain ?? undefined
    });
    const updated = await prisma_1.prisma.bot.update({
        where: { id: bot.id },
        data: { knowledgeClientId: kc.client.id }
    });
    return { bot: updated, knowledgeClientId: kc.client.id };
}
/**
 * POST /api/bots/:id/knowledge/crawl-domain
 * Body: { domain?: string }
 *
 * Uses bot.domain by default, can be overridden in body.
 */
router.post("/bots/:id/knowledge/crawl-domain", async (req, res) => {
    try {
        const botId = req.params.id;
        const userId = req.user.id;
        const overrideDomain = req.body?.domain;
        const { bot, knowledgeClientId } = await ensureKnowledgeClient(botId, userId);
        const domainToUse = overrideDomain || bot.domain;
        if (!domainToUse) {
            return res
                .status(400)
                .json({ error: "No domain configured for this bot" });
        }
        await (0, knowledgeClient_1.crawlDomain)({
            clientId: knowledgeClientId,
            domain: domainToUse
        });
        return res.json({
            status: "ok",
            knowledgeClientId,
            domain: domainToUse
        });
    }
    catch (err) {
        console.error("Error in /bots/:id/knowledge/crawl-domain", err);
        if (err instanceof Error) {
            if (err.message === "BOT_NOT_FOUND") {
                return res.status(404).json({ error: "Bot not found" });
            }
            if (err.message === "BOT_NOT_ACTIVE") {
                return res
                    .status(400)
                    .json({ error: "Bot must be active before crawling knowledge." });
            }
        }
        return res.status(500).json({ error: "Internal server error" });
    }
});
/**
 * POST /api/bots/:id/knowledge/upload-docs
 * multipart/form-data with field: files[]
 */
router.post("/bots/:id/knowledge/upload-docs", upload.array("files", 10), async (req, res) => {
    try {
        const botId = req.params.id;
        const userId = req.user.id;
        const { knowledgeClientId } = await ensureKnowledgeClient(botId, userId);
        const files = req.files;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No files uploaded" });
        }
        await (0, knowledgeClient_1.ingestDocs)({
            clientId: knowledgeClientId,
            files
        });
        return res.json({
            status: "ok",
            knowledgeClientId,
            files: files.map((f) => f.originalname)
        });
    }
    catch (err) {
        console.error("Error in /bots/:id/knowledge/upload-docs", err);
        if (err instanceof Error) {
            if (err.message === "BOT_NOT_FOUND") {
                return res.status(404).json({ error: "Bot not found" });
            }
            if (err.message === "BOT_NOT_ACTIVE") {
                return res
                    .status(400)
                    .json({ error: "Bot must be active before uploading documents." });
            }
        }
        return res.status(500).json({ error: "Internal server error" });
    }
});
exports.default = router;
