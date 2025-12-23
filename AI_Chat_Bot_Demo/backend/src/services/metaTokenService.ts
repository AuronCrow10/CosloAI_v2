// src/services/metaTokenService.ts
import axios from "axios";
import { prisma } from "../prisma/prisma";
import { config } from "../config";

export interface DebugTokenResult {
  isValid: boolean;
  expiresAt: Date | null;
}

/**
 * Call /debug_token on a Meta access token to get expiry and validity.
 */
export async function debugToken(
  accessToken: string
): Promise<DebugTokenResult> {
  if (!config.metaAppId || !config.metaAppSecret) {
    console.warn("Meta appId/appSecret not configured, cannot debug token");
    return { isValid: true, expiresAt: null };
  }

  const appAccessToken = `${config.metaAppId}|${config.metaAppSecret}`;

  try {
    const res = await axios.get("https://graph.facebook.com/debug_token", {
      params: {
        input_token: accessToken,
        access_token: appAccessToken
      }
    });

    const data = res.data?.data;
    const isValid = !!data?.is_valid;
    const expiresAtUnix: number | undefined = data?.expires_at;

    const expiresAt =
      expiresAtUnix && expiresAtUnix > 0
        ? new Date(expiresAtUnix * 1000)
        : null;

    return { isValid, expiresAt };
  } catch (err) {
    console.error("Failed to debug Meta token", err);
    // If debug fails, we don't want to kill the whole flow.
    return { isValid: true, expiresAt: null };
  }
}

export function isMetaTokenErrorNeedingRefresh(err: any): boolean {
  const code = err?.response?.data?.error?.code;
  const type = err?.response?.data?.error?.type;
  // 190 is the classic OAuthException for invalid/expired token
  return code === 190 || type === "OAuthException";
}

type GraphPage = {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string };
  connected_instagram_account?: { id: string };
};

/**
 * Internal helper to fetch all pages a user can access (direct + business).
 */
async function fetchAllUserPagesWithBusinessFallback(
  longLivedUserToken: string
): Promise<GraphPage[]> {
  if (!config.metaGraphApiBaseUrl) {
    console.warn(
      "Meta graph API base URL not configured, cannot load user pages"
    );
    return [];
  }

  const pages: GraphPage[] = [];
  const fields =
    "id,name,access_token,instagram_business_account,connected_instagram_account";

  // Direct connections via /me/accounts
  const accountsRes = await axios.get(
    `${config.metaGraphApiBaseUrl}/me/accounts`,
    {
      params: {
        access_token: longLivedUserToken,
        fields
      },
      timeout: 10000
    }
  );

  pages.push(
    ...(((accountsRes.data && accountsRes.data.data) as GraphPage[]) || [])
  );

  // Best-effort business-owned & client pages
  try {
    const businessesRes = await axios.get(
      `${config.metaGraphApiBaseUrl}/me/businesses`,
      {
        params: {
          access_token: longLivedUserToken,
          fields: "id,name,permitted_tasks"
        },
        timeout: 10000
      }
    );

    const businesses = ((businessesRes.data && businessesRes.data.data) ||
      []) as Array<{
      id: string;
      name: string;
      permitted_tasks?: string[];
    }>;

    for (const biz of businesses) {
      const tasks = biz.permitted_tasks || [];
      const canManage =
        tasks.length === 0 ||
        tasks.includes("MANAGE") ||
        tasks.includes("MANAGE_PAGES") ||
        tasks.includes("MANAGE_CAMPAIGNS") ||
        tasks.includes("MANAGE_TASKS");

      if (!canManage) continue;

      for (const edge of ["owned_pages", "client_pages"] as const) {
        try {
          const edgeRes = await axios.get(
            `${config.metaGraphApiBaseUrl}/${biz.id}/${edge}`,
            {
              params: {
                access_token: longLivedUserToken,
                fields
              },
              timeout: 10000
            }
          );

          pages.push(
            ...(((edgeRes.data && edgeRes.data.data) as GraphPage[]) || [])
          );
        } catch (err) {
          console.warn(
            `Meta business fallback failed for ${edge} of business ${biz.id}`,
            err
          );
        }
      }
    }
  } catch (err) {
    console.warn(
      "Meta business fallback failed, continuing with /me/accounts only",
      err
    );
  }

  const dedup = new Map<string, GraphPage>();
  for (const p of pages) {
    if (!p || !p.id) continue;
    const existing = dedup.get(p.id);
    dedup.set(p.id, { ...existing, ...p });
  }

  return Array.from(dedup.values());
}

