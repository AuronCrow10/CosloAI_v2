"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/metaAuth.ts
const express_1 = require("express");
const axios_1 = __importDefault(require("axios"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../prisma/prisma");
const config_1 = require("../config");
const auth_1 = require("../middleware/auth");
const metaTokenService_1 = require("../services/metaTokenService");
const router = (0, express_1.Router)();
// Utility: ensure Meta config exists
function assertMetaConfigured() {
    if (!config_1.config.metaAppId || !config_1.config.metaAppSecret || !config_1.config.metaRedirectUri) {
        throw new Error("Meta app configuration is incomplete");
    }
}
/**
 * STEP 1
 * GET /api/bots/:botId/meta/connect?type=FACEBOOK|INSTAGRAM
 * - must be authenticated (requireAuth)
 * - verifies bot ownership
 * - returns { url } for Meta OAuth
 */
router.get("/bots/:botId/meta/connect", auth_1.requireAuth, async (req, res) => {
    try {
        assertMetaConfigured();
        const { botId } = req.params;
        const typeParam = String(req.query.type || "FACEBOOK").toUpperCase();
        const channelType = typeParam === "INSTAGRAM" ? "INSTAGRAM" : "FACEBOOK";
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const user = req.user;
        // Check bot ownership
        const bot = await prisma_1.prisma.bot.findUnique({
            where: { id: botId }
        });
        if (!bot) {
            return res.status(404).json({ error: "Bot not found" });
        }
        if (user.role !== "ADMIN" && bot.userId !== user.id) {
            return res.status(403).json({ error: "Forbidden" });
        }
        // Optionally enforce only ACTIVE bots can connect channels
        if (bot.status !== "ACTIVE") {
            return res
                .status(400)
                .json({ error: "Bot must be active before connecting channels" });
        }
        // Encode state as signed JWT (prevents tampering)
        const stateToken = jsonwebtoken_1.default.sign({
            botId,
            userId: user.id,
            channelType
        }, config_1.config.jwtAccessSecret, { expiresIn: "10m" });
        const scopes = channelType === "FACEBOOK"
            ? [
                "pages_show_list",
                "pages_messaging",
                "pages_manage_metadata",
                "pages_read_engagement"
            ]
            : [
                "pages_show_list",
                "instagram_basic",
                "instagram_manage_messages",
                "pages_manage_metadata"
            ];
        const authUrl = new URL("https://www.facebook.com/v22.0/dialog/oauth");
        authUrl.searchParams.set("client_id", config_1.config.metaAppId);
        authUrl.searchParams.set("redirect_uri", config_1.config.metaRedirectUri);
        authUrl.searchParams.set("state", stateToken);
        authUrl.searchParams.set("scope", scopes.join(","));
        return res.json({ url: authUrl.toString() });
    }
    catch (err) {
        console.error("Meta connect URL error", err);
        return res
            .status(500)
            .json({ error: err.message || "Failed to start Meta connection" });
    }
});
/**
 * STEP 2
 * GET /api/meta/oauth/callback?code=...&state=...
 */
router.get("/meta/oauth/callback", async (req, res) => {
    const { code, state } = req.query;
    if (!code || typeof code !== "string" || !state || typeof state !== "string") {
        return res.status(400).send("Missing code or state");
    }
    try {
        assertMetaConfigured();
    }
    catch (err) {
        console.error("Meta not configured", err);
        return res.status(500).send("Meta app not configured");
    }
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(state, config_1.config.jwtAccessSecret);
    }
    catch (err) {
        console.error("Invalid Meta state token", err);
        return res.status(400).send("Invalid state");
    }
    const { botId, userId, channelType } = decoded;
    try {
        // Double-check bot + owner still valid
        const bot = await prisma_1.prisma.bot.findUnique({
            where: { id: botId }
        });
        if (!bot) {
            return res.status(400).send("Bot not found");
        }
        if (bot.userId !== userId) {
            return res.status(400).send("User no longer owns this bot");
        }
        // 1) Short-lived user token
        const tokenRes = await axios_1.default.get("https://graph.facebook.com/v22.0/oauth/access_token", {
            params: {
                client_id: config_1.config.metaAppId,
                client_secret: config_1.config.metaAppSecret,
                redirect_uri: config_1.config.metaRedirectUri,
                code
            }
        });
        const shortLivedUserToken = tokenRes.data.access_token;
        // 2) Exchange for long-lived token
        const longLivedRes = await axios_1.default.get("https://graph.facebook.com/v22.0/oauth/access_token", {
            params: {
                grant_type: "fb_exchange_token",
                client_id: config_1.config.metaAppId,
                client_secret: config_1.config.metaAppSecret,
                fb_exchange_token: shortLivedUserToken
            }
        });
        const longLivedUserToken = longLivedRes.data.access_token;
        // 3) Get pages this user manages
        const accountsRes = await axios_1.default.get("https://graph.facebook.com/v22.0/me/accounts", {
            params: {
                access_token: longLivedUserToken,
                fields: "id,name,access_token,instagram_business_account"
            }
        });
        const pages = accountsRes.data.data;
        if (!pages || pages.length === 0) {
            return res.status(400).send("No pages found for this account");
        }
        // Create MetaConnectSession
        const session = await prisma_1.prisma.metaConnectSession.create({
            data: {
                botId,
                userId,
                channelType,
                pagesJson: pages,
                longLivedUserToken
            }
        });
        const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
        const redirectUrl = new URL(`/app/bots/${botId}/channels`, frontendOrigin);
        redirectUrl.searchParams.set("metaSessionId", session.id);
        return res.redirect(redirectUrl.toString());
    }
    catch (err) {
        console.error("Meta OAuth callback error", err);
        return res.status(500).send("Failed to connect Meta account");
    }
});
/**
 * STEP 3a
 * GET /api/meta/sessions/:sessionId
 */
router.get("/meta/sessions/:sessionId", auth_1.requireAuth, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const { sessionId } = req.params;
        const user = req.user;
        const session = await prisma_1.prisma.metaConnectSession.findUnique({
            where: { id: sessionId },
            include: { bot: true }
        });
        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }
        if (user.role !== "ADMIN" && session.userId !== user.id) {
            return res.status(403).json({ error: "Forbidden" });
        }
        if (session.bot.userId !== session.userId) {
            return res.status(400).json({ error: "Session bot mismatch" });
        }
        const rawPages = session.pagesJson;
        const pages = rawPages.map((p) => ({
            id: p.id,
            name: p.name,
            instagramBusinessId: p.instagram_business_account?.id || null
        }));
        return res.json({
            id: session.id,
            botId: session.botId,
            channelType: session.channelType,
            pages,
            createdAt: session.createdAt.toISOString()
        });
    }
    catch (err) {
        console.error("Meta session load error", err);
        return res
            .status(500)
            .json({ error: err.message || "Failed to load Meta session" });
    }
});
/**
 * STEP 3b
 * POST /api/meta/sessions/:sessionId/attach
 * - now also calls debugToken() and stores tokenExpiresAt in meta
 */
