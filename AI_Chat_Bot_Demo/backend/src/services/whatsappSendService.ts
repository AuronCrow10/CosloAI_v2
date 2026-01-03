// src/services/whatsappSendService.ts
import axios from "axios";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import { normalizeAxiosError, isWhatsAppAuthError, markWhatsAppNeedsReconnect } from "../routes/whatsappWebhook"; // or extract these helpers out of whatsappWebhook.ts
import {
  ensureBotHasTokens,
  WHATSAPP_MESSAGE_TOKEN_COST
} from "./planUsageService";

export async function sendLeadWhatsAppTemplate(
  requestId: string,
  botId: string,
  toPhone: string,
  templateName: string,
  languageCode: string,
  components?: any[]
) {
  // Token quota check for lead WA messages
  const quota = await ensureBotHasTokens(botId, WHATSAPP_MESSAGE_TOKEN_COST);
  if (!quota.ok) {
    const err: any = new Error("WhatsApp lead message quota exceeded");
    err.code = "TOKEN_QUOTA_EXCEEDED";
    err.usedThisPeriod = quota.snapshot?.usedTokensTotal;
    err.limit = quota.snapshot?.monthlyTokenLimit;
    throw err;
  }

  const channel = await prisma.botChannel.findFirst({
    where: { botId, type: "WHATSAPP" }
  });

  if (!channel) {
    throw new Error("WhatsApp channel not found for bot");
  }

  if (!config.whatsappApiBaseUrl) {
    throw new Error("whatsappApiBaseUrl not configured");
  }

  const phoneNumberId = channel.externalId;
  const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;

  const accessToken = channel.accessToken || config.whatsappAccessToken;
  if (!accessToken) {
    throw new Error("Missing WhatsApp access token");
  }

  const body: any = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode }
    }
  };

  if (components && components.length > 0) {
    body.template.components = components;
  }

  try {
    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });

    return resp.data;
  } catch (err) {
    const n = normalizeAxiosError(err);
    // log error, then mark needsReconnect if auth issue
    if (isWhatsAppAuthError(err)) {
      await markWhatsAppNeedsReconnect(requestId, channel.id, "lead_template_send_auth_error");
    }
    throw new Error(
      `WhatsApp send failed (status=${n.status ?? "unknown"})`
    );
  }
}