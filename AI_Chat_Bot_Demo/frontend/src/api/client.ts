// src/api/client.ts

export interface BotInfo {
  slug: string;
  name: string;
  description?: string;
}

export interface ChatResponse {
  conversationId: string | null;
  reply: string;
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

export async function handleJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Invalid JSON response from server");
  }
  if (!response.ok) {
    const errMsg =
      (data &&
        typeof data === "object" &&
        "error" in data &&
        (data as any).error) ||
      `Request failed with status ${response.status}`;
    throw new Error(String(errMsg));
  }
  return data as T;
}

// ---- DEMO-SPECIFIC APIs (keep behavior) ----

export async function fetchBotInfo(slug: string): Promise<BotInfo> {
  const res = await fetch(`${API_BASE_URL}/bots/live/${encodeURIComponent(slug)}`);
  console.log(res);
  return handleJsonResponse<BotInfo>(res);
}

export async function sendChatMessage(
  slug: string,
  body: { message: string; conversationId?: string | null }
): Promise<ChatResponse> {
  const res = await fetch(`${API_BASE_URL}/chat/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return handleJsonResponse<ChatResponse>(res);
}
