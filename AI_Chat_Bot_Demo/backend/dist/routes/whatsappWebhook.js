"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const axios_1 = __importDefault(require("axios"));
const prisma_1 = require("../prisma/prisma");
const config_1 = require("../config");
const conversationService_1 = require("../services/conversationService");
const chatService_1 = require("../services/chatService");
const router = (0, express_1.Router)();
// GET /webhook/whatsapp (verification)
router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === config_1.config.whatsappVerifyToken) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});
// POST /webhook/whatsapp (events)
router.post("/", async (req, res) => {
    const body = req.body;
    if (!body || !body.entry) {
        return res.sendStatus(200);
    }
    try {
        const entries = Array.isArray(body.entry) ? body.entry : [];
        for (const entry of entries) {
            const changes = Array.isArray(entry.changes) ? entry.changes : [];
            for (const change of changes) {
                const value = change.value;
                if (!value || !value.messages || !value.metadata)
                    continue;
                const messages = Array.isArray(value.messages) ? value.messages : [];
                const metadata = value.metadata;
                const phoneNumberId = metadata.phone_number_id;
                for (const msg of messages) {
                    if (msg.type !== "text" || !msg.text || !msg.text.body)
                        continue;
                    const userWaId = msg.from;
                    const text = msg.text.body;
                    if (!phoneNumberId)
                        continue;
                    // Map phone_number_id -> BotChannel -> Bot
                    const channel = await prisma_1.prisma.botChannel.findFirst({
                        where: {
                            type: "WHATSAPP",
                            externalId: phoneNumberId
                        },
                        include: { bot: true }
                    });
                    if (!channel || !channel.bot) {
                        console.warn("WhatsApp bot not configured for phone_number_id", {
                            phoneNumberId
                        });
                        continue;
                    }
                    const bot = channel.bot;
                    if (bot.status !== "ACTIVE") {
                        console.warn("Ignoring message for non-active bot", { botId: bot.id });
                        continue;
                    }
                    const reply = await (0, chatService_1.generateBotReplyForSlug)(bot.slug, text);
                    const convo = await (0, conversationService_1.findOrCreateConversation)({
                        botId: bot.id,
                        channel: "WHATSAPP",
                        externalUserId: userWaId
                    });
                    await (0, conversationService_1.logMessage)({
                        conversationId: convo.id,
                        role: "USER",
                        content: text,
                        channelMessageId: msg.id
                    });
                    await (0, conversationService_1.logMessage)({
                        conversationId: convo.id,
                        role: "ASSISTANT",
                        content: reply
                    });
                    // Send reply back via Cloud API
                    if (!config_1.config.whatsappApiBaseUrl || !config_1.config.whatsappAccessToken) {
                        console.error("WhatsApp API not configured");
                        continue;
                    }
                    const url = `${config_1.config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;
                    try {
                        await axios_1.default.post(url, {
                            messaging_product: "whatsapp",
                            to: userWaId,
                            text: { body: reply }
                        }, {
                            headers: {
                                Authorization: `Bearer ${config_1.config.whatsappAccessToken}`,
                                "Content-Type": "application/json"
                            },
                            timeout: 10000
                        });
                    }
                    catch (err) {
                        console.error("Failed to send WhatsApp message", err);
                    }
                }
            }
        }
    }
    catch (err) {
        console.error("Error processing WhatsApp webhook", err);
    }
    res.sendStatus(200);
});
exports.default = router;