/**
 * Refresh the page access token for a given BotChannel using its stored
 * longLivedUserToken + pageId from meta.
 *
 * Returns the updated BotChannel or null if refresh is not possible.
 */
export async function refreshPageAccessTokenForChannel(channelId: string) {
  if (!config.metaGraphApiBaseUrl) {
    console.warn("Meta graph API base URL not configured, cannot refresh");
    return null;
  }

  const channel = await prisma.botChannel.findUnique({
    where: { id: channelId }
  });

  if (!channel) {
    console.warn("BotChannel not found for refresh", { channelId });
    return null;
  }

  if (channel.type !== "FACEBOOK" && channel.type !== "INSTAGRAM") {
    console.warn("BotChannel is not a Meta type", {
      channelId,
      type: channel.type
    });
    return null;
  }

  const meta = (channel.meta as any) || {};
  const longLivedUserToken: string | undefined = meta.longLivedUserToken;
  const pageId: string | undefined = meta.pageId;

  if (!longLivedUserToken || !pageId) {
    console.warn("Missing longLivedUserToken or pageId in channel.meta", {
      channelId
    });
    return null;
  }

  try {
    // 👇 UPDATED: use business-aware helper for refresh too
    const pages = await fetchAllUserPagesWithBusinessFallback(
      longLivedUserToken
    );

    if (!pages || pages.length === 0) {
      console.warn("No pages returned while refreshing Meta token", {
        channelId,
        pageId
      });
      return null;
    }

    const selectedPage = pages.find((p) => p.id === pageId);
    if (!selectedPage) {
      console.warn("Page not found among user pages during refresh", {
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

    const updated = await prisma.botChannel.update({
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
  } catch (err) {
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
export async function refreshSoonExpiringTokens() {
  if (!config.metaGraphApiBaseUrl) {
    console.warn("Meta graph API base URL not configured, skip refresh job");
    return;
  }

  const now = Date.now();
  const thresholdMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  const channels = await prisma.botChannel.findMany({
    where: {
      OR: [{ type: "FACEBOOK" }, { type: "INSTAGRAM" }]
    }
  });

  console.log(
    `Meta token refresh job: checking ${channels.length} Meta channels`
  );

  for (const channel of channels) {
    const meta = (channel.meta as any) || {};
    const tokenExpiresAtStr: string | undefined = meta.tokenExpiresAt;
    const longLivedUserToken: string | undefined = meta.longLivedUserToken;
    const pageId: string | undefined = meta.pageId;

    if (!longLivedUserToken || !pageId) {
      // We can't refresh without this information.
      continue;
    }

    let needsRefresh = false;

    if (!tokenExpiresAtStr) {
      needsRefresh = true;
    } else {
      const tokenExpiresAt = new Date(tokenExpiresAtStr);
      if (isNaN(tokenExpiresAt.getTime())) {
        needsRefresh = true;
      } else {
        const diff = tokenExpiresAt.getTime() - now;
        if (diff <= thresholdMs) {
          needsRefresh = true;
        }
      }
    }

    if (!needsRefresh) continue;

    try {
      await refreshPageAccessTokenForChannel(channel.id);
    } catch (err) {
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

export function scheduleMetaTokenRefreshJob() {
  if (metaTokenJobStarted) return;
  metaTokenJobStarted = true;

  const intervalMs = 12 * 60 * 60 * 1000; // 12 hours

  console.log(
    `Starting Meta token refresh job (every ${
      intervalMs / (60 * 60 * 1000)
    }h)`
  );

  // Run once on startup
  refreshSoonExpiringTokens().catch((err) =>
    console.error("Initial Meta token refresh job failed", err)
  );

  setInterval(() => {
    refreshSoonExpiringTokens().catch((err) =>
      console.error("Scheduled Meta token refresh job failed", err)
    );
  }, intervalMs);
}
