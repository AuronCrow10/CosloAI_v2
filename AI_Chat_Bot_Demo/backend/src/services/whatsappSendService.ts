// src/services/whatsappSendService.ts
import axios from "axios";
import { prisma } from "../prisma/prisma";
import { config } from "../config";
import { normalizeAxiosError, isWhatsAppAuthError, markWhatsAppNeedsReconnect } from "../routes/whatsappWebhook"; // or extract these helpers out of whatsappWebhook.ts

export async function sendLeadWhatsAppTemplate(
  requestId: string,
  botId: string,
  toPhone: string, // must be in E.164 (+39...) before you call this
  templateName: string,
  languageCode: string,
  components?: any[]
) {
  const channel = await prisma.botChannel.findFirst({
    where: { botId, type: "WHATSAPP" }
  });

  if (!channel) {
    throw new Error("WhatsApp channel not found for bot");
  }

  if (!config.whatsappApiBaseUrl) {
    throw new Error("whatsappApiBaseUrl not configured");
  }

  const phoneNumberId = channel.externalId; // set in whatsappEmbedded attach :contentReference[oaicite:9]{index=9}
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

    // you can log with same logger style as whatsappWebhook.ts
    return resp.data;
  } catch (err: any) {
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