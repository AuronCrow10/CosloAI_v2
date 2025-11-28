"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleFacebookMessageEvent = handleFacebookMessageEvent;
exports.handleInstagramMessageEvent = handleInstagramMessageEvent;
const config_1 = require("../config");
const config_2 = require("../bots/config");
const chatService_1 = require("./chatService");
const client_1 = require("../meta/client");
async function handleFacebookMessageEvent(params) {
    const { pageId, userId, text } = params;
    // ⬅️ NOW ASYNC
    const botSlug = await (0, config_2.getBotSlugByFacebookPageId)(pageId);
    if (!botSlug) {
        console.warn("[Meta][FB] No bot configured for pageId", { pageId });
        return;
    }
    const botConfig = await (0, config_2.getBotConfigBySlug)(botSlug);
    if (!botConfig) {
        console.warn("[Meta][FB] Bot config missing for slug", { botSlug });
        return;
    }
    // Determine access token: per-bot or global
    const pageAccessToken = botConfig.channels?.facebook?.pageAccessToken || config_1.config.metaPageAccessToken;
    if (!pageAccessToken) {
        console.error("[Meta][FB] No page access token configured", {
            pageId,
            botSlug
        });
        return;
    }
    try {
        console.log("[Meta][FB] Incoming message", {
            pageId,
            botSlug,
            userId,
            text
        });
        const reply = await (0, chatService_1.generateBotReplyForSlug)(botSlug, text);
        await (0, client_1.sendFacebookTextMessage)({
            pageId,
            accessToken: pageAccessToken,
            recipientId: userId,
            text: reply
        });
        console.log("[Meta][FB] Reply sent", {
            pageId,
            botSlug,
            userId
        });
    }
    catch (err) {
        console.error("[Meta][FB] Error handling message", {
            pageId,
            botSlug,
            userId,
            error: err
        });
    }
}
async function handleInstagramMessageEvent(params) {
    const { igBusinessId, userId, text } = params;
    // ⬅️ NOW ASYNC
    const botSlug = await (0, config_2.getBotSlugByInstagramBusinessId)(igBusinessId);
    if (!botSlug) {
        console.warn("[Meta][IG] No bot configured for igBusinessId", { igBusinessId });
        return;
    }
    // ⬅️ ALSO ASYNC
    const botConfig = await (0, config_2.getBotConfigBySlug)(botSlug);
    if (!botConfig) {
        console.warn("[Meta][IG] Bot config missing for slug", { botSlug });
        return;
    }
    const pageAccessToken = botConfig.channels?.instagram?.pageAccessToken || config_1.config.metaPageAccessToken;
    if (!pageAccessToken) {
        console.error("[Meta][IG] No page access token configured", {
            igBusinessId,
            botSlug
        });
        return;
    }
    try {
        console.log("[Meta][IG] Incoming message", {
            igBusinessId,
            botSlug,
            userId,
            text
        });
        const reply = await (0, chatService_1.generateBotReplyForSlug)(botSlug, text);
        await (0, client_1.sendInstagramTextMessage)({
            igBusinessId,
            accessToken: pageAccessToken,
            recipientId: userId,
            text: reply
        });
        console.log("[Meta][IG] Reply sent", {
            igBusinessId,
            botSlug,
            userId
        });
    }
    catch (err) {
        console.error("[Meta][IG] Error handling message", {
            igBusinessId,
            botSlug,
            userId,
            error: err
        });
    }
}
