"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.debugToken = debugToken;
exports.isMetaTokenErrorNeedingRefresh = isMetaTokenErrorNeedingRefresh;
exports.refreshPageAccessTokenForChannel = refreshPageAccessTokenForChannel;
exports.refreshSoonExpiringTokens = refreshSoonExpiringTokens;
exports.scheduleMetaTokenRefreshJob = scheduleMetaTokenRefreshJob;
// src/services/metaTokenService.ts
const axios_1 = __importDefault(require("axios"));
const prisma_1 = require("../prisma/prisma");
const config_1 = require("../config");
/**
 * Call /debug_token on a Meta access token to get expiry and validity.
 */
async function debugToken(accessToken) {
    if (!config_1.config.metaAppId || !config_1.config.metaAppSecret) {
        console.warn("Meta appId/appSecret not configured, cannot debug token");
        return { isValid: true, expiresAt: null };
    }
    const appAccessToken = `${config_1.config.metaAppId}|${config_1.config.metaAppSecret}`;
    try {
        const res = await axios_1.default.get("https://graph.facebook.com/debug_token", {
            params: {
                input_token: accessToken,
                access_token: appAccessToken
            }
        });
        const data = res.data?.data;
        const isValid = !!data?.is_valid;
        const expiresAtUnix = data?.expires_at;
        const expiresAt = expiresAtUnix && expiresAtUnix > 0
            ? new Date(expiresAtUnix * 1000)
            : null;
        return { isValid, expiresAt };
    }
    catch (err) {
        console.error("Failed to debug Meta token", err);
        // If debug fails, we don't want to kill the whole flow.
        return { isValid: true, expiresAt: null };
    }
}
function isMetaTokenErrorNeedingRefresh(err) {
    const code = err?.response?.data?.error?.code;
    const type = err?.response?.data?.error?.type;
    // 190 is the classic OAuthException for invalid/expired token
    return code === 190 || type === "OAuthException";
}
/**
 * Refresh the page access token for a given BotChannel using its stored
 * longLivedUserToken + pageId from meta.
 *
 * Returns the updated BotChannel or null if refresh is not possible.
 */
async function refreshPageAccessTokenForChannel(channelId) {
    if (!config_1.config.metaGraphApiBaseUrl) {
        console.warn("Meta graph API base URL not configured, cannot refresh");
        return null;
    }
    const channel = await prisma_1.prisma.botChannel.findUnique({
        where: { id: channelId }
    });
    if (!channel) {
        console.warn("BotChannel not found for refresh", { channelId });
        return null;
    }
    if (channel.type !== "FACEBOOK" && channel.type !== "INSTAGRAM") {
        console.warn("BotChannel is not a Meta type", { channelId, type: channel.type });
        return null;
    }
    const meta = channel.meta || {};
    const longLivedUserToken = meta.longLivedUserToken;
    const pageId = meta.pageId;
    if (!longLivedUserToken || !pageId) {
        console.warn("Missing longLivedUserToken or pageId in channel.meta", {
            channelId
        });
        return null;
    }
    try {
        const accountsRes = await axios_1.default.get(`${config_1.config.metaGraphApiBaseUrl}/me/accounts`, {
            params: {
                access_token: longLivedUserToken,
                fields: "id,name,access_token,instagram_business_account"
            },
            timeout: 10000
        });
        const pages = accountsRes.data?.data || [];
        const selectedPage = pages.find((p) => p.id === pageId);
        if (!selectedPage) {
            console.warn("Page not found in /me/accounts during refresh", {
                channelId,
                pageId
            });
            return null;
        }
        const newPageAccessToken = selectedPage.access_token;
        const debugRes = await debugToken(newPageAccessToken);
        const tokenExpiresAtIso = debugRes.expiresAt
            ? debugRes.expiresAt.toISOString()
            : null;
        const newMeta = {
            ...meta,
            tokenExpiresAt: tokenExpiresAtIso
        };
        const updated = await prisma_1.prisma.botChannel.update({
            where: { id: channel.id },
            data: {
                accessToken: newPageAccessToken,
                meta: newMeta
            }
        });
        console.log("Refreshed Meta page token for channel", {
            channelId: channel.id,
            pageId,
            expiresAt: tokenExpiresAtIso
        });
        return updated;
    }
    catch (err) {
        console.error("Failed to refresh page access token for channel", {
            channelId,
            error: err
        });
        return null;
    }
}
/**
 * Cron-like job: refresh tokens that are close to expiry.
 * We don't rely on DB JSON queries; we filter in JS for now.
 */
async function refreshSoonExpiringTokens() {
    if (!config_1.config.metaGraphApiBaseUrl) {
        console.warn("Meta graph API base URL not configured, skip refresh job");
        return;
    }
    const now = Date.now();
    const thresholdMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const channels = await prisma_1.prisma.botChannel.findMany({
        where: {
            OR: [{ type: "FACEBOOK" }, { type: "INSTAGRAM" }]
        }
    });
    console.log(`Meta token refresh job: checking ${channels.length} Meta channels`);
    for (const channel of channels) {
        const meta = channel.meta || {};
        const tokenExpiresAtStr = meta.tokenExpiresAt;
        const longLivedUserToken = meta.longLivedUserToken;
        const pageId = meta.pageId;
        if (!longLivedUserToken || !pageId) {
            // We can't refresh without this information.
            continue;
        }
        let needsRefresh = false;
        if (!tokenExpiresAtStr) {
            needsRefresh = true;
        }
        else {
            const tokenExpiresAt = new Date(tokenExpiresAtStr);
            if (isNaN(tokenExpiresAt.getTime())) {
                needsRefresh = true;
            }
            else {
                const diff = tokenExpiresAt.getTime() - now;
                if (diff <= thresholdMs) {
                    needsRefresh = true;
                }
            }
        }
        if (!needsRefresh)
            continue;
        try {
            await refreshPageAccessTokenForChannel(channel.id);
        }
        catch (err) {
            console.error("Error refreshing token for channel in cron job", {
                channelId: channel.id,
                error: err
            });
        }
    }
}
/**
 * Start a simple interval-based job inside this backend process.
 * Runs every 12 hours.
 */
let metaTokenJobStarted = false;
function scheduleMetaTokenRefreshJob() {
    if (metaTokenJobStarted)
        return;
    metaTokenJobStarted = true;
    const intervalMs = 12 * 60 * 60 * 1000; // 12 hours
    console.log(`Starting Meta token refresh job (every ${intervalMs / (60 * 60 * 1000)}h)`);
    // Run once on startup
    refreshSoonExpiringTokens().catch((err) => console.error("Initial Meta token refresh job failed", err));
    setInterval(() => {
        refreshSoonExpiringTokens().catch((err) => console.error("Scheduled Meta token refresh job failed", err));
    }, intervalMs);
}
