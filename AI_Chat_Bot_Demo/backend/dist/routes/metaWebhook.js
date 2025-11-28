"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/metaWebhook.ts
const express_1 = require("express");
const axios_1 = __importDefault(require("axios"));
const prisma_1 = require("../prisma/prisma");
const config_1 = require("../config");
const metaTokenService_1 = require("../services/metaTokenService");
const conversationService_1 = require("../services/conversationService");
const chatService_1 = require("../services/chatService");
const router = (0, express_1.Router)();
// GET /webhook/meta (verification)
router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === config_1.config.metaVerifyToken) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});
async function sendFacebookReply(channelId, pageId, userId, reply) {
    const channel = await prisma_1.prisma.botChannel.findUnique({
        where: { id: channelId }
    });
    if (!channel) {
        console.error("BotChannel not found while sending FB reply", { channelId });
        return;
    }
    let accessToken = channel.accessToken || config_1.config.metaPageAccessToken;
    if (!accessToken || !config_1.config.metaGraphApiBaseUrl) {
        console.error("Meta FB access token or base URL not configured");
        return;
    }
    const url = `${config_1.config.metaGraphApiBaseUrl}/${pageId}/messages`;
    const body = {
        messaging_type: "RESPONSE",
        recipient: { id: userId },
        message: { text: reply }
    };
    try {
        await axios_1.default.post(url, body, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            timeout: 10000
        });
    }
    catch (err) {
        console.error("Failed to send FB message (first attempt)", err?.response?.data || err);
        if ((0, metaTokenService_1.isMetaTokenErrorNeedingRefresh)(err)) {
            console.log("Attempting to refresh FB page access token for channel", {
                channelId
            });
            const refreshed = await (0, metaTokenService_1.refreshPageAccessTokenForChannel)(channelId);
            if (!refreshed || !refreshed.accessToken) {
                console.error("Could not refresh FB page token; channel may need reconnect", {
                    channelId
                });
                return;
            }
            accessToken = refreshed.accessToken;
            try {
                await axios_1.default.post(url, body, {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json"
                    },
                    timeout: 10000
                });
                console.log("FB message sent successfully after token refresh", {
                    channelId
                });
            }
            catch (err2) {
                console.error("Failed to send FB message after token refresh", err2);
            }
        }
    }
}
async function sendInstagramReply(channelId, igBusinessId, userId, reply) {
    const channel = await prisma_1.prisma.botChannel.findUnique({
        where: { id: channelId }
    });
    if (!channel) {
        console.error("BotChannel not found while sending IG reply", { channelId });
        return;
    }
    let accessToken = channel.accessToken || config_1.config.metaPageAccessToken;
    if (!accessToken || !config_1.config.metaGraphApiBaseUrl) {
        console.error("Meta IG access token or base URL not configured");
        return;
    }
    const url = `${config_1.config.metaGraphApiBaseUrl}/${igBusinessId}/messages`;
    const body = {
        recipient: { id: userId },
        message: { text: reply }
    };
    try {
        await axios_1.default.post(url, body, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            timeout: 10000
        });
    }
    catch (err) {
        console.error("Failed to send IG message (first attempt)", err?.response?.data || err);
        if ((0, metaTokenService_1.isMetaTokenErrorNeedingRefresh)(err)) {
            console.log("Attempting to refresh IG page access token for channel", {
                channelId
            });
            const refreshed = await (0, metaTokenService_1.refreshPageAccessTokenForChannel)(channelId);
            if (!refreshed || !refreshed.accessToken) {
                console.error("Could not refresh IG page token; channel may need reconnect", {
                    channelId
                });
                return;
            }
            accessToken = refreshed.accessToken;
            try {
                await axios_1.default.post(url, body, {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json"
                    },
                    timeout: 10000
                });
                console.log("IG message sent successfully after token refresh", {
                    channelId
                });
            }
            catch (err2) {
                console.error("Failed to send IG message after token refresh", err2);
            }
        }
    }
}
// POST /webhook/meta
router.post("/", async (req, res) => {
    const body = req.body;
    if (!body || !body.object) {
        return res.sendStatus(200);
    }
    try {
        if (body.object === "page") {
            const entries = Array.isArray(body.entry) ? body.entry : [];
            for (const entry of entries) {
                const pageId = entry.id;
                const messagingEvents = Array.isArray(entry.messaging)
                    ? entry.messaging
                    : [];
                for (const event of messagingEvents) {
                    const message = event.message;
                    const sender = event.sender;
                    if (!message || !message.text || !sender || !sender.id)
                        continue;
                    const userId = sender.id;
                    const text = message.text;
                    const channel = await prisma_1.prisma.botChannel.findFirst({
                        where: {
                            type: "FACEBOOK",
                            externalId: pageId
                        },
                        include: { bot: true }
                    });
                    if (!channel || !channel.bot) {
                        console.warn("FB page not linked to any bot", { pageId });
                        continue;
                    }
                    const bot = channel.bot;
                    if (bot.status !== "ACTIVE")
                        continue;
                    const reply = await (0, chatService_1.generateBotReplyForSlug)(bot.slug, text);
                    const convo = await (0, conversationService_1.findOrCreateConversation)({
                        botId: bot.id,
                        channel: "FACEBOOK",
                        externalUserId: userId
                    });
                    await (0, conversationService_1.logMessage)({
                        conversationId: convo.id,
                        role: "USER",
                        content: text,
                        channelMessageId: message.mid
                    });
                    await (0, conversationService_1.logMessage)({
                        conversationId: convo.id,
                        role: "ASSISTANT",
                        content: reply
                    });
                    await sendFacebookReply(channel.id, pageId, userId, reply);
                }
            }
        }
        else if (body.object === "instagram") {
            const entries = Array.isArray(body.entry) ? body.entry : [];
            for (const entry of entries) {
                const igBusinessId = entry.id;
                const messagingEvents = Array.isArray(entry.messaging)
                    ? entry.messaging
                    : [];
                for (const event of messagingEvents) {
                    const message = event.message;
                    const sender = event.sender;
                    if (!message || !message.text || !sender || !sender.id)
                        continue;
                    const userId = sender.id;
                    const text = message.text;
                    const channel = await prisma_1.prisma.botChannel.findFirst({
                        where: {
                            type: "INSTAGRAM",
                            externalId: igBusinessId
                        },
                        include: { bot: true }
                    });
                    if (!channel || !channel.bot) {
                        console.warn("IG business account not linked to any bot", {
                            igBusinessId
                        });
                        continue;
                    }
                    const bot = channel.bot;
                    if (bot.status !== "ACTIVE")
                        continue;
                    const reply = await (0, chatService_1.generateBotReplyForSlug)(bot.slug, text);
                    const convo = await (0, conversationService_1.findOrCreateConversation)({
                        botId: bot.id,
                        channel: "INSTAGRAM",
                        externalUserId: userId
                    });
                    await (0, conversationService_1.logMessage)({
                        conversationId: convo.id,
                        role: "USER",
                        content: text,
                        channelMessageId: message.mid
                    });
                    await (0, conversationService_1.logMessage)({
                        conversationId: convo.id,
                        role: "ASSISTANT",
                        content: reply
                    });
                    await sendInstagramReply(channel.id, igBusinessId, userId, reply);
                }
            }
        }
        else {
            console.log("Ignoring unsupported Meta object:", body.object);
        }
    }
    catch (err) {
        console.error("Error processing Meta webhook", err);
    }
    return res.sendStatus(200);
});
exports.default = router;
