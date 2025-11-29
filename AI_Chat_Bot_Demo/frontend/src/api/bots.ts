import { API_BASE_URL, handleJsonResponse } from "./client";
import { getStoredAccessToken } from "./auth";

export type BotStatus =
  | "DRAFT"
  | "PENDING_PAYMENT"
  | "ACTIVE"
  | "SUSPENDED"
  | "CANCELED";

export interface Bot {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description?: string | null;
  systemPrompt: string;
  knowledgeClientId?: string | null;
  domain?: string | null;
  useDomainCrawler: boolean;
  usePdfCrawler: boolean;
  channelWeb: boolean;
  channelWhatsapp: boolean;
  channelInstagram: boolean;
  channelMessenger: boolean;
  useCalendar: boolean;
  status: BotStatus;
  createdAt: string;
  updatedAt: string;
  calendarId?: string | null;
  timeZone?: string | null;
  defaultDurationMinutes?: number | null;
}

export type ChannelType = "WEB" | "WHATSAPP" | "FACEBOOK" | "INSTAGRAM";

export interface BotChannel {
  id: string;
  botId: string;
  type: ChannelType;
  externalId: string;
  accessToken: string;
  meta?: any;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  botId: string;
  channel: ChannelType;
  externalUserId: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  channelMessageId?: string | null;
  createdAt: string;
}

export interface CheckoutResponse {
  checkoutUrl: string;
}

// --- Pricing preview types ---

export type FeatureCode =
  | "DOMAIN_CRAWLER"
  | "PDF_CRAWLER"
  | "CHANNEL_WEB"
  | "WHATSAPP"
  | "MESSENGER"
  | "INSTAGRAM"
  | "CALENDAR";

export interface BotPricingLineItem {
  code: FeatureCode;
  label: string;
  monthlyAmountCents: number;
  monthlyAmountFormatted: string;
  currency: string;
}

export interface BotPricingPreview {
  lineItems: BotPricingLineItem[];
  totalAmountCents: number;
  totalAmountFormatted: string;
  currency: string;
}

export interface BotPricingPreviewPayload {
  useDomainCrawler?: boolean;
  usePdfCrawler?: boolean;
  channelWeb?: boolean;
  channelWhatsapp?: boolean;
  channelMessenger?: boolean;
  channelInstagram?: boolean;
  useCalendar?: boolean;
}

function authHeaders(): HeadersInit {
  const token = getStoredAccessToken();
  const base: HeadersInit = {
    "Content-Type": "application/json"
  };
  if (token) {
    return {
      ...base,
      Authorization: `Bearer ${token}`
    };
  }
  return base;
}

// ---- Bots ----

export async function fetchBots(): Promise<Bot[]> {
  const res = await fetch(`${API_BASE_URL}/bots`, {
    headers: authHeaders()
  });
  return handleJsonResponse<Bot[]>(res);
}

export interface CreateBotPayload {
  name: string;
  slug: string;
  description?: string;

  systemPrompt?: string;
  domain?: string;

  useDomainCrawler?: boolean;
  usePdfCrawler?: boolean;
  channelWeb?: boolean;
  channelWhatsapp?: boolean;
  channelInstagram?: boolean;
  channelMessenger?: boolean;
  useCalendar?: boolean;

  calendarId?: string | null;
  timeZone?: string | null;
  defaultDurationMinutes?: number | null;
}

export async function createBot(
  payload: CreateBotPayload
): Promise<Bot> {
  const res = await fetch(`${API_BASE_URL}/bots`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  return handleJsonResponse<Bot>(res);
}

export interface UpdateBotPayload {
  name?: string;
  description?: string;
  systemPrompt?: string;
  domain?: string | null;
  useDomainCrawler?: boolean;
  usePdfCrawler?: boolean;
  channelWeb?: boolean;
  channelWhatsapp?: boolean;
  channelInstagram?: boolean;
  channelMessenger?: boolean;
  useCalendar?: boolean;
  status?: BotStatus;
  calendarId?: string | null;
  timeZone?: string | null;
  defaultDurationMinutes?: number | null;
}

export async function updateBot(
  id: string,
  payload: UpdateBotPayload
): Promise<Bot> {
  const res = await fetch(`${API_BASE_URL}/bots/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  return handleJsonResponse<Bot>(res);
}

export async function deleteBot(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/bots/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders()
  });
  await handleJsonResponse<unknown>(res);
}

export async function getBotById(id: string): Promise<Bot> {
  const res = await fetch(`${API_BASE_URL}/bots/${encodeURIComponent(id)}`, {
    headers: authHeaders()
  });
  return handleJsonResponse<Bot>(res);
}

// ---- Stripe Checkout ----

export async function startBotCheckout(
  id: string
): Promise<CheckoutResponse> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(id)}/checkout`,
    {
      method: "POST",
      headers: authHeaders()
    }
  );
  return handleJsonResponse<CheckoutResponse>(res);
}

export async function getBotPricingPreview(
  id: string,
  payload?: BotPricingPreviewPayload
): Promise<BotPricingPreview> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(id)}/pricing-preview`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload || {})
    }
  );
  return handleJsonResponse<BotPricingPreview>(res);
}

export async function cancelBotSubscription(id: string): Promise<Bot> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(id)}/cancel-subscription`,
    {
      method: "POST",
      headers: authHeaders()
    }
  );
  return handleJsonResponse<Bot>(res);
}

