"use strict";
// routes/chat.ts
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const uuid_1 = require("uuid");
const chatService_1 = require("../services/chatService");
const config_1 = require("../bots/config");
const prisma_1 = require("../prisma/prisma");
const conversationService_1 = require("../services/conversationService");
const router = (0, express_1.Router)();
function isValidSlug(slug) {
    return /^[a-z0-9-]+$/.test(slug);
}
// POST /api/chat/:slug
router.post("/chat/:slug", async (req, res) => {
    const { slug } = req.params;
    console.log(slug);
    if (!isValidSlug(slug)) {
        return res.status(400).json({ error: "Invalid bot slug format" });
    }
    // Ensure the bot exists in the DEMO_BOTS registry (existing behavior)
    const botConfig = await (0, config_1.getBotConfigBySlug)(slug);
    if (!botConfig) {
        return res.status(404).json({ error: "Bot not found" });
    }
    const { message, conversationId } = req.body || {};
    if (typeof message !== "string") {
        return res.status(400).json({ error: "Missing or invalid 'message' field" });
    }
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
        return res.status(400).json({ error: "Message cannot be empty" });
    }
    const convId = typeof conversationId === "string" && conversationId ? conversationId : (0, uuid_1.v4)();
    // externalUserId: prefer an explicit session id, fallback to a conv-based id
    const externalUserId = req.headers["x-session-id"] || `web:${convId}`;
    let dbConversationId = null;
    try {
        // --- NEW: conversation creation BEFORE OpenAI, so we can load history ---
        const dbBot = await prisma_1.prisma.bot.findUnique({ where: { slug } });
        if (dbBot) {
            const convo = await (0, conversationService_1.findOrCreateConversation)({
                botId: dbBot.id,
                channel: "WEB", // ChannelType.WEB in DB enum
                externalUserId
            });
            dbConversationId = convo.id;
        }
        // --- Call chat service with optional DB conversationId for memory ---
        const reply = await (0, chatService_1.generateBotReplyForSlug)(slug, trimmedMessage, {
            conversationId: dbConversationId ?? undefined
        });
        // --- Conversation logging (same behavior, now reusing dbConversationId) ---
        try {
            if (dbConversationId) {
                await (0, conversationService_1.logMessage)({
                    conversationId: dbConversationId,
                    role: "USER",
                    content: trimmedMessage
                });
                await (0, conversationService_1.logMessage)({
                    conversationId: dbConversationId,
                    role: "ASSISTANT",
                    content: reply
                });
            }
            else {
                // Non fatal: slug exists only in DEMO_BOTS, no logging in DB
                // console.debug(`No DB bot found for slug=${slug}, skipping logging`);
            }
        }
        catch (logErr) {
            console.error("Failed to log conversation/messages", logErr);
            // Do not block the response if logging fails
        }
        return res.json({
            conversationId: convId,
            reply
        });
    }
    catch (err) {
        if (err instanceof chatService_1.ChatServiceError) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        console.error("Error in /api/chat:", err);
        return res.status(500).json({
            error: "Sorry, there was an error. Please try again."
        });
    }
});
exports.default = router;
