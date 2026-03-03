import crypto from "crypto";
import { prisma } from "../prisma/prisma";
import { ClerkPayload } from "./clerkFlowService";

export type ShoppingMode =
  | "DISCOVERY"
  | "SHORTLIST_SHOWN"
  | "DETAILS_SHOWN"
  | "CHECKOUT"
  | "SUPPORT";

export type ShoppingShortlistItem = {
  productId: string;
  title: string;
  priceMin: string | null;
  priceMax: string | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string | null;
  addToCartUrl: string | null;
  variantId: string | null;
  attrSummary: Array<{ label: string; value: string }>;
};

export type ShoppingState = {
  id: string;
  botId: string;
  conversationId: string | null;
  sessionId: string | null;
  language: "en" | "it" | "es" | "de" | "fr" | null;
  mode: ShoppingMode;
  activeProductType: string | null;
  filters: Record<string, string>;
  shortlist: ShoppingShortlistItem[];
  shortlistHash: string | null;
  lastShortlistAt: string | null;
  detailsProductId: string | null;
  lastDetailsAt: string | null;
  loopCount: number;
  lastRoute: string | null;
  lastIntent: string | null;
  prevRoute: string | null;
  prevIntent: string | null;
  lastUpdatedAt: string | null;
};

const EMPTY_STATE: Omit<ShoppingState, "id" | "botId" | "conversationId" | "sessionId"> = {
  language: null,
  mode: "DISCOVERY",
  activeProductType: null,
  filters: {},
  shortlist: [],
  shortlistHash: null,
  lastShortlistAt: null,
  detailsProductId: null,
  lastDetailsAt: null,
  loopCount: 0,
  lastRoute: null,
  lastIntent: null,
  prevRoute: null,
  prevIntent: null,
  lastUpdatedAt: null
};

function nowIso(): string {
  return new Date().toISOString();
}

function computeShortlistHash(items: ShoppingShortlistItem[]): string | null {
  if (!items || items.length === 0) return null;
  const ids = items.map((i) => i.productId).join("|");
  return crypto.createHash("sha256").update(ids).digest("hex");
}

function normalizeState(data: Partial<ShoppingState>): ShoppingState {
  return {
    id: data.id || crypto.randomUUID(),
    botId: data.botId || "",
    conversationId: data.conversationId ?? null,
    sessionId: data.sessionId ?? null,
    language: data.language ?? null,
    mode: data.mode ?? "DISCOVERY",
    activeProductType: data.activeProductType ?? null,
    filters: data.filters ?? {},
    shortlist: data.shortlist ?? [],
    shortlistHash: data.shortlistHash ?? null,
    lastShortlistAt: data.lastShortlistAt ?? null,
    detailsProductId: data.detailsProductId ?? null,
    lastDetailsAt: data.lastDetailsAt ?? null,
    loopCount: data.loopCount ?? 0,
    lastRoute: data.lastRoute ?? null,
    lastIntent: data.lastIntent ?? null,
    prevRoute: data.prevRoute ?? null,
    prevIntent: data.prevIntent ?? null,
    lastUpdatedAt: data.lastUpdatedAt ?? null
  };
}

export async function loadShoppingState(params: {
  botId: string;
  conversationId: string | null;
  sessionId: string | null;
}): Promise<ShoppingState> {
  const { botId, conversationId, sessionId } = params;

  let row = null;
  if (conversationId) {
    row = await prisma.shoppingSessionState.findFirst({
      where: { botId, conversationId }
    });
  }
  if (!row && sessionId) {
    row = await prisma.shoppingSessionState.findFirst({
      where: { botId, sessionId }
    });
  }

  if (!row) {
    return normalizeState({
      ...EMPTY_STATE,
      botId,
      conversationId,
      sessionId
    });
  }

  const stored = row.stateJson as Partial<ShoppingState>;
  return normalizeState({
    ...EMPTY_STATE,
    ...stored,
    id: row.id,
    botId,
    conversationId: row.conversationId,
    sessionId: row.sessionId
  });
}

