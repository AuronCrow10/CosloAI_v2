import axios from "axios";
import { config } from "../config";

export interface SendFacebookTextParams {
  pageId: string;
  accessToken: string;
  recipientId: string; // USER_PSID
  text: string;
}

export interface SendInstagramTextParams {
  igBusinessId: string;
  accessToken: string;
  recipientId: string; // IG user PSID
  text: string;
}

function getBaseUrl(): string {
  const base = config.metaGraphApiBaseUrl;
  if (!base) {
    throw new Error("META_GRAPH_API_BASE_URL is not configured");
  }
  return base.replace(/\/+$/, ""); // trim trailing slash
}

export async function sendFacebookTextMessage(params: SendFacebookTextParams): Promise<void> {
  const { pageId, accessToken, recipientId, text } = params;
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/${pageId}/messages`;

  await axios.post(
    url,
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { text }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10_000
    }
  );
}

export async function sendInstagramTextMessage(params: SendInstagramTextParams): Promise<void> {
  const { igBusinessId, accessToken, recipientId, text } = params;
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/${igBusinessId}/messages`;

  await axios.post(
    url,
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { text }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: 10_000
    }
  );
}
