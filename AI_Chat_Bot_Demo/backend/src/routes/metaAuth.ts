// src/routes/metaAuth.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { debugToken } from "../services/metaTokenService";

const router = Router();

type GraphPage = {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string };
  connected_instagram_account?: { id: string };
  source?: "me" | "business_owned" | "business_client";
  businessName?: string | null;
};

/**
 * Fetch pages the user can access, including business-owned/client pages.
 * Falls back to /me/accounts only if business calls fail.
 */
/**
 * Fetch pages the user can access, including business-owned/client pages.
 * Falls back to /me/accounts only if business calls fail.
 */
async function fetchUserPagesWithBusinessFallback(
  longLivedUserToken: string
): Promise<GraphPage[]> {
  const pages: GraphPage[] = [];
  const fields =
    "id,name,access_token,instagram_business_account,connected_instagram_account";

  // Always fetch direct page connections (personal pages)
  const accountsRes = await axios.get(
    "https://graph.facebook.com/v22.0/me/accounts",
    {
      params: {
        access_token: longLivedUserToken,
        fields
      }
    }
  );

  const directPages =
    ((accountsRes.data && accountsRes.data.data) as GraphPage[]) || [];

  pages.push(
    ...directPages.map((p) => ({
      ...p,
      source: "me" as const,
      businessName: null
    }))
  );

  // Best-effort: also fetch business-owned and client pages
  try {
    const businessesRes = await axios.get(
      "https://graph.facebook.com/v22.0/me/businesses",
      {
        params: {
          access_token: longLivedUserToken,
          fields: "id,name,permitted_tasks"
        }
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
            `https://graph.facebook.com/v22.0/${biz.id}/${edge}`,
            {
              params: {
                access_token: longLivedUserToken,
                fields
              }
            }
          );

          const edgePages =
            ((edgeRes.data && edgeRes.data.data) as GraphPage[]) || [];

          pages.push(
            ...edgePages.map((p) => ({
              ...p,
              source:
                edge === "owned_pages"
                  ? ("business_owned" as const)
                  : ("business_client" as const),
              businessName: biz.name ?? null
            }))
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

  // Deduplicate by page id (merge metadata)
  const dedup = new Map<string, GraphPage>();
  for (const p of pages) {
    if (!p || !p.id) continue;
    const existing = dedup.get(p.id);
    dedup.set(p.id, { ...(existing || {}), ...p });
  }

  return Array.from(dedup.values());
}


// Utility: ensure Meta config exists
function assertMetaConfigured() {
  if (!config.metaAppId || !config.metaAppSecret || !config.metaRedirectUri) {
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
router.get(
  "/bots/meta/:botId/connect",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      assertMetaConfigured();

      const { botId } = req.params;
      const typeParam = String(req.query.type || "FACEBOOK").toUpperCase();
      const channelType =
        typeParam === "INSTAGRAM" ? "INSTAGRAM" : "FACEBOOK";

      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const user = req.user;

      // Check bot ownership
      const bot = await prisma.bot.findUnique({
        where: { id: botId }
      });

      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }

      if (user.role !== "ADMIN" && bot.userId !== user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Optionally enforce only ACTIVE bots can connect channels
      /*
      if (bot.status !== "ACTIVE") {
        return res
          .status(400)
          .json({ error: "Bot must be active before connecting channels" });
      }
      */

      // Encode state as signed JWT (prevents tampering)
      const stateToken = jwt.sign(
        {
          botId,
          userId: user.id,
          channelType
        },
        config.jwtAccessSecret,
        { expiresIn: "10m" }
      );

      // 👇 add business_management also for FACEBOOK
      const scopes =
        channelType === "FACEBOOK"
          ? [
              "pages_show_list",
              "pages_messaging",
              "pages_manage_metadata",
              "business_management"
            ]
          : [
              "pages_show_list",
              "instagram_basic",
              "instagram_manage_messages",
              "business_management",
              "pages_manage_metadata"
            ];

      const authUrl = new URL("https://www.facebook.com/v22.0/dialog/oauth");
      authUrl.searchParams.set("client_id", config.metaAppId!);
      authUrl.searchParams.set("redirect_uri", config.metaRedirectUri!);
      authUrl.searchParams.set("state", stateToken);
      authUrl.searchParams.set("scope", scopes.join(","));

      return res.json({ url: authUrl.toString() });
    } catch (err: any) {
      console.error("Meta connect URL error", err);
      return res
        .status(500)
        .json({ error: err.message || "Failed to start Meta connection" });
    }
  }
);

/**
 * STEP 2
 * GET /api/meta/oauth/callback?code=...&state=...
 */
router.get("/meta/oauth/callback", async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!code || typeof code !== "string" || !state || typeof state !== "string") {
    return res.status(400).send("Missing code or state");
  }

  try {
    assertMetaConfigured();
  } catch (err: any) {
    console.error("Meta not configured", err);
    return res.status(500).send("Meta app not configured");
  }

  let decoded: {
    botId: string;
    userId: string;
    channelType: "FACEBOOK" | "INSTAGRAM";
  };
  try {
    decoded = jwt.verify(state, config.jwtAccessSecret) as any;
  } catch (err) {
    console.error("Invalid Meta state token", err);
    return res.status(400).send("Invalid state");
  }

  const { botId, userId, channelType } = decoded;

  try {
    // Double-check bot + owner still valid
    const bot = await prisma.bot.findUnique({
      where: { id: botId }
    });

    if (!bot) {
      return res.status(400).send("Bot not found");
    }

    if (bot.userId !== userId) {
      return res.status(400).send("User no longer owns this bot");
    }

    // 1) Short-lived user token
    const tokenRes = await axios.get(
      "https://graph.facebook.com/v22.0/oauth/access_token",
      {
        params: {
          client_id: config.metaAppId!,
          client_secret: config.metaAppSecret!,
          redirect_uri: config.metaRedirectUri!,
          code
        }
      }
    );

    const shortLivedUserToken = tokenRes.data.access_token as string;

    // 2) Exchange for long-lived token
    const longLivedRes = await axios.get(
      "https://graph.facebook.com/v22.0/oauth/access_token",
      {
        params: {
          grant_type: "fb_exchange_token",
          client_id: config.metaAppId!,
          client_secret: config.metaAppSecret!,
          fb_exchange_token: shortLivedUserToken
        }
      }
    );

    const longLivedUserToken = longLivedRes.data.access_token as string;

    // 3) Get pages this user can access (direct + business fallback)
    const pages = await fetchUserPagesWithBusinessFallback(longLivedUserToken);

    if (!pages || pages.length === 0) {
      return res.status(400).send("No pages found for this account");
    }

    // Create MetaConnectSession
    const session = await prisma.metaConnectSession.create({
      data: {
        botId,
        userId,
        channelType,
        pagesJson: pages,
        longLivedUserToken
      }
    });

    const frontendOrigin =
      process.env.FRONTEND_ORIGIN || "http://localhost:5173";

    const redirectUrl = new URL(
      `/app/bots/${botId}/channels`,
      frontendOrigin
    );
    redirectUrl.searchParams.set("metaSessionId", session.id);

    return res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error("Meta OAuth callback error", err);
    return res.status(500).send("Failed to connect Meta account");
  }
});

/**
 * STEP 3a
 * GET /api/meta/sessions/:sessionId
 */
router.get(
  "/meta/sessions/:sessionId",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { sessionId } = req.params;
      const user = req.user;

      const session = await prisma.metaConnectSession.findUnique({
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

      const rawPages = session.pagesJson as any[];

      const pages = rawPages.map((p) => ({
        id: p.id as string,
        name: p.name as string,
        // consider both business + connected IG
        instagramBusinessId:
          p.instagram_business_account?.id ||
          p.connected_instagram_account?.id ||
          null,
        isBusinessManaged:
          p.source === "business_owned" || p.source === "business_client",
        businessName:
          typeof p.businessName === "string" ? p.businessName : null
      }));

      return res.json({
        id: session.id,
        botId: session.botId,
        channelType: session.channelType,
        pages,
        createdAt: session.createdAt.toISOString()
      });
    } catch (err: any) {
      console.error("Meta session load error", err);
      return res
        .status(500)
        .json({ error: err.message || "Failed to load Meta session" });
    }
  }
);

/**
 * STEP 3b
 * POST /api/meta/sessions/:sessionId/attach
 * - calls debugToken() and stores tokenExpiresAt in meta
 */
router.post(
  "/meta/sessions/:sessionId/attach",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const user = req.user;
      const { sessionId } = req.params;
      const { pageId } = req.body as { pageId?: string };

      if (!pageId) {
        return res.status(400).json({ error: "Missing pageId" });
      }

      const session = await prisma.metaConnectSession.findUnique({
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

      const rawPages = session.pagesJson as any[];
      const selectedPage = rawPages.find((p) => p.id === pageId);

      if (!selectedPage) {
        return res
          .status(400)
          .json({ error: "Selected page not found in session pages" });
      }

      const pageAccessToken = selectedPage.access_token as string;
      const pageName = selectedPage.name as string;
      const igBusinessId =
        selectedPage.instagram_business_account?.id ||
        selectedPage.connected_instagram_account?.id ||
        null;

      const debugRes = await debugToken(pageAccessToken);
      const tokenExpiresAtIso = debugRes.expiresAt
        ? debugRes.expiresAt.toISOString()
        : null;

      // NEW: load IG profile when attaching Instagram
      let igUsername: string | null = null;
      let igName: string | null = null;

      if (session.channelType === "INSTAGRAM" && igBusinessId) {
        try {
          const igRes = await axios.get(
            `https://graph.facebook.com/v22.0/${igBusinessId}`,
            {
              params: {
                access_token: pageAccessToken,
                fields: "username,name,profile_picture_url"
              },
              timeout: 10000
            }
          );

          igUsername = igRes.data?.username ?? null;
          igName = igRes.data?.name ?? null;

          console.log("[Meta] Loaded IG profile", {
            igBusinessId,
            igUsername,
            igName
          });
        } catch (err: any) {
          console.warn(
            "[Meta] Failed to load IG profile",
            igBusinessId,
            err.response?.data || err
          );
        }
      }

      let botChannel;
      if (session.channelType === "FACEBOOK") {
        botChannel = await prisma.botChannel.upsert({
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
      } else {
        if (!igBusinessId) {
          return res.status(400).json({
            error:
              "Selected page does not have an Instagram business account attached"
          });
        }

        botChannel = await prisma.botChannel.upsert({
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
              igUsername,
              igName,
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
              igUsername,
              igName,
              longLivedUserToken: session.longLivedUserToken,
              tokenExpiresAt: tokenExpiresAtIso
            }
          }
        });
      }

      // Subscribe page to webhooks (best effort)
      if (config.metaGraphApiBaseUrl) {
        try {
          await axios.post(
            `${config.metaGraphApiBaseUrl}/${selectedPage.id}/subscribed_apps`,
            null,
            {
              params: {
                subscribed_fields:
                  "messages,messaging_postbacks,message_reactions",
                access_token: pageAccessToken
              },
              timeout: 10000
            }
          );
        } catch (err) {
          console.error("Failed to subscribe page to webhooks", err);
        }
      }

      // Clean up session
      await prisma.metaConnectSession.delete({
        where: { id: session.id }
      });

      return res.json(botChannel);
    } catch (err: any) {
      console.error("Meta attach error", err);
      return res
        .status(500)
        .json({ error: err.message || "Failed to attach Meta page" });
    }
  }
);

export default router;