router.post("/meta/sessions/:sessionId/attach", auth_1.requireAuth, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const user = req.user;
        const { sessionId } = req.params;
        const { pageId } = req.body;
        if (!pageId) {
            return res.status(400).json({ error: "Missing pageId" });
        }
        const session = await prisma_1.prisma.metaConnectSession.findUnique({
            where: { id: sessionId },
            include: { bot: true }
        });
        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }
        if (user.role !== "ADMIN" && session.userId !== user.id) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const bot = session.bot;
        if (bot.userId !== session.userId) {
            return res.status(400).json({ error: "Session bot mismatch" });
        }
        const rawPages = session.pagesJson;
        const selectedPage = rawPages.find((p) => p.id === pageId);
        if (!selectedPage) {
            return res
                .status(400)
                .json({ error: "Selected page not found in session" });
        }
        const pageAccessToken = selectedPage.access_token;
        const pageName = selectedPage.name;
        const igBusinessId = selectedPage.instagram_business_account?.id || null;
        const debugRes = await (0, metaTokenService_1.debugToken)(pageAccessToken);
        const tokenExpiresAtIso = debugRes.expiresAt
            ? debugRes.expiresAt.toISOString()
            : null;
        let botChannel;
        if (session.channelType === "FACEBOOK") {
            botChannel = await prisma_1.prisma.botChannel.upsert({
                where: {
                    botId_type_externalId: {
                        botId: bot.id,
                        type: "FACEBOOK",
                        externalId: selectedPage.id
                    }
                },
                update: {
                    accessToken: pageAccessToken,
                    meta: {
                        pageName,
                        pageId: selectedPage.id,
                        longLivedUserToken: session.longLivedUserToken,
                        tokenExpiresAt: tokenExpiresAtIso
                    }
                },
                create: {
                    botId: bot.id,
                    type: "FACEBOOK",
                    externalId: selectedPage.id,
                    accessToken: pageAccessToken,
                    meta: {
                        pageName,
                        pageId: selectedPage.id,
                        longLivedUserToken: session.longLivedUserToken,
                        tokenExpiresAt: tokenExpiresAtIso
                    }
                }
            });
        }
        else {
            if (!igBusinessId) {
                return res.status(400).json({
                    error: "Selected page does not have an Instagram business account attached"
                });
            }
            botChannel = await prisma_1.prisma.botChannel.upsert({
                where: {
                    botId_type_externalId: {
                        botId: bot.id,
                        type: "INSTAGRAM",
                        externalId: igBusinessId
                    }
                },
                update: {
                    accessToken: pageAccessToken,
                    meta: {
                        pageName,
                        pageId: selectedPage.id,
                        igBusinessId,
                        longLivedUserToken: session.longLivedUserToken,
                        tokenExpiresAt: tokenExpiresAtIso
                    }
                },
                create: {
                    botId: bot.id,
                    type: "INSTAGRAM",
                    externalId: igBusinessId,
                    accessToken: pageAccessToken,
                    meta: {
                        pageName,
                        pageId: selectedPage.id,
                        igBusinessId,
                        longLivedUserToken: session.longLivedUserToken,
                        tokenExpiresAt: tokenExpiresAtIso
                    }
                }
            });
        }
        // Subscribe page to webhooks (best effort)
        if (config_1.config.metaGraphApiBaseUrl) {
            try {
                await axios_1.default.post(`${config_1.config.metaGraphApiBaseUrl}/${selectedPage.id}/subscribed_apps`, null, {
                    params: {
                        subscribed_fields: "messages,messaging_postbacks,message_reactions",
                        access_token: pageAccessToken
                    },
                    timeout: 10000
                });
            }
            catch (err) {
                console.error("Failed to subscribe page to webhooks", err);
            }
        }
        // Clean up session
        await prisma_1.prisma.metaConnectSession.delete({
            where: { id: session.id }
        });
        return res.json(botChannel);
    }
    catch (err) {
        console.error("Meta attach error", err);
        return res
            .status(500)
            .json({ error: err.message || "Failed to attach Meta page" });
    }
});
exports.default = router;