export async function crawlBotDomain(
  botId: string,
  domainOverride?: string
): Promise<{ status: string; knowledgeClientId: string; domain: string }> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(
      botId
    )}/knowledge/crawl-domain`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(
        domainOverride ? { domain: domainOverride } : {}
      )
    }
  );
  return handleJsonResponse(res);
}

export async function uploadBotDocuments(
  botId: string,
  files: FileList | File[]
): Promise<{ status: string; knowledgeClientId: string; files: string[] }> {
  const formData = new FormData();
  Array.from(files).forEach((file) => {
    formData.append("files", file);
  });

  const token = getStoredAccessToken();
  const headers: HeadersInit = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(
      botId
    )}/knowledge/upload-docs`,
    {
      method: "POST",
      headers,
      body: formData
    }
  );
  return handleJsonResponse(res);
}

// ---- Channels ----

export async function fetchChannels(
  botId: string
): Promise<BotChannel[]> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(botId)}/channels`,
    {
      headers: authHeaders()
    }
  );
  return handleJsonResponse<BotChannel[]>(res);
}

export interface CreateChannelPayload {
  type: ChannelType;
  externalId: string;
  accessToken: string;
  meta?: any;
}

export async function createChannel(
  botId: string,
  payload: CreateChannelPayload
): Promise<BotChannel> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(botId)}/channels`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload)
    }
  );
  return handleJsonResponse<BotChannel>(res);
}

export interface UpdateChannelPayload {
  externalId?: string;
  accessToken?: string;
  meta?: any;
}

export async function updateChannel(
  botId: string,
  channelId: string,
  payload: UpdateChannelPayload
): Promise<BotChannel> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(
      botId
    )}/channels/${encodeURIComponent(channelId)}`,
    {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(payload)
    }
  );
  return handleJsonResponse<BotChannel>(res);
}

export async function deleteChannel(
  botId: string,
  channelId: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(
      botId
    )}/channels/${encodeURIComponent(channelId)}`,
    {
      method: "DELETE",
      headers: authHeaders()
    }
  );
  await handleJsonResponse<unknown>(res);
}

// ---- Conversations ----

export async function fetchBotConversations(
  botId: string
): Promise<Conversation[]> {
  const res = await fetch(
    `${API_BASE_URL}/conversations/bots/${encodeURIComponent(botId)}`,
    {
      headers: authHeaders()
    }
  );
  return handleJsonResponse<Conversation[]>(res);
}

export async function fetchConversationMessages(
  conversationId: string
): Promise<ConversationMessage[]> {
  const res = await fetch(
    `${API_BASE_URL}/conversations/${encodeURIComponent(
      conversationId
    )}/messages`,
    {
      headers: authHeaders()
    }
  );
  return handleJsonResponse<ConversationMessage[]>(res);
}

// ---- Meta connect helpers ----

export interface MetaPageSummary {
  id: string;
  name: string;
  instagramBusinessId?: string | null;
}

export interface MetaSessionResponse {
  id: string;
  botId: string;
  channelType: ChannelType;
  pages: MetaPageSummary[];
  createdAt: string;
}

export async function getMetaConnectUrl(
  botId: string,
  type: "FACEBOOK" | "INSTAGRAM"
): Promise<{ url: string }> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(
      botId
    )}/meta/connect?type=${encodeURIComponent(type)}`,
    {
      headers: authHeaders()
    }
  );
  return handleJsonResponse<{ url: string }>(res);
}

export async function getMetaSession(
  sessionId: string
): Promise<MetaSessionResponse> {
  const res = await fetch(
    `${API_BASE_URL}/meta/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: authHeaders()
    }
  );
  return handleJsonResponse<MetaSessionResponse>(res);
}

export async function attachMetaSession(
  sessionId: string,
  pageId: string
): Promise<BotChannel> {
  const res = await fetch(
    `${API_BASE_URL}/meta/sessions/${encodeURIComponent(
      sessionId
    )}/attach`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ pageId })
    }
  );
  return handleJsonResponse<BotChannel>(res);
}

// ---- WhatsApp embedded signup helpers ----

export interface WhatsappNumberSummary {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}

export interface WhatsappConnectSessionResponse {
  sessionId: string;
  numbers: WhatsappNumberSummary[];
}

export async function completeWhatsappEmbeddedSignup(
  botId: string,
  payload: { code: string }
): Promise<WhatsappConnectSessionResponse> {
  const res = await fetch(
    `${API_BASE_URL}/bots/${encodeURIComponent(
      botId
    )}/whatsapp/embedded/complete`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload)
    }
  );
  return handleJsonResponse<WhatsappConnectSessionResponse>(res);
}

export async function attachWhatsappSession(
  sessionId: string,
  phoneId: string
): Promise<BotChannel> {
  const res = await fetch(
    `${API_BASE_URL}/whatsapp/sessions/${encodeURIComponent(
      sessionId
    )}/attach`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ phoneId })
    }
  );
  return handleJsonResponse<BotChannel>(res);
}