export async function saveShoppingState(state: ShoppingState): Promise<void> {
  if (!state.botId) return;
  const now = nowIso();
  const payload = {
    ...state,
    lastUpdatedAt: now
  };

  const uniqueConversation =
    state.conversationId != null ? { botId: state.botId, conversationId: state.conversationId } : null;
  const uniqueSession =
    state.sessionId != null ? { botId: state.botId, sessionId: state.sessionId } : null;

  if (uniqueConversation) {
    await prisma.shoppingSessionState.upsert({
      where: {
        ShoppingSessionState_bot_conversation_unique: uniqueConversation
      },
      update: {
        stateJson: payload,
        sessionId: state.sessionId,
        updatedAt: new Date()
      },
      create: {
        id: state.id || crypto.randomUUID(),
        botId: state.botId,
        conversationId: state.conversationId,
        sessionId: state.sessionId,
        stateJson: payload
      }
    });
    return;
  }

  if (uniqueSession) {
    await prisma.shoppingSessionState.upsert({
      where: {
        ShoppingSessionState_bot_session_unique: uniqueSession
      },
      update: {
        stateJson: payload,
        updatedAt: new Date()
      },
      create: {
        id: state.id || crypto.randomUUID(),
        botId: state.botId,
        conversationId: state.conversationId,
        sessionId: state.sessionId,
        stateJson: payload
      }
    });
  }
}

export function applyRouterToState(
  state: ShoppingState,
  router: { route?: string; intent?: string }
): ShoppingState {
  return {
    ...state,
    prevRoute: state.lastRoute ?? null,
    prevIntent: state.lastIntent ?? null,
    lastRoute: router.route ?? state.lastRoute,
    lastIntent: router.intent ?? state.lastIntent,
    lastUpdatedAt: nowIso()
  };
}

export function updateStateFromClerkPayload(
  state: ShoppingState,
  payload?: ClerkPayload | null
): ShoppingState {
  if (!payload) return state;
  if (payload.type === "shortlist") {
    const shortlist = payload.items.map((item) => ({
      productId: item.productId,
      title: item.title,
      priceMin: item.priceMin,
      priceMax: item.priceMax,
      currency: item.currency,
      imageUrl: item.imageUrl,
      productUrl: item.productUrl,
      addToCartUrl: item.addToCartUrl,
      variantId: item.variantId,
      attrSummary: item.attrSummary
    }));
    const hash = computeShortlistHash(shortlist);
    const loopCount =
      state.shortlistHash && hash && state.shortlistHash === hash
        ? state.loopCount + 1
        : 0;
    return {
      ...state,
      mode: "SHORTLIST_SHOWN",
      shortlist,
      shortlistHash: hash,
      lastShortlistAt: nowIso(),
      detailsProductId: null,
      lastDetailsAt: null,
      loopCount
    };
  }

  if (payload.type === "details") {
    return {
      ...state,
      mode: "DETAILS_SHOWN",
      detailsProductId: payload.item.productId,
      lastDetailsAt: nowIso()
    };
  }

  return state;
}

export function updateStateLanguage(
  state: ShoppingState,
  language: "en" | "it" | "es" | "de" | "fr" | null
): ShoppingState {
  if (!language) return state;
  if (state.language && state.language === language) return state;
  if (state.language) return state;
  return { ...state, language };
}

export function shouldAvoidRefetch(state: ShoppingState): boolean {
  if (!state.shortlistHash) return false;
  if (state.loopCount >= 1) return true;
  if (!state.lastShortlistAt) return false;
  const last = new Date(state.lastShortlistAt).getTime();
  return Date.now() - last < 2 * 60 * 1000;
}

export async function syncStateWithClerkState(params: {
  state: ShoppingState;
  botId: string;
  conversationId: string | null;
  sessionId: string | null;
}): Promise<ShoppingState> {
  const { state, botId, conversationId, sessionId } = params;
  let row = null;
  if (conversationId) {
    row = await prisma.shopifyClerkState.findFirst({
      where: { botId, conversationId }
    });
  }
  if (!row && sessionId) {
    row = await prisma.shopifyClerkState.findFirst({
      where: { botId, sessionId }
    });
  }
  if (!row) return state;

  const collectedFilters = (row.collectedFilters as Record<string, string>) || {};
  const productType = collectedFilters["Product Type"] || null;
  return {
    ...state,
    filters: collectedFilters,
    activeProductType: productType
  };
}
