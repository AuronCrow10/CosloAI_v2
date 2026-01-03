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

/**
 * STEP 1 – embedded signup callback from JS SDK
 * POST /api/bots/:botId/whatsapp/embedded/complete
 * Body: { code }
 *
 * - Exchanges code -> waAccessToken
 * - Finds WABA + phone_numbers
 * - Stores in WhatsappConnectSession
 * - Returns { sessionId, numbers: [...] }
 */
router.post(
  "/bots/:botId/whatsapp/embedded/complete",
  requireAuth,
  async (req: Request, res: Response) => {
    const { botId } = req.params;
    const { code } = req.body as { code?: string };

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
      const params: Record<string, string> = {
        client_id: config.metaAppId!,
        client_secret: config.metaAppSecret!,
        code
      };

      if (config.whatsappEmbeddedRedirectUri) {
        params.redirect_uri = config.whatsappEmbeddedRedirectUri;
      } else if (config.metaRedirectUri) {
        params.redirect_uri = config.metaRedirectUri;
      }

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

      const waScope =
        granularScopes.find(
          (g) =>
            g.scope === "whatsapp_business_messaging" ||
            g.scope === "whatsapp_business_management"
        ) || granularScopes[0];

      const wabaId = waScope?.target_ids?.[0];

      if (!wabaId) {
        console.error("No WABA id found in granular_scopes", debugData);
        return res.status(400).json({
          error:
            "Could not determine WhatsApp Business Account from the embedded signup token"
        });
      }

      // 3) Fetch phone numbers for this WABA
      const phoneRes = await axios.get(
        `https://graph.facebook.com/v22.0/${wabaId}/phone_numbers`,
        {
          params: {
            access_token: waAccessToken,
            fields: "id,display_phone_number,verified_name"
          }
        }
      );

      const phones: Array<{
        id: string;
        display_phone_number?: string;
        verified_name?: string;
      }> = phoneRes.data?.data || [];

      if (!phones.length) {
        return res.status(400).json({
          error: "No WhatsApp phone numbers found for this business account"
        });
      }

      // 4) Create WhatsappConnectSession
      const session = await prisma.whatsappConnectSession.create({
        data: {
          botId: bot.id,
          userId: user.id,
          wabaId,
          waAccessToken,
          phoneNumbersJson: phones
        }
      });

      // 5) Return session + numbers
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
 * Body: { phoneId }
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
      const { phoneId } = req.body as { phoneId?: string };

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
            verifiedName
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
            verifiedName
          }
        }
      });

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
