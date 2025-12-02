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
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Invalid JSON response from server");
  }

  if (!response.ok) {
    let errMsg = `Request failed with status ${response.status}`;

    if (data && typeof data === "object" && "error" in data) {
      const err = (data as any).error;

      if (typeof err === "string") {
        // Caso semplice: { error: "message" }
        errMsg = err;
      } else if (err && typeof err === "object") {
        // Caso Zod flatten: { formErrors, fieldErrors }
        const formErrors = Array.isArray(err.formErrors) ? err.formErrors : [];

        const fieldErrorsObj = err.fieldErrors || {};
        const fieldErrorStrings = Object.values(fieldErrorsObj)
          .flat()
          .filter(Boolean) as string[];

        const allErrors = [...formErrors, ...fieldErrorStrings];

        if (allErrors.length > 0) {
          errMsg = allErrors.join("\n");
        }
      }
    }

    throw new Error(errMsg);
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
