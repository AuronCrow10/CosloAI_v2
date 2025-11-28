import axios from "axios";
import { config } from "../config";

export interface SendWhatsAppTextMessageParams {
  phoneNumberId: string;
  to: string;   // user wa_id
  text: string; // message body
}

/**
 * Sends a text message via WhatsApp Cloud API.
 */
export async function sendWhatsAppTextMessage(params: SendWhatsAppTextMessageParams): Promise<void> {
  const { phoneNumberId, to, text } = params;

  if (!config.whatsappApiBaseUrl || !config.whatsappAccessToken) {
    throw new Error("WhatsApp API is not configured");
  }

  const url = `${config.whatsappApiBaseUrl}/${phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      text: {
        body: text
      }
    },
    {
      headers: {
        Authorization: `Bearer ${config.whatsappAccessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10_000
    }
  );
}
