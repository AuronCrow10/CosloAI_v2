// routes/whatsappEmbedded.ts
import { Router, Request, Response } from "express";
import axios from "axios";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";

const router = Router();

function assertWhatsAppEmbeddedConfigured() {
  if (!config.metaAppId || !config.metaAppSecret) {
    throw new Error(
      "Meta app ID/secret not configured for WhatsApp embedded signup"
    );
  }
}

function resolveWhatsAppRedirectUri(provided?: string): string | null {
  console.log("resolveWhatsAppRedirectUri", provided);

  if (provided) {
    try {
      const url = new URL(provided);
      const frontendOrigin = process.env.FRONTEND_ORIGIN;
      if (frontendOrigin) {
        const allowedOrigin = new URL(frontendOrigin).origin;
        if (url.origin !== allowedOrigin) return null;
      }
      return provided;
    } catch {
      return null;
    }
  }

  return config.whatsappEmbeddedRedirectUri || config.metaRedirectUri || null;
}

/**
 * STEP 1 – embedded signup callback from JS SDK
 * POST /api/bots/:botId/whatsapp/embedded/complete
 * Body: { code, redirectUri? }
 *
 * - Exchanges code -> waAccessToken
 * - Finds WABA + phone_numbers
 * - Stores in WhatsappConnectSession
 * - Returns { sessionId, numbers: [.] }
 */
router.post(
  "/bots/:botId/whatsapp/embedded/complete",
  requireAuth,
  async (req: Request, res: Response) => {
    const { botId } = req.params;
    const { code, redirectUri } = req.body as {
      code?: string;
      redirectUri?: string;
    };

    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }

    try {
      assertWhatsAppEmbeddedConfigured();
    } catch (err: any) {
      console.error("WhatsApp embedded not configured", err);
      return res
        .status(500)
        .json({ error: "WhatsApp embedded not configured" });
    }

    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const user = req.user;

      const bot = await prisma.bot.findUnique({
        where: { id: botId }
      });

      if (!bot) {
        return res.status(404).json({ error: "Bot not found" });
      }

      if (user.role !== "ADMIN" && bot.userId !== user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      /*
      if (bot.status !== "ACTIVE") {
        return res.status(400).json({
          error: "Bot must be active before connecting WhatsApp"
        });
      }
      */

      // 1) Exchange code -> waAccessToken
      const resolvedRedirectUri = resolveWhatsAppRedirectUri(redirectUri);

      const params: Record<string, string> = {
        client_id: config.metaAppId!,
        client_secret: config.metaAppSecret!,
        code
      };

      const tokenRes = await axios.get(
        "https://graph.facebook.com/v22.0/oauth/access_token",
        { params }
      );

      const waAccessToken = tokenRes.data.access_token as string;
      if (!waAccessToken) {
        return res
          .status(500)
          .json({ error: "Did not receive WhatsApp access token" });
      }

      // 2) debug_token -> WABA id
      const appAccessToken = `${config.metaAppId}|${config.metaAppSecret}`;
      const debugRes = await axios.get(
        "https://graph.facebook.com/v22.0/debug_token",
        {
          params: {
            input_token: waAccessToken,
            access_token: appAccessToken
          }
        }
      );

      const debugData = debugRes.data?.data;
      const granularScopes =
        (debugData?.granular_scopes as Array<{
          scope: string;
          target_ids?: string[];
        }>) || [];

      const whatsappScopes = granularScopes.filter(
        (g) =>
          g.scope === "whatsapp_business_messaging" ||
          g.scope === "whatsapp_business_management"
      );

      const wabaId = whatsappScopes.flatMap((g) => g.target_ids || [])[0];

      if (!wabaId) {
        console.error("No WABA id found in granular_scopes", debugData);
        return res.status(400).json({
          error:
            "Could not determine WhatsApp Business Account from the embedded signup token"
        });
      }

      // 3) Fetch phone numbers for this WABA (include certificate)
      const phoneRes = await axios.get(
        `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
        {
          params: {
            access_token: waAccessToken,
            // NEW: fetch certificate as well
            fields: "id,display_phone_number,verified_name,certificate"
          }
        }
      );

      const phones: Array<{
        id: string;
        display_phone_number?: string;
        verified_name?: string;
        certificate?: string;
      }> = phoneRes.data?.data || [];

      if (!phones.length) {
        return res.status(400).json({
          error: "No WhatsApp phone numbers found for this business account"
        });
      }

      // 4) Create WhatsappConnectSession (we keep certificate inside phoneNumbersJson)
      const session = await prisma.whatsappConnectSession.create({
        data: {
          botId: bot.id,
          userId: user.id,
          wabaId,
          waAccessToken,
          phoneNumbersJson: phones
        }
      });

      // 5) Return session + numbers (no certificate in response)
      return res.json({
        sessionId: session.id,
        numbers: phones.map((p) => ({
          id: p.id,
          displayPhoneNumber: p.display_phone_number || null,
          verifiedName: p.verified_name || null
        }))
      });
    } catch (err: any) {
      console.error(
        "WhatsApp embedded complete error",
        err?.response?.data || err
      );
      return res
        .status(500)
        .json({ error: err.message || "Failed to complete WhatsApp signup" });
    }
  }
);

/**
 * STEP 2 – attach a specific phone number to the bot
 * POST /api/whatsapp/sessions/:sessionId/attach
 * Body: { phoneId, pin? }
 */
router.post(
  "/whatsapp/sessions/:sessionId/attach",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const user = req.user;
      const { sessionId } = req.params;
      const { phoneId, pin } = req.body as {
        phoneId?: string;
        pin?: string;
      };

      if (!phoneId) {
        return res.status(400).json({ error: "Missing phoneId" });
      }

      const session = await prisma.whatsappConnectSession.findUnique({
        where: { id: sessionId },
        include: { bot: true }
      });

      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const bot = session.bot;

      if (user.role !== "ADMIN" && bot.userId !== user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const rawPhones = session.phoneNumbersJson as any[];
      const selectedPhone = rawPhones.find((p) => p.id === phoneId);

      if (!selectedPhone) {
        return res
          .status(400)
          .json({ error: "Selected phone not found in session" });
      }

      const phoneNumberId = selectedPhone.id as string;
      const displayPhoneNumber =
        (selectedPhone.display_phone_number as string | undefined) || null;
      const verifiedName =
        (selectedPhone.verified_name as string | undefined) || null;
      const certificate: string | undefined =
        typeof selectedPhone.certificate === "string"
          ? selectedPhone.certificate
          : undefined;

      const graphBaseUrl =
        config.metaGraphApiBaseUrl || "https://graph.facebook.com/v22.0";

      // ✅ NEW: register the phone number with Cloud API
      const registerPayload: {
        messaging_product: "whatsapp";
        certificate?: string;
        pin?: string;
      } = {
        messaging_product: "whatsapp"
      };

      if (certificate) {
        registerPayload.certificate = certificate;
      }

      const trimmedPin = typeof pin === "string" ? pin.trim() : "";
      if (trimmedPin) {
        registerPayload.pin = trimmedPin;
      }

      try {
        await axios.post(
          `${graphBaseUrl}/${phoneNumberId}/register`,
          registerPayload,
          {
            params: {
              access_token: session.waAccessToken
            },
            timeout: 10000
          }
        );
      } catch (err: any) {
        const errData = err?.response?.data;
        const msg: string | undefined =
          errData?.error?.message || errData?.message;

        // If already registered we just continue; otherwise bubble up
        if (!msg || !msg.toLowerCase().includes("already registered")) {
          console.error(
            "Failed to register WhatsApp phone number",
            errData || err
          );
          return res.status(500).json({
            error: "Failed to register WhatsApp phone number"
          });
        }

        console.warn(
          "WhatsApp phone number already registered, continuing",
          errData || err
        );
      }

      // Debug token to compute expiry (unchanged logic)
      let tokenExpiresAt: string | null = null;
      try {
        const appAccessToken = `${config.metaAppId}|${config.metaAppSecret}`;
        const debugRes = await axios.get(`${graphBaseUrl}/debug_token`, {
          params: {
            input_token: session.waAccessToken,
            access_token: appAccessToken
          },
          timeout: 10000
        });
        const expiresAt = debugRes.data?.data?.expires_at;
        if (typeof expiresAt === "number") {
          tokenExpiresAt = new Date(expiresAt * 1000).toISOString();
        }
      } catch (err: any) {
        console.warn(
          "Failed to debug WhatsApp access token",
          err?.response?.data || err
        );
      }

      const botChannel = await prisma.botChannel.upsert({
        where: {
          botId_type_externalId: {
            botId: bot.id,
            type: "WHATSAPP",
            externalId: phoneNumberId
          }
        },
        update: {
          accessToken: session.waAccessToken,
          meta: {
            wabaId: session.wabaId,
            displayPhoneNumber,
            verifiedName,
            tokenExpiresAt
          }
        },
        create: {
          botId: bot.id,
          type: "WHATSAPP",
          externalId: phoneNumberId,
          accessToken: session.waAccessToken,
          meta: {
            wabaId: session.wabaId,
            displayPhoneNumber,
            verifiedName,
            tokenExpiresAt
          }
        }
      });

      // Subscribe WABA to webhooks (unchanged)
      if (session.wabaId && session.waAccessToken) {
        try {
          await axios.post(
            `${graphBaseUrl}/${session.wabaId}/subscribed_apps`,
            null,
            {
              params: {
                access_token: session.waAccessToken
              },
              timeout: 10000
            }
          );
        } catch (err: any) {
          console.warn(
            "Failed to subscribe WABA to webhooks",
            err?.response?.data || err
          );
        }
      }

      await prisma.whatsappConnectSession.delete({
        where: { id: session.id }
      });

      return res.json(botChannel);
    } catch (err: any) {
      console.error("WhatsApp attach error", err);
      return res
        .status(500)
        .json({ error: err.message || "Failed to attach WhatsApp number" });
    }
  }
);

export default router;
