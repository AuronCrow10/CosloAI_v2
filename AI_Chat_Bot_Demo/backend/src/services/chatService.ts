// services/chatService.ts

import { getBotConfigBySlug, BookingConfig } from "../bots/config";
import { getOverviewCoverageQueries } from "../knowledge/overviewCoverageQueries";
import {
  detectKnowledgeLanguage,
  detectKnowledgeLanguageForLock,
  detectKnowledgeLanguageHint
} from "./knowledgeLanguage";
import { getKnowledgeOverviewNoResultsMessage } from "./knowledgeFallbacks";
import { runKnowledgeRetrieval } from "./knowledgeOrchestration";
import { detectContactQuerySmart } from "../knowledge/contactQueryDetection";
import { searchKnowledgeContacts } from "../knowledge/contactRetrieval";
import { extractContacts, extractContactsBySource } from "../knowledge/contactExtraction";
import { resolveContactFallback } from "../knowledge/contactFallbacks";
import { selectContactExtractionPool } from "../knowledge/contactSelection";
import { classifyContactSource } from "../knowledge/contactSourceClassification";
import { selectBestGenericContactSource } from "../knowledge/contactSelection";
import {
  getKnowledgeRetrievalParams,
  resolveKnowledgeRetrievalProfile
} from "../knowledge/knowledgeRetrievalProfiles";
import { classifyKnowledgeIntent } from "./knowledgeIntentClassifier";
import { decideKnowledgePolicy } from "./knowledgeResponsePolicy";
import { buildKnowledgeSpecificPrompt } from "../prompts/knowledgeSpecificPrompt";
import { buildKnowledgeOverviewPrompt } from "../prompts/knowledgeOverviewPrompt";
import { buildKnowledgeAmbiguousPrompt } from "../prompts/knowledgeAmbiguousPrompt";
import {
  ChatMessage,
  ChatTool,
  getChatCompletion,
  createChatCompletionWithUsage
} from "../openai/client";
import {
  handleBookAppointment,
  handleUpdateAppointment,
  handleCancelAppointment,
  BookAppointmentArgs,
  UpdateAppointmentArgs,
  CancelAppointmentArgs,
  BookingResult
} from "./bookingService";
import {
  getRestaurantChatContext,
  handleRestaurantCancelFromChat,
  handleRestaurantCreateFromChat
} from "./restaurantBookingService";
import { getConversationHistoryAsChatMessages } from "./conversationService";
import {
  getConversationMemorySummary,
  maybeUpdateConversationMemorySummary
} from "./conversationAnalyticsService";
import { ensureBotHasTokens } from "./planUsageService";
import { maybeSendUsageAlertsForBot } from "./planUsageAlertService";
import {
  BookingDraft,
  loadBookingDraft,
  updateBookingDraft
} from "./bookingDraftService";
import { detectBookingFieldUpdates } from "./bookingFieldCapture";
import { z } from "zod";
import { DateTime } from "luxon";
import {
  toolSearchProducts,
  toolGetProductDetails,
  toolAddToCart,
  toolGetCheckoutLink,
  toolGetOrderStatus
} from "../shopify/toolService";
import { getShopForBotId } from "../shopify/shopService";
import { getPoliciesForBot } from "../shopify/policyService";
import { RevenueAISuggestion } from "./revenueAIService";
import { safeMaybeBuildRevenueAIOffer } from "./revenueAISafe";
import {
  classifyIntent,
  shouldAskClarifyingQuestion
} from "./revenueAIIntent";
import { handleClerkFlow, ClerkPayload } from "./clerkFlowService";
import {
  getShopCatalogContext,
  selectShopCatalogContextForMessage
} from "./shopCatalogContextService";
import { routeConversation, RouterResult } from "./conversationRouter";
import { generateConversationalSellerReply } from "./conversationalSellerService";
import {
  applyRouterToState,
  loadShoppingState,
  saveShoppingState,
  updateStateFromClerkPayload,
  updateStateLanguage,
  syncStateWithClerkState,
  ShoppingState
} from "./shoppingStateService";
import { evaluateClerkEligibility } from "./shopifyClerkEligibility";

const MAX_MESSAGE_LENGTH = 2000;
const BASE_CONTEXT_CHARS_PER_CHUNK = 1000;
const MAX_TOTAL_CONTEXT_CHARS = 4300;
const MIN_CONTEXT_CHARS_PER_CHUNK = 450;
const PRIORITIZED_CONTEXT_CHARS = [1700, 1100, 850, 700, 600, 550] as const;
const HISTORY_TURNS_TO_KEEP = 2; // 2 user+assistant turns = 4 messages total
const ENABLE_CONVERSATION_MEMORY_SUMMARY =
  String(process.env.ENABLE_CONVERSATION_MEMORY_SUMMARY || "false").toLowerCase() ===
  "true";

const CONTEXT_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "when",
  "where",
  "who",
  "how",
  "about",
  "from",
  "your",
  "have",
  "will",
  "would",
  "could",
  "please",
  "info",
  "information",
  "details",
  "detail",
  "want",
  "know",
  "tell",
  "give",
  "more",
  "also",
  "ciao",
  "grazie",
  "dimmi",
  "dammi",
  "come",
  "dove",
  "quando",
  "quale",
  "quali",
  "sono",
  "vuoi",
  "sapere",
  "informazioni",
  "informazione",
  "specifiche",
  "specifica",
  "specifico",
  "specifici",
  "dettaglio",
  "dettagli",
  "anche",
  "avete",
  "vostri",
  "vostre",
  "para",
  "por",
  "sobre",
  "como",
  "donde",
  "cuando",
  "cual",
  "cuales",
  "quiero",
  "quieres",
  "saber",
  "informacion",
  "especifico",
  "especifica",
  "especificos",
  "especificas",
  "detalle",
  "detalles",
  "tambien",
  "gracias",
  "merci",
  "bonjour",
  "comment",
  "ou",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "voulez",
  "veux",
  "savoir",
  "informations",
  "specifique",
  "specifiques",
  "aussi",
  "hallo",
  "danke",
  "wie",
  "wo",
  "wann",
  "welche",
  "welcher",
  "welches",
  "mochtest",
  "willst",
  "wissen",
  "informationen",
  "spezifisch",
  "spezifische",
  "bitte"
]);

const BASE_BOOKING_FIELDS = ["name", "email", "phone", "service", "datetime"] as const;

type UnsupportedActionType = "email" | "call" | "payment";
type SupportedLanguage = "it" | "en" | "es" | "de" | "fr";

function detectQuickMessageLanguageHint(
  message: string
): SupportedLanguage | null {
  const lower = ` ${foldContextText(message)} `;
  const checks: Array<{ lang: SupportedLanguage; tokens: string[] }> = [
    {
      lang: "it",
      tokens: [
        " il ",
        " che ",
        " per ",
        " non ",
        " sono ",
        " puoi ",
        " vorrei ",
        " prezzo ",
        " prezzi ",
        " contatti ",
        " grazie "
      ]
    },
    {
      lang: "es",
      tokens: [
        " el ",
        " que ",
        " para ",
        " precio ",
        " precios ",
        " quieres ",
        " puedo ",
        " enviar ",
        " correo ",
        " gracias "
      ]
    },
    {
      lang: "de",
      tokens: [
        " der ",
        " die ",
        " und ",
        " nicht ",
        " kann ",
        " bitte ",
        " preis ",
        " danke "
      ]
    },
    {
      lang: "fr",
      tokens: [
        " le ",
        " et ",
        " pas ",
        " peux ",
        " prix ",
        " merci ",
        " envoyer "
      ]
    },
    {
      lang: "en",
      tokens: [
        " the ",
        " and ",
        " for ",
        " not ",
        " can ",
        " send ",
        " email ",
        " price ",
        " prices ",
        " thanks "
      ]
    }
  ];

  const scored = checks.map((check) => {
    let score = 0;
    for (const token of check.tokens) {
      if (lower.includes(token)) score += 1;
    }
    return { lang: check.lang, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 2) return null;
  if (second && best.score <= second.score) return null;
  return best.lang;
}

function detectQuickMessageLanguage(message: string): "it" | "en" | "es" | "de" | "fr" {
  return detectQuickMessageLanguageHint(message) ?? "en";
}

const AFFIRMATIVE_SHORT_REPLIES = new Set([
  "ok",
  "okay",
  "k",
  "yes",
  "yep",
  "yeah",
  "sure",
  "of course",
  "definitely",
  "absolutely",
  "certainly",
  "si",
  "s",
  "ovvio",
  "va bene",
  "d accordo",
  "accordo",
  "perfetto",
  "certo",
  "continua",
  "prosegui",
  "esatto",
  "claro",
  "por supuesto",
  "desde luego",
  "vale",
  "de acuerdo",
  "si claro",
  "oui",
  "bien sur",
  "d accord",
  "tout a fait",
  "oui bien sur",
  "ja",
  "natuerlich",
  "klar",
  "sicher",
  "einverstanden",
  "ja klar",
  "selbstverstaendlich"
]);

const NEGATIVE_SHORT_REPLIES = new Set([
  "no",
  "nope",
  "not now",
  "not really",
  "nah",
  "non ora",
  "non",
  "niente",
  "claro que no",
  "para nada",
  "ahora no",
  "no gracias",
  "non merci",
  "pas maintenant",
  "pas vraiment",
  "nein",
  "nicht jetzt",
  "eher nicht",
  "nein danke",
  "stop",
  "basta"
]);

const GENERIC_SHORT_REPLIES = new Set([
  ...Array.from(AFFIRMATIVE_SHORT_REPLIES),
  ...Array.from(NEGATIVE_SHORT_REPLIES),
  "thanks",
  "thank you",
  "thx",
  "thanks a lot",
  "cool",
  "great",
  "awesome",
  "nice",
  "sounds good",
  "alright",
  "fine",
  "gracias",
  "merci",
  "danke",
  "ok merci",
  "vale gracias",
  "ok gracias",
  "ok danke",
  "grazie",
  "perfetto grazie"
]);

const PENDING_FOLLOW_UP_TTL_MS = 20 * 60 * 1000;
const CONVERSATION_LANGUAGE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type PendingFollowUpState = {
  previousQuestion: string;
  resolvedKnowledgeQuery: string;
  topicHint: string | null;
  hasSpecificTopic: boolean;
  createdAt: number;
  expiresAt: number;
};

const pendingFollowUpStateStore = new Map<string, PendingFollowUpState>();

type ConversationLanguageLockState = {
  language: SupportedLanguage;
  createdAt: number;
  expiresAt: number;
};

const conversationLanguageLockStore = new Map<
  string,
  ConversationLanguageLockState
>();

function pruneConversationLanguageLockStore(now = Date.now()): void {
  for (const [key, state] of conversationLanguageLockStore.entries()) {
    if (!state || state.expiresAt <= now) {
      conversationLanguageLockStore.delete(key);
    }
  }
}

function loadConversationLanguageLock(
  key: string | null
): SupportedLanguage | null {
  if (!key) return null;
  pruneConversationLanguageLockStore();
  const state = conversationLanguageLockStore.get(key);
  return state?.language ?? null;
}

function saveConversationLanguageLock(
  key: string | null,
  language: SupportedLanguage | null
): void {
  if (!key) return;
  if (!language) {
    conversationLanguageLockStore.delete(key);
    return;
  }
  pruneConversationLanguageLockStore();
  const now = Date.now();
  conversationLanguageLockStore.set(key, {
    language,
    createdAt: now,
    expiresAt: now + CONVERSATION_LANGUAGE_TTL_MS
  });
}

function normalizeShortReplyToken(message: string): string {
  return foldContextText(message)
    .replace(/[^a-z0-9\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAffirmativeFollowUpSignal(normalizedReply: string): boolean {
  if (!normalizedReply) return false;
  if (AFFIRMATIVE_SHORT_REPLIES.has(normalizedReply)) return true;

  const words = normalizedReply.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 7) return false;

  const affirmativeRoots = new Set([
    "si",
    "yes",
    "sure",
    "certo",
    "ovvio",
    "claro",
    "oui",
    "ja",
    "okay",
    "ok"
  ]);
  if (!affirmativeRoots.has(words[0])) return false;

  const tail = words.slice(1);
  if (!tail.length) return true;
  return tail.every((word) =>
    /^(voglio|vorrei|want|please|per|piu|more|link|dettagli|details|info|informazioni|contatto|contatti|telefono|email)$/i.test(
      word
    )
  );
}

function getLastAssistantContent(historyMessages: ChatMessage[]): string | null {
  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const msg = historyMessages[i];
    if (msg.role !== "assistant") continue;
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (content) return content;
  }
  return null;
}

function assistantMessageEndsWithQuestion(content: string | null): boolean {
  if (!content) return false;
  return /[?][\s"'”’)]*$/.test(content.trim());
}

function assistantAskedForPersonalField(content: string | null): boolean {
  if (!content) return false;
  const folded = foldContextText(content);
  return /\b(name|nome|come ti chiami|email|telefono|phone|contatt|contact)\b/i.test(
    folded
  );
}

function assistantAskedForName(content: string | null): boolean {
  if (!content) return false;
  const folded = foldContextText(content);
  return /\b(name|nome|come ti chiami|qual e il tuo nome|what is your name|tu nombre|como te llamas|wie heisst du|wie heißt du|dein name|comment tu t'appelles|votre nom)\b/i.test(
    folded
  );
}

function isWeakLanguageSignalMessage(message: string): boolean {
  const normalized = normalizeShortReplyToken(message);
  if (!normalized) return true;
  if (GENERIC_SHORT_REPLIES.has(normalized)) return true;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0].length <= 3) return true;
  return false;
}

type ShortAffirmativeFollowUpContext = {
  normalizedReply: string;
  previousQuestion: string;
  resolvedKnowledgeQuery: string;
  topicHint: string | null;
  hasSpecificTopic: boolean;
  source: "state" | "history";
};

function buildPendingFollowUpStateKey(params: {
  botId: string | null | undefined;
  conversationId: string | null | undefined;
  sessionId: string | null | undefined;
}): string | null {
  const { botId, conversationId, sessionId } = params;
  if (!botId) return null;
  if (conversationId) return `${botId}:conversation:${conversationId}`;
  if (sessionId) return `${botId}:session:${sessionId}`;
  return null;
}

function prunePendingFollowUpStateStore(now = Date.now()): void {
  for (const [key, state] of pendingFollowUpStateStore.entries()) {
    if (!state || state.expiresAt <= now) {
      pendingFollowUpStateStore.delete(key);
    }
  }
}

function loadPendingFollowUpState(key: string | null): PendingFollowUpState | null {
  if (!key) return null;
  prunePendingFollowUpStateStore();
  return pendingFollowUpStateStore.get(key) ?? null;
}

function clearPendingFollowUpState(key: string | null): void {
  if (!key) return;
  pendingFollowUpStateStore.delete(key);
}

function savePendingFollowUpState(
  key: string | null,
  state: PendingFollowUpState | null
): void {
  if (!key) return;
  if (!state) {
    clearPendingFollowUpState(key);
    return;
  }
  prunePendingFollowUpStateStore();
  pendingFollowUpStateStore.set(key, state);
}

function extractLastAssistantQuestion(content: string | null): string | null {
  if (!content) return null;
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return null;

  const matches = compact.match(/[^?]+[?]/g);
  if (!matches || matches.length === 0) return null;

  const question = matches[matches.length - 1].replace(/\s+/g, " ").trim();
  if (question.length < 8) return null;
  return question;
}

function findLastAssistantQuestionInHistory(historyMessages: ChatMessage[]): {
  question: string;
  assistantIndex: number;
} | null {
  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const msg = historyMessages[i];
    if (msg.role !== "assistant") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    const question = extractLastAssistantQuestion(content);
    if (question) {
      return { question, assistantIndex: i };
    }
  }
  return null;
}

function findLastAssistantMessageInHistory(historyMessages: ChatMessage[]): {
  content: string;
  assistantIndex: number;
} | null {
  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const msg = historyMessages[i];
    if (msg.role !== "assistant") continue;
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!content) continue;
    return { content, assistantIndex: i };
  }
  return null;
}

function extractLastUserMessageBeforeIndex(
  historyMessages: ChatMessage[],
  maxExclusiveIndex: number
): string | null {
  for (let i = maxExclusiveIndex - 1; i >= 0; i -= 1) {
    const msg = historyMessages[i];
    if (msg.role !== "user") continue;
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (content.length > 0) return content;
  }
  return null;
}

function looksGenericFollowUpQuestion(question: string): boolean {
  const folded = foldContextText(question);
  const hasGenericPattern =
    /\b(vuoi|want|quieres|voulez|mochtest|details?|dettagli?|informazioni?|info|specific|specifiche|specifico|clarify|chiarire)\b/.test(
      folded
    );
  const contentTokens = extractContextQueryTokens(question);
  return hasGenericPattern || contentTokens.length <= 1;
}

const FOLLOW_UP_INTENT_NOISE_TOKENS = new Set([
  "vuoi",
  "want",
  "quieres",
  "voulez",
  "mochtest",
  "details",
  "dettagli",
  "informazioni",
  "specifiche",
  "specifico",
  "clarify",
  "chiarire",
  "posso",
  "podemos",
  "puedo",
  "please",
  "certo",
  "ovvio",
  "sure",
  "yes",
  "okay"
]);

function extractFollowUpIntentTokens(message: string): string[] {
  return extractContextQueryTokens(message)
    .filter((token) => !FOLLOW_UP_INTENT_NOISE_TOKENS.has(token))
    .slice(0, 6);
}

function buildResolvedFollowUpKnowledgeQuery(params: {
  previousQuestion: string;
  topicHint: string | null;
}): string {
  const { previousQuestion, topicHint } = params;
  const questionWithoutPunctuation = previousQuestion.replace(/[?]+$/, "").trim();
  const genericQuestion = looksGenericFollowUpQuestion(previousQuestion);
  const questionIntentTokens = extractFollowUpIntentTokens(previousQuestion);

  if (topicHint && topicHint.trim().length >= 4) {
    if (questionIntentTokens.length > 0) {
      const foldedTopic = foldContextText(topicHint);
      const missingIntentTokens = questionIntentTokens.filter(
        (token) => !foldedTopic.includes(token)
      );
      if (missingIntentTokens.length > 0) {
        return `${topicHint}. ${missingIntentTokens.join(" ")}`;
      }
    }
    if (genericQuestion) return topicHint;
  }

  return questionWithoutPunctuation;
}
function getLastConcreteUserTopicFromHistory(
  historyMessages: ChatMessage[]
): string | null {
  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const msg = historyMessages[i];
    if (msg.role !== "user") continue;
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!content) continue;
    if (isWeakLanguageSignalMessage(content)) continue;
    const tokens = extractContextQueryTokens(content);
    if (tokens.length >= 1) return content;
  }
  return null;
}

function isContextDependentFollowUpQuery(message: string): boolean {
  const folded = foldContextText(message);
  const tokens = extractContextQueryTokens(message);
  const hasBridgeLanguage =
    /\b(invece|also|what about|and the|ed il|ed la|e il|e la|quello|quella|that one|those|questo|questa)\b/.test(
      folded
    );
  const asksLink = queryLooksLikeDirectLinkRequest(message);
  const genericQuestionShape =
    /[?]/.test(message) &&
    tokens.length > 0 &&
    tokens.length <= 3 &&
    /\b(quanto|costo|costa|disponibil|personalizz|durata|scheda|tecnica|acquisto|noleggio|finanzi)\b/.test(
      folded
    );

  return hasBridgeLanguage || asksLink || genericQuestionShape;
}

function buildContextualKnowledgeInputMessage(params: {
  message: string;
  historyMessages: ChatMessage[];
  shortAffirmativeFollowUp: ShortAffirmativeFollowUpContext | null;
}): string {
  const { message, historyMessages, shortAffirmativeFollowUp } = params;
  if (shortAffirmativeFollowUp) {
    return shortAffirmativeFollowUp.hasSpecificTopic
      ? shortAffirmativeFollowUp.resolvedKnowledgeQuery
      : message;
  }

  if (!isContextDependentFollowUpQuery(message)) return message;
  const topic = getLastConcreteUserTopicFromHistory(historyMessages);
  if (!topic) return message;

  const currentTokens = new Set(extractContextQueryTokens(message));
  const topicTokens = extractContextQueryTokens(topic);
  const overlap = topicTokens.some((token) => currentTokens.has(token));
  if (overlap) return message;

  return `${topic}. ${message}`;
}
function resolveShortAffirmativeFollowUpContext(params: {
  message: string;
  historyMessages: ChatMessage[];
  bookingFlowActive: boolean;
  pendingState: PendingFollowUpState | null;
}): ShortAffirmativeFollowUpContext | null {
  const { message, historyMessages, bookingFlowActive, pendingState } = params;
  if (bookingFlowActive) return null;

  const normalizedReply = normalizeShortReplyToken(message);
  if (!isAffirmativeFollowUpSignal(normalizedReply)) {
    return null;
  }

  if (pendingState) {
    return {
      normalizedReply,
      previousQuestion: pendingState.previousQuestion,
      resolvedKnowledgeQuery: pendingState.resolvedKnowledgeQuery,
      topicHint: pendingState.topicHint,
      hasSpecificTopic: pendingState.hasSpecificTopic,
      source: "state"
    };
  }

  const lastQuestionCtx = findLastAssistantQuestionInHistory(historyMessages);
  if (!lastQuestionCtx) {
    const lastAssistantCtx = findLastAssistantMessageInHistory(historyMessages);
    if (!lastAssistantCtx) return null;

    const topicHint = extractLastUserMessageBeforeIndex(
      historyMessages,
      lastAssistantCtx.assistantIndex
    );
    if (!topicHint || topicHint.trim().length < 4) return null;

    const compactAssistant = lastAssistantCtx.content.replace(/\s+/g, " ").trim();
    const previousQuestion =
      compactAssistant.length > 220
        ? `${compactAssistant.slice(0, 217).trimEnd()}...`
        : compactAssistant;

    const resolvedKnowledgeQuery = buildResolvedFollowUpKnowledgeQuery({
      previousQuestion,
      topicHint
    });

    return {
      normalizedReply,
      previousQuestion,
      resolvedKnowledgeQuery,
      topicHint,
      hasSpecificTopic:
        extractContextQueryTokens(resolvedKnowledgeQuery).length >= 1 ||
        extractContextQueryTokens(topicHint).length >= 1,
      source: "history"
    };
  }

  const previousQuestion = lastQuestionCtx.question;
  if (!previousQuestion.replace(/[?]+$/, "").trim()) return null;

  const topicHint = extractLastUserMessageBeforeIndex(
    historyMessages,
    lastQuestionCtx.assistantIndex
  );
  const genericQuestion = looksGenericFollowUpQuestion(previousQuestion);
  const hasSpecificTopic =
    (!genericQuestion && extractContextQueryTokens(previousQuestion).length >= 1) ||
    (typeof topicHint === "string" && topicHint.trim().length >= 4);

  const resolvedKnowledgeQuery = buildResolvedFollowUpKnowledgeQuery({
    previousQuestion,
    topicHint: topicHint ?? null
  });

  return {
    normalizedReply,
    previousQuestion,
    resolvedKnowledgeQuery,
    topicHint: topicHint ?? null,
    hasSpecificTopic,
    source: "history"
  };
}

function buildPendingFollowUpStateFromAssistantReply(params: {
  reply: string;
  baseUserQuery: string;
}): PendingFollowUpState | null {
  const { reply, baseUserQuery } = params;
  const question = extractLastAssistantQuestion(reply);
  if (!question) return null;

  const questionWithoutPunctuation = question.replace(/[?]+$/, "").trim();
  if (questionWithoutPunctuation.length < 8) return null;

  const topicHint = baseUserQuery.trim().length >= 4 ? baseUserQuery.trim() : null;
  const resolvedKnowledgeQuery = buildResolvedFollowUpKnowledgeQuery({
    previousQuestion: question,
    topicHint
  });

  const hasSpecificTopic =
    extractContextQueryTokens(resolvedKnowledgeQuery).length >= 1 ||
    (!!topicHint && extractContextQueryTokens(topicHint).length >= 1);

  const now = Date.now();
  return {
    previousQuestion: question,
    resolvedKnowledgeQuery,
    topicHint,
    hasSpecificTopic,
    createdAt: now,
    expiresAt: now + PENDING_FOLLOW_UP_TTL_MS
  };
}

function buildShortAffirmativeFollowUpSystemHint(
  context: ShortAffirmativeFollowUpContext
): string {
  const scopeRule = context.hasSpecificTopic
    ? "- You MUST answer strictly within the scope of that previous question/topic."
    : "- The previous question has no concrete topic, so ask exactly ONE focused clarification question before giving details.";
  const topicLine = context.topicHint
    ? `- Last concrete user topic before that question: ${context.topicHint}`
    : "- No concrete prior topic is available in history.";
  const responseRule = context.hasSpecificTopic
    ? "- Cover the concrete options explicitly offered in that question when possible."
    : "- Do NOT invent facts when topic is missing; request the missing topic first.";

  return (
    "Short-confirmation follow-up rule:\n" +
    `- The user replied with a short affirmative ("${context.normalizedReply}") to your previous question.\n` +
    `${scopeRule}\n` +
    `${responseRule}\n` +
    `${topicLine}\n` +
    "- Give a direct answer now; do not ask the user to restate the same request.\n" +
    "- Do NOT introduce extra topics, assumptions, ROI claims, or unrelated business facts.\n" +
    "- If data is missing, state exactly what is missing and ask one focused follow-up question.\n" +
    `Previous assistant question: ${context.previousQuestion}`
  );
}

function isSupportedLanguage(value: string | null | undefined): value is SupportedLanguage {
  return (
    value === "it" ||
    value === "en" ||
    value === "es" ||
    value === "de" ||
    value === "fr"
  );
}

async function detectHistoryLanguageHint(params: {
  historyMessages: ChatMessage[];
  botId?: string | null;
  preferUserMessages?: boolean;
}): Promise<SupportedLanguage | null> {
  const { historyMessages, botId, preferUserMessages = true } = params;
  if (!historyMessages.length) return null;

  // For weak user inputs (e.g. "si", "ok"), rely on immediate recent turns only.
  const recentTurns = historyMessages
    .slice(-4)
    .reverse()
    .filter((msg) => msg.role === "user" || msg.role === "assistant");
  const orderedTurns = preferUserMessages
    ? [
        ...recentTurns.filter((msg) => msg.role === "user"),
        ...recentTurns.filter((msg) => msg.role === "assistant")
      ]
    : recentTurns;

  for (const msg of orderedTurns) {
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!content) continue;
    if (isWeakLanguageSignalMessage(content)) continue;

    const quick = detectQuickMessageLanguageHint(content);
    if (quick) return quick;

    const heuristic = await detectKnowledgeLanguageHint({
      message: content,
      lockedLanguage: null,
      routedLanguage: null,
      botId: botId ?? null,
      allowLLM: false
    });
    if (heuristic && isSupportedLanguage(heuristic)) return heuristic;
  }

  return null;
}

function detectUnsupportedExternalAction(message: string): UnsupportedActionType | null {
  const lower = foldContextText(message);
  const emailVerb =
    /\b(invia|inviami|inviamela|manda|mandami|send|email me|enviar|envia|schick|envoyer)\b/.test(
      lower
    ) && /\b(email|e-mail|mail|correo|posta)\b/.test(lower);

  if (emailVerb) return "email";

  const callVerb = /\b(call|chiam|telefon|llama|anruf|appeler)\b/.test(lower);
  if (callVerb) return "call";

  const paymentVerb =
    /\b(pay|payment|pagamento|pagare|pago|pagar|zahlung|bezahlen|paiement|payer)\b/.test(
      lower
    ) && /\b(fai|effettua|completa|make|do|realiza|completa|durchfuhren|effectuer)\b/.test(lower);
  if (paymentVerb) return "payment";

  return null;
}

function buildUnsupportedActionReply(
  action: UnsupportedActionType,
  lang: "it" | "en" | "es" | "de" | "fr"
): string {
  if (lang === "it") {
    if (action === "email") {
      return "Non posso inviare email direttamente. Posso però prepararti il testo da inviare e aiutarti a renderlo completo.";
    }
    if (action === "call") {
      return "Non posso effettuare chiamate direttamente. Posso però aiutarti a preparare un messaggio o indicarti i contatti più adatti.";
    }
    return "Non posso eseguire pagamenti direttamente. Posso però spiegarti i passaggi e guidarti al canale corretto per completare il pagamento.";
  }
  if (lang === "es") {
    if (action === "email") {
      return "No puedo enviar correos directamente. Puedo ayudarte a preparar el texto para enviarlo.";
    }
    if (action === "call") {
      return "No puedo realizar llamadas directamente. Puedo ayudarte a preparar un mensaje o indicar el contacto correcto.";
    }
    return "No puedo realizar pagos directamente. Puedo explicarte los pasos para completarlo en el canal adecuado.";
  }
  if (lang === "de") {
    if (action === "email") {
      return "Ich kann keine E-Mails direkt senden. Ich kann dir aber helfen, den Text vorzubereiten.";
    }
    if (action === "call") {
      return "Ich kann keine Anrufe direkt durchfuhren. Ich kann dir aber bei einer Nachricht oder den richtigen Kontaktdaten helfen.";
    }
    return "Ich kann keine Zahlungen direkt ausfuhren. Ich kann dir aber die Schritte fur den richtigen Kanal erklaren.";
  }
  if (lang === "fr") {
    if (action === "email") {
      return "Je ne peux pas envoyer d'e-mails directement. Je peux toutefois t'aider a preparer le texte.";
    }
    if (action === "call") {
      return "Je ne peux pas passer d'appels directement. Je peux toutefois t'aider a preparer un message ou le bon contact.";
    }
    return "Je ne peux pas effectuer de paiements directement. Je peux toutefois t'expliquer les etapes a suivre.";
  }

  if (action === "email") {
    return "I can’t send emails directly. I can help you draft the message so you can send it quickly.";
  }
  if (action === "call") {
    return "I can’t place phone calls directly. I can help you prepare a message or the right contact details.";
  }
  return "I can’t complete payments directly. I can guide you through the correct steps to complete payment.";
}

function buildUnsupportedProposalFallback(
  lang: "it" | "en" | "es" | "de" | "fr"
): string {
  if (lang === "it") {
    return "Posso aiutarti con informazioni verificate e dettagli disponibili qui in chat. Se vuoi, ti fornisco subito i dati o il link corretto presenti nel materiale.";
  }
  if (lang === "es") {
    return "Puedo ayudarte con informacion verificada y detalles disponibles aqui en el chat. Si quieres, te comparto ahora mismo los datos o el enlace correcto presentes en el material.";
  }
  if (lang === "de") {
    return "Ich kann dir mit verifizierten Informationen und Details direkt im Chat helfen. Wenn du willst, teile ich dir jetzt die passenden Daten oder den richtigen Link aus dem Material mit.";
  }
  if (lang === "fr") {
    return "Je peux t'aider avec des informations verifiees et des details disponibles ici dans le chat. Si tu veux, je te donne tout de suite les coordonnees ou le bon lien presents dans le contenu.";
  }
  return "I can help with verified information and details directly in chat. If you want, I can share the correct details or link available in the material right away.";
}

function hasUnsupportedActionRefusal(text: string): boolean {
  return /\b(non posso|cannot|can't|unable to|no puedo|ich kann nicht|je ne peux pas)\b/i.test(
    text
  );
}

function extractUrlsFromText(text: string): string[] {
  const matches = String(text || "").match(/https?:\/\/[^\s)]+/gi) || [];
  const deduped = Array.from(
    new Set(
      matches
        .map((url) => url.trim().replace(/[.,;:!?]+$/, ""))
        .filter(Boolean)
    )
  );
  return deduped.slice(0, 8);
}

const URL_TOPIC_NOISE_TOKENS = new Set([
  "scheda",
  "tecnica",
  "dettagliata",
  "dettagli",
  "download",
  "link",
  "pagina",
  "page",
  "direct",
  "diretto",
  "detailed",
  "informazioni",
  "info",
  "contact",
  "contatti"
]);

function selectBestEvidenceUrlForQuery(params: {
  query: string;
  evidenceText: string;
}): string | null {
  const { query, evidenceText } = params;
  const urls = extractUrlsFromText(evidenceText);
  if (!urls.length) return null;

  const queryTokens = extractContextQueryTokens(query).filter(
    (token) => !URL_TOPIC_NOISE_TOKENS.has(token)
  );
  if (!queryTokens.length) return null;

  const ranked = urls
    .map((url) => {
      const foldedUrl = foldContextText(url);
      let score = 0;
      for (const token of queryTokens) {
        if (foldedUrl.includes(token)) score += 1;
      }
      return { url, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length || ranked[0].score <= 0) return null;
  if (ranked[1] && ranked[0].score === ranked[1].score) return null;
  return ranked[0].url;
}

function queryLooksLikeDirectLinkRequest(query: string): boolean {
  return /\b(link|url|download|scaric|scheda|pagina|page|enlace|lien|herunterlad|telecharger)\b/i.test(
    foldContextText(query)
  );
}

function buildDirectLinkPrefix(lang: "it" | "en" | "es" | "de" | "fr"): string {
  if (lang === "it") return "Ecco il link diretto:";
  if (lang === "es") return "Aqui tienes el enlace directo:";
  if (lang === "de") return "Hier ist der direkte Link:";
  if (lang === "fr") return "Voici le lien direct :";
  return "Here is the direct link:";
}

function alignReplyUrlWithEvidence(params: {
  reply: string;
  resolvedQuery: string;
  evidenceText: string;
  lang: "it" | "en" | "es" | "de" | "fr";
}): string {
  const { reply, resolvedQuery, evidenceText, lang } = params;
  const bestUrl = selectBestEvidenceUrlForQuery({
    query: resolvedQuery,
    evidenceText
  });
  if (!bestUrl) return reply;

  const replyUrls = extractUrlsFromText(reply);
  if (replyUrls.length === 0) {
    if (!queryLooksLikeDirectLinkRequest(resolvedQuery)) return reply;
    return `${reply}\n\n${buildDirectLinkPrefix(lang)} ${bestUrl}`.trim();
  }

  if (replyUrls.some((url) => foldContextText(url) === foldContextText(bestUrl))) {
    return reply;
  }

  return reply.replace(replyUrls[0], bestUrl);
}

const CLAIM_QUERY_VERB_TOKENS = new Set([
  "have",
  "has",
  "do",
  "does",
  "can",
  "offrite",
  "avete",
  "fornite",
  "include",
  "inclus",
  "accettate",
  "serve",
  "esiste",
  "hay",
  "tienen",
  "aceptan",
  "incluye",
  "ofrecen",
  "habt",
  "haben",
  "gibt",
  "kann",
  "offrez",
  "proposez",
  "acceptez",
  "inclut",
  "avez",
  "vous"
]);

function isBinaryClaimQuestion(message: string): boolean {
  const trimmed = String(message || "").trim();
  if (!trimmed) return false;
  if (!/[?]$/.test(trimmed) && !/^(is|are|do|does|can|avete|offrite|fornite|serve|hay|tienen|aceptan|habt|haben|gibt|offrez|avez)\b/i.test(trimmed)) {
    return false;
  }
  return /\b(avete|offrite|fornite|include|inclus|accett|serve|esiste|do you|does it|is there|are there|can i|hay|tienen|acept|incluye|habt|haben|gibt|kann|offrez|proposez|acceptez|inclut|avez)\b/i.test(
    foldContextText(trimmed)
  );
}

function hasUncertaintyMarkers(text: string): boolean {
  return /\b(non risulta|non risultano|non disponibile|non specific|non ho informazioni|dal contesto|non e indicato|i (do not|don't) have|not specified|not available|not enough information|unknown|nicht angegeben|keine information|no se especifica|sin informacion|pas indique|pas d'information)\b/i.test(
    foldContextText(text)
  );
}

function isDefinitiveClaimReply(text: string): boolean {
  const folded = foldContextText(text);
  if (hasUncertaintyMarkers(folded)) return false;
  return /\b(si|sì|yes|no|non |we (do|don't)|accettiamo|offriamo|forniamo|include|is included|ist enthalten|oui|ja|noi|abbiamo|es gibt|hay|ofrecemos|aceptamos)\b/i.test(
    folded
  );
}

function hasEvidenceForClaim(message: string, evidenceText: string): boolean {
  const foldedEvidence = foldContextText(evidenceText || "");
  if (!foldedEvidence.trim()) return false;

  const queryTokens = extractContextQueryTokens(message).filter(
    (token) => !CLAIM_QUERY_VERB_TOKENS.has(token)
  );
  if (queryTokens.length === 0) return true;

  let matched = 0;
  for (const token of queryTokens.slice(0, 8)) {
    const hasTokenHit = buildContextTokenCandidates(token).some((candidate) => {
      const positions = findTermPositions({
        text: foldedEvidence,
        term: candidate.term,
        mode: candidate.mode
      });
      return positions.length > 0;
    });
    if (hasTokenHit) matched += 1;
  }

  const coverage = matched / Math.max(1, queryTokens.length);
  return matched >= 2 || coverage >= 0.45;
}

function normalizeNumericClaim(token: string): string {
  let value = token.trim();
  if (!value) return "";

  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(value)) {
    // IT/EU thousand separators.
    value = value.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) {
    // EN thousand separators.
    value = value.replace(/,/g, "");
  } else if (/^\d+,\d+$/.test(value)) {
    // Decimal comma.
    value = value.replace(",", ".");
  }

  value = value.replace(/^0+(\d)/, "$1");
  return value;
}

function extractNumericClaims(text: string): string[] {
  const compact = String(text || "");
  const pattern = /\b\d{2,}(?:[.,]\d{3})*(?:[.,]\d+)?\b/g;
  const claims: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(compact)) !== null) {
    const normalized = normalizeNumericClaim(match[0]);
    if (normalized) claims.push(normalized);
  }
  return Array.from(new Set(claims));
}

function hasEvidenceForNumericClaims(reply: string, evidenceText: string): boolean {
  const replyClaims = extractNumericClaims(reply);
  if (replyClaims.length === 0) return true;

  const evidenceClaims = new Set(extractNumericClaims(evidenceText));
  if (evidenceClaims.size === 0) return false;

  let matched = 0;
  for (const claim of replyClaims) {
    if (evidenceClaims.has(claim)) matched += 1;
  }

  const coverage = matched / Math.max(1, replyClaims.length);
  return matched >= replyClaims.length || coverage >= 0.8;
}

function isFactualClaimRiskyReply(message: string, reply: string): boolean {
  if (!reply.trim()) return false;
  if (hasUncertaintyMarkers(foldContextText(reply))) return false;
  if (extractNumericClaims(reply).length > 0) return true;
  if (isBinaryClaimQuestion(message) && isDefinitiveClaimReply(reply)) return true;

  const foldedReply = foldContextText(reply);
  return /\b(si|sì|yes|no|offriamo|forniamo|accettiamo|include|available|disponibile|disponibili|required|necessario)\b/.test(
    foldedReply
  );
}

function shouldRunFactualGroundingGuard(params: {
  message: string;
  reply: string;
  evidenceText: string;
}): boolean {
  const { message, reply, evidenceText } = params;
  if (!isFactualClaimRiskyReply(message, reply)) return false;

  const evidence = String(evidenceText || "").trim();
  if (!evidence) return false;

  const hasNumericClaims = extractNumericClaims(reply).length > 0;
  const numericSupported = hasEvidenceForNumericClaims(reply, evidence);
  const binaryDefinitive =
    isBinaryClaimQuestion(message) && isDefinitiveClaimReply(reply);
  const claimSupported = hasEvidenceForClaim(message, evidence);

  // Deterministic outcomes do not need an extra LLM guard pass.
  if (hasNumericClaims && !numericSupported) return false;
  if (binaryDefinitive && !claimSupported) return false;
  if (hasNumericClaims && numericSupported && claimSupported) return false;
  if (binaryDefinitive && claimSupported) return false;

  // Only run the guard in high-risk inconclusive cases.
  return !claimSupported || (!hasNumericClaims && !binaryDefinitive);
}

async function isUnsupportedFactualClaim(params: {
  userMessage: string;
  reply: string;
  evidenceText: string;
  usageContext: { userId?: string | null; botId?: string | null };
}): Promise<boolean> {
  const { userMessage, reply, evidenceText, usageContext } = params;
  const evidenceSnippet = String(evidenceText || "")
    .trim()
    .slice(0, 4000);
  if (!evidenceSnippet) return true;

  try {
    const raw = await getChatCompletion({
      model: "gpt-4o-mini",
      maxTokens: 140,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are a strict factual grounding checker.\n" +
            "Return ONLY JSON: {\"unsupported\":true|false,\"confidence\":0-1}.\n" +
            "unsupported=true if the assistant reply contains any factual claim not supported by evidence or contradicting evidence.\n" +
            "If uncertain, set unsupported=true."
        },
        {
          role: "user",
          content:
            `User message:\n${userMessage}\n\n` +
            `Assistant reply:\n${reply}\n\n` +
            `Evidence:\n${evidenceSnippet}`
        }
      ],
      usageContext: {
        ...usageContext,
        operation: "factual_grounding_guard"
      }
    });

    const compact = raw.trim();
    const jsonText =
      compact.startsWith("{") && compact.endsWith("}")
        ? compact
        : compact.slice(
            Math.max(0, compact.indexOf("{")),
            compact.lastIndexOf("}") + 1
          );
    if (!jsonText || !jsonText.startsWith("{")) return true;

    const parsed = JSON.parse(jsonText) as {
      unsupported?: unknown;
      confidence?: unknown;
    };
    const unsupported = parsed.unsupported === true;
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0;
    if (unsupported) return true;
    return confidence < 0.55;
  } catch {
    return false;
  }
}

async function rewriteReplyUsingEvidenceOnly(params: {
  reply: string;
  userMessage: string;
  evidenceText: string;
  targetLanguage: "it" | "en" | "es" | "de" | "fr";
  usageContext: { userId?: string | null; botId?: string | null };
}): Promise<string | null> {
  const { reply, userMessage, evidenceText, targetLanguage, usageContext } = params;
  const languageLabel =
    targetLanguage === "it"
      ? "Italian"
      : targetLanguage === "es"
      ? "Spanish"
      : targetLanguage === "de"
      ? "German"
      : targetLanguage === "fr"
      ? "French"
      : "English";

  const evidenceSnippet = String(evidenceText || "")
    .trim()
    .slice(0, 4500);

  try {
    const rewritten = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: 320,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the assistant reply so it is strictly evidence-bound.\n" +
            "Rules:\n" +
            "- Keep the same target language.\n" +
            "- Preserve only claims explicitly supported by evidence.\n" +
            "- Remove unsupported numbers/facts.\n" +
            "- If essential data is missing, clearly say it is not explicitly available and ask one focused clarification.\n" +
            "- Return only the rewritten reply text."
        },
        {
          role: "user",
          content:
            `Target language: ${languageLabel}\n` +
            `User message: ${userMessage}\n\n` +
            `Current reply:\n${reply}\n\n` +
            `Evidence:\n${evidenceSnippet || "(none)"}`
        }
      ],
      usageContext: {
        ...usageContext,
        operation: "chat_evidence_rewrite"
      }
    });
    return rewritten?.trim() || null;
  } catch {
    return null;
  }
}

function buildInsufficientEvidenceClaimReply(
  lang: "it" | "en" | "es" | "de" | "fr"
): string {
  if (lang === "it") {
    return "Non ho una conferma esplicita su questo punto nel contesto disponibile. Per evitare informazioni imprecise, ti consiglio di verificarlo direttamente con il team.";
  }
  if (lang === "es") {
    return "No tengo una confirmacion explicita sobre este punto en el contexto disponible. Para evitar datos imprecisos, te recomiendo verificarlo directamente con el equipo.";
  }
  if (lang === "de") {
    return "Dazu habe ich im vorhandenen Kontext keine eindeutige Bestatigung. Um ungenaue Angaben zu vermeiden, empfehle ich die direkte Bestatigung beim Team.";
  }
  if (lang === "fr") {
    return "Je n'ai pas de confirmation explicite sur ce point dans le contexte disponible. Pour eviter des informations inexactes, je te conseille de verifier directement avec l'equipe.";
  }
  return "I don't have an explicit confirmation on that point in the available context. To avoid inaccurate information, please verify it directly with the team.";
}

function detectUnsupportedActionProposalInReply(
  text: string
): UnsupportedActionType | null {
  if (!text || hasUnsupportedActionRefusal(text)) return null;
  const lower = foldContextText(text);

  const emailDirect =
    /\b(posso|i can|puedo|ich kann|je peux|vamos a|te)\b.{0,28}\b(invia|invier|send|email|correo|mail|envia|schick|envoy)\b/.test(
      lower
    ) && /\b(email|e-mail|mail|correo|posta)\b/.test(lower);
  if (emailDirect) return "email";

  const genericSendDocument =
    /\b(posso|i can|puedo|ich kann|je peux|vuoi che|quieres que)\b.{0,40}\b(invia|invier|send|enviar|envoyer|schick|pass|pasar|pasa|passa|fornir)\b/.test(
      lower
    ) &&
    /\b(scheda|ficha|brochure|pdf|document|documento|details|dettagli|info|informazioni)\b/.test(
      lower
    ) &&
    !/\b(qui|in chat|here|aqui|hier|ici)\b/.test(lower);
  if (genericSendDocument) return "email";

  const callProposal =
    /\b(posso|i can|puedo|ich kann|je peux)\b.{0,28}\b(chiam|call|telefon|llama|anruf|appeler)\b/.test(
      lower
    );
  if (callProposal) return "call";

  const paymentProposal =
    /\b(posso|i can|puedo|ich kann|je peux)\b.{0,28}\b(pay|payment|pagamento|pagare|pagar|zahlung|payer)\b/.test(
      lower
    );
  if (paymentProposal) return "payment";

  return null;
}

function hasExplicitExternalCapabilityAction(text: string): boolean {
  if (!text || hasUnsupportedActionRefusal(text)) return false;
  const lower = foldContextText(text);

  const hasCapabilityFrame =
    /\b(posso|possiamo|i can|we can|puedo|podemos|ich kann|wir konnen|je peux|nous pouvons)\b/.test(
      lower
    ) ||
    /\b(vuoi che|want me to|quieres que|voulez vous que|mochtest du dass)\b/.test(
      lower
    );
  if (!hasCapabilityFrame) return false;

  const externalAction =
    /\b(metterti in contatto|put you in touch|ponerte en contacto|mettre en relation|in kontakt bringen|contact (them|for you)|contattare .* per te|contactar .* por ti|contacter .* pour toi|kontaktieren .* fur dich)\b/.test(
      lower
    ) ||
    /\b(scrivere|write|draft|redigere|compose|preparare)\b.{0,30}\b(email|mail|message|messaggio|richiesta|request|solicitud|demande)\b/.test(
      lower
    ) ||
    /\b(trovare|find|buscar|trouver|suchen)\b.{0,35}\b(fornitor|provider|course|ente|vendor|partner)\b/.test(
      lower
    ) ||
    /\b(inoltrare|forward|escalate|escalare|submit|inviare .* a)\b/.test(
      lower
    );

  return externalAction;
}

const EXTERNAL_GUIDANCE_ACTION_STEMS = [
  "aiut",
  "help",
  "ayud",
  "aider",
  "helf",
  "trov",
  "find",
  "buscar",
  "trouver",
  "such",
  "search",
  "cerc",
  "fornir",
  "provide",
  "indicar",
  "indicare",
  "donner",
  "geben",
  "consigl",
  "recommend",
  "sugger",
  "contatt",
  "contact",
  "kontakt",
  "forward",
  "inoltr",
  "escal",
  "submit"
];

function tokenMatchesAnyStem(token: string, stems: string[]): boolean {
  return stems.some((stem) => token.startsWith(stem));
}

function looksLikeOutOfScopeExternalGuidance(reply: string): boolean {
  const lower = foldContextText(reply);
  const hasCapabilityFrame =
    /\b(posso|possiamo|i can|we can|puedo|podemos|je peux|nous pouvons|ich kann|wir konnen|vuoi che|want me to|quieres que|voulez[-\s]?vous|mochtest du|vuoi|would you like|quieres|voulez|mochtest)\b/.test(
      lower
    );
  const hasGuidanceAction =
    /\b(aiut|help|ayud|aider|helf|trov|find|buscar|trouver|such|search|cerc|fornir|provide|indicar|indicare|donner|geben|consigl|recommend|sugger|contatt|contact|kontakt)\b/.test(
      lower
    );
  const hasQuestion = /[?]/.test(reply);
  const advisoryFrame =
    /\b(consiglio|suggest|recommend|consigliamo|ti consiglio|je conseille|ich empfehle|te recomiendo)\b/.test(
      lower
    );
  return (
    (hasCapabilityFrame || advisoryFrame) &&
    hasGuidanceAction &&
    (hasQuestion || advisoryFrame)
  );
}

function detectExplicitLanguageSwitchCommand(
  message: string
): SupportedLanguage | null {
  const folded = foldContextText(message);
  const hasSwitchIntent =
    /\b(rispondi|parla|scrivi|in\b|answer|reply|respond|speak|write|habla|responde|escribe|parlez|repondez|ecrivez|sprich|antworte|schreib)\b/.test(
      folded
    ) &&
    /\b(italian|italiano|inglese|english|spanish|espanol|espanol|castellano|french|francese|francais|german|tedesco|deutsch)\b/.test(
      folded
    );

  if (!hasSwitchIntent) return null;
  if (/\b(italian|italiano)\b/.test(folded)) return "it";
  if (/\b(english|inglese)\b/.test(folded)) return "en";
  if (/\b(spanish|espanol|castellano)\b/.test(folded)) return "es";
  if (/\b(french|francese|francais)\b/.test(folded)) return "fr";
  if (/\b(german|tedesco|deutsch)\b/.test(folded)) return "de";
  return null;
}

function hasEvidenceForExternalGuidance(reply: string, evidenceText: string): boolean {
  const evidence = String(evidenceText || "");
  if (!evidence.trim()) return false;

  const replyTokens = extractFollowUpIntentTokens(reply).filter((t) => t.length >= 4);
  const anchorTokens = replyTokens.filter(
    (token) =>
      !CONTEXT_TOKEN_STOPWORDS.has(token) &&
      !tokenMatchesAnyStem(token, EXTERNAL_GUIDANCE_ACTION_STEMS)
  );
  if (!anchorTokens.length) return false;

  const evidenceTokens = new Set(extractContextQueryTokens(evidence));
  if (evidenceTokens.size === 0) return false;

  const evidenceActionTokens = extractFollowUpIntentTokens(evidence).filter(
    (token) => token.length >= 4 && tokenMatchesAnyStem(token, EXTERNAL_GUIDANCE_ACTION_STEMS)
  );
  // External-guidance follow-ups are allowed only when evidence also contains
  // explicit guidance/action language, not just topical nouns.
  if (!evidenceActionTokens.length) return false;

  let matched = 0;
  for (const token of anchorTokens) {
    if (evidenceTokens.has(token)) matched += 1;
  }
  const coverage = matched / Math.max(1, anchorTokens.length);
  return matched >= 2 || (matched >= 1 && coverage >= 0.6);
}

function looksLikeOfferFollowUpQuestion(questionText: string): boolean {
  const lower = foldContextText(questionText);
  const hasFollowUpShape =
    /\b(vuoi|want|would you like|quieres|voulez|mochtest|preferisci|prefieres|preferez|bevorzugst)\b/.test(
      lower
    ) || /[?]/.test(questionText);
  if (!hasFollowUpShape) return false;
  return (
    /\b(aiut|help|ayud|aider|helf|trov|find|buscar|trouver|such|search|cerc|fornir|provide|indicar|indicare|donner|geben|consigl|recommend|sugger|contatt|contact|kontakt)\b/.test(
      lower
    ) ||
    /\b(dettagli|details|detalle|details|precisioni|specific|specifiche|specifico)\b/.test(
      lower
    )
  );
}

function isFollowUpQuestionGrounded(params: {
  questionText: string;
  evidenceText: string;
  userMessage: string;
}): boolean {
  const { questionText, evidenceText, userMessage } = params;
  const evidence = String(evidenceText || "").trim();
  if (!evidence) return false;

  const questionTokens = extractFollowUpIntentTokens(questionText).filter(
    (token) =>
      token.length >= 4 &&
      !CONTEXT_TOKEN_STOPWORDS.has(token) &&
      !tokenMatchesAnyStem(token, EXTERNAL_GUIDANCE_ACTION_STEMS)
  );
  if (questionTokens.length === 0) return false;

  const evidenceTokens = new Set(extractContextQueryTokens(evidence));
  if (evidenceTokens.size === 0) return false;

  const userTokens = new Set(extractContextQueryTokens(userMessage));

  let evidenceMatches = 0;
  let userMatches = 0;
  for (const token of questionTokens) {
    if (evidenceTokens.has(token)) evidenceMatches += 1;
    if (userTokens.has(token)) userMatches += 1;
  }

  const evidenceCoverage = evidenceMatches / Math.max(1, questionTokens.length);
  return (
    (evidenceMatches >= 2 || (evidenceMatches >= 1 && evidenceCoverage >= 0.6)) &&
    userMatches >= 1
  );
}

function stripUnsupportedFollowUpQuestions(params: {
  reply: string;
  evidenceText: string;
  useKnowledge: boolean;
  userMessage: string;
}): { reply: string; removedCount: number } {
  const { reply, evidenceText, useKnowledge, userMessage } = params;
  if (!useKnowledge) return { reply, removedCount: 0 };
  const segments = reply.split(/(?<=\?)/u);
  if (segments.length <= 1) return { reply, removedCount: 0 };

  let removedCount = 0;
  const kept: string[] = [];

  for (const segment of segments) {
    const trimmed = segment.trim();
    const questionIndex = segment.lastIndexOf("?");
    const isQuestionSegment = questionIndex >= 0 && /[?]["')\]]*\s*$/u.test(trimmed);
    if (!isQuestionSegment) {
      kept.push(segment);
      continue;
    }

    const lastDot = segment.lastIndexOf(".", questionIndex);
    const lastBang = segment.lastIndexOf("!", questionIndex);
    const lastNewline = segment.lastIndexOf("\n", questionIndex);
    const splitIndex = Math.max(lastDot, lastBang, lastNewline);
    const prefix = splitIndex >= 0 ? segment.slice(0, splitIndex + 1) : "";
    const questionPart = splitIndex >= 0 ? segment.slice(splitIndex + 1) : segment;
    const questionText = questionPart.trim();

    const unsupported =
      ((hasExplicitExternalCapabilityAction(questionText) ||
        looksLikeOutOfScopeExternalGuidance(questionText)) &&
        !hasEvidenceForExternalGuidance(questionText, evidenceText)) ||
      (looksLikeOfferFollowUpQuestion(questionText) &&
        !isFollowUpQuestionGrounded({
          questionText,
          evidenceText,
          userMessage
        }));

    if (unsupported) {
      removedCount += 1;
      if (prefix.trim()) kept.push(prefix);
      continue;
    }

    kept.push(segment);
  }

  const rebuilt = kept.join("").replace(/[ \t]+\n/g, "\n").trim();
  return {
    reply: rebuilt || reply,
    removedCount
  };
}

function looksLikeCapabilityProposalCandidate(text: string): boolean {
  return hasExplicitExternalCapabilityAction(text);
}

function buildCapabilityScopeFallback(
  lang: "it" | "en" | "es" | "de" | "fr"
): string {
  if (lang === "it") {
    return "Posso aiutarti solo con informazioni verificate nei contenuti disponibili e con i contatti dell'azienda presenti nel materiale. Non posso promettere azioni esterne non confermate.";
  }
  if (lang === "es") {
    return "Solo puedo ayudarte con informacion verificada en el contenido disponible y con contactos de la empresa presentes en el material. No puedo prometer acciones externas no confirmadas.";
  }
  if (lang === "de") {
    return "Ich kann dir nur mit verifizierten Informationen aus den verfugbaren Inhalten und mit dort vorhandenen Unternehmenskontakten helfen. Ich kann keine unbestaetigten externen Aktionen versprechen.";
  }
  if (lang === "fr") {
    return "Je peux seulement t'aider avec des informations verifiees dans le contenu disponible et avec les contacts de l'entreprise presents dans le materiel. Je ne peux pas promettre des actions externes non confirmees.";
  }
  return "I can only help with verified information from the available content and with company contacts present in that material. I cannot promise unconfirmed external actions.";
}

async function isUnsupportedCapabilityProposal(params: {
  userMessage: string;
  reply: string;
  evidenceText: string;
  supportedActionHints?: string[];
  usageContext: { userId?: string | null; botId?: string | null };
}): Promise<boolean> {
  const { userMessage, reply, evidenceText, supportedActionHints, usageContext } = params;
  if (!looksLikeCapabilityProposalCandidate(reply)) return false;

  const evidenceSnippet = String(evidenceText || "")
    .trim()
    .slice(0, 3000);
  const actionHints = Array.isArray(supportedActionHints)
    ? supportedActionHints.filter((value) => typeof value === "string" && value.trim().length > 0)
    : [];
  const actionHintsText =
    actionHints.length > 0 ? actionHints.join(", ") : "(none)";

  try {
    const raw = await getChatCompletion({
      model: "gpt-4o-mini",
      maxTokens: 120,
      messages: [
        {
          role: "system",
          content:
            "You are a strict capability guard for a knowledge-grounded assistant.\n" +
            "Return ONLY JSON: {\"unsupported\":true|false,\"confidence\":0-1}.\n" +
            "Mark unsupported=true if the reply promises or offers actions/capabilities that are not explicitly supported by provided evidence or by explicit tool results in this same turn.\n" +
            "If uncertain, choose unsupported=true.\n" +
            "Treat drafting/sending messages, contacting third parties, finding external providers, or executing workflows as unsupported unless explicitly evidenced."
        },
        {
          role: "user",
          content:
            `User message:\n${userMessage}\n\n` +
            `Assistant reply:\n${reply}\n\n` +
            `Evidence:\n${evidenceSnippet || "(none)"}\n\n` +
            `Supported actions from tool results in this turn:\n${actionHintsText}`
        }
      ],
      usageContext: {
        ...usageContext,
        operation: "capability_guard"
      }
    });

    const parsedBlock = raw.trim();
    const jsonText =
      parsedBlock.startsWith("{") && parsedBlock.endsWith("}")
        ? parsedBlock
        : parsedBlock.slice(
            Math.max(0, parsedBlock.indexOf("{")),
            parsedBlock.lastIndexOf("}") + 1
          );
    if (!jsonText || !jsonText.startsWith("{")) return true;

    const parsed = JSON.parse(jsonText) as { unsupported?: unknown; confidence?: unknown };
    const unsupported = parsed.unsupported === true;
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : 0;
    if (unsupported) return true;
    return confidence < 0.55;
  } catch {
    return true;
  }
}

async function rewriteReplyToLanguage(params: {
  reply: string;
  targetLanguage: "it" | "en" | "es" | "de" | "fr";
  usageContext: { userId?: string | null; botId?: string | null };
}): Promise<string | null> {
  const { reply, targetLanguage, usageContext } = params;
  const languageLabel =
    targetLanguage === "it"
      ? "Italian"
      : targetLanguage === "es"
      ? "Spanish"
      : targetLanguage === "de"
      ? "German"
      : targetLanguage === "fr"
      ? "French"
      : "English";

  try {
    const rewritten = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: 260,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the assistant reply in the target language.\n" +
            "Rules:\n" +
            "- Preserve all factual meaning.\n" +
            "- Do not add new facts, promises, or capabilities.\n" +
            "- Keep tone concise and natural.\n" +
            "- Return only the rewritten reply text.\n"
        },
        {
          role: "user",
          content:
            `Target language: ${languageLabel}\n` +
            "Reply to rewrite:\n" +
            reply
        }
      ],
      usageContext: {
        ...usageContext,
        operation: "chat_language_rewrite"
      }
    });
    return rewritten?.trim() || null;
  } catch {
    return null;
  }
}

function looksLikeShortAffirmativeDeflection(reply: string): boolean {
  const lower = foldContextText(reply);
  const hasQuestionLikeDeflection =
    /\b(vuoi|se vuoi|posso darti maggiori dettagli|posso fornirti maggiori dettagli|come posso aiutarti)\b/.test(
      lower
    ) ||
    /\b(if you need|if you want|would you like more details|feel free to ask|how can i help)\b/.test(
      lower
    ) ||
    /\b(si quieres|quieres mas detalles|como puedo ayudarte)\b/.test(lower) ||
    /\b(si tu veux|souhaitez vous|veux tu plus de details|comment puis je aider)\b/.test(
      lower
    ) ||
    /\b(wenn du mochtest|mochtest du mehr details|wie kann ich helfen)\b/.test(
      lower
    );
  return hasQuestionLikeDeflection;
}

function isConcreteFollowUpResolution(
  reply: string,
  context: ShortAffirmativeFollowUpContext
): boolean {
  const foldedReply = foldContextText(reply);
  if (hasUncertaintyMarkers(foldedReply)) return false;
  if (extractNumericClaims(reply).length > 0) return true;

  const topicTokens = extractContextQueryTokens(context.resolvedKnowledgeQuery).slice(0, 8);
  if (topicTokens.length === 0) return false;

  let matched = 0;
  for (const token of topicTokens) {
    const tokenHit = buildContextTokenCandidates(token).some((candidate) => {
      const positions = findTermPositions({
        text: foldedReply,
        term: candidate.term,
        mode: candidate.mode
      });
      return positions.length > 0;
    });
    if (tokenHit) matched += 1;
  }

  // Require at least two concrete topic token hits when no numeric anchors exist.
  // This prevents generic deflections that only repeat one keyword from passing.
  return matched >= 2;
}
function hasMinimumTopicAlignment(params: {
  reply: string;
  query: string;
  minMatches?: number;
}): boolean {
  const { reply, query } = params;
  const minMatches = Math.max(1, params.minMatches ?? 1);
  const foldedReply = foldContextText(reply);
  const queryTokens = extractFollowUpIntentTokens(query);
  const tokens =
    queryTokens.length > 0
      ? queryTokens
      : extractContextQueryTokens(query).slice(0, 8);
  if (tokens.length === 0) return true;

  let matched = 0;
  for (const token of tokens) {
    const hit = buildContextTokenCandidates(token).some((candidate) => {
      const positions = findTermPositions({
        text: foldedReply,
        term: candidate.term,
        mode: candidate.mode
      });
      return positions.length > 0;
    });
    if (hit) matched += 1;
    if (matched >= minMatches) return true;
  }
  return false;
}
async function rewriteReplyWithinCapabilities(params: {
  reply: string;
  targetLanguage: "it" | "en" | "es" | "de" | "fr";
  usageContext: { userId?: string | null; botId?: string | null };
}): Promise<string | null> {
  const { reply, targetLanguage, usageContext } = params;
  const languageLabel =
    targetLanguage === "it"
      ? "Italian"
      : targetLanguage === "es"
      ? "Spanish"
      : targetLanguage === "de"
      ? "German"
      : targetLanguage === "fr"
      ? "French"
      : "English";

  try {
    const rewritten = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: 260,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the assistant reply in the target language.\n" +
            "Rules:\n" +
            "- Preserve factual content.\n" +
            "- Remove any claim of executing external actions on the user's behalf.\n" +
            "- Never say you will contact third parties, send requests, or perform workflows for the user.\n" +
            "- Safe alternative phrasing is allowed, e.g. offering to share verified contact details.\n" +
            "- Keep concise and natural.\n" +
            "- Return only the rewritten reply text.\n"
        },
        {
          role: "user",
          content:
            `Target language: ${languageLabel}\n` +
            "Reply to rewrite:\n" +
            reply
        }
      ],
      usageContext: {
        ...usageContext,
        operation: "chat_capability_rewrite"
      }
    });
    return rewritten?.trim() || null;
  } catch {
    return null;
  }
}

async function repairShortAffirmativeFollowUpReply(params: {
  reply: string;
  context: ShortAffirmativeFollowUpContext;
  evidenceText: string;
  targetLanguage: "it" | "en" | "es" | "de" | "fr";
  usageContext: { userId?: string | null; botId?: string | null };
}): Promise<string | null> {
  const { reply, context, evidenceText, targetLanguage, usageContext } = params;
  const languageLabel =
    targetLanguage === "it"
      ? "Italian"
      : targetLanguage === "es"
      ? "Spanish"
      : targetLanguage === "de"
      ? "German"
      : targetLanguage === "fr"
      ? "French"
      : "English";
  const evidenceSnippet = String(evidenceText || "").trim().slice(0, 3500);

  try {
    const rewritten = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You are repairing an assistant reply after a short affirmative follow-up from the user.\n" +
            "Return ONLY the final assistant reply text.\n" +
            "Rules:\n" +
            "- Answer directly and concretely to the previous assistant question/topic.\n" +
            "- Do NOT ask another generic 'do you want more details' question.\n" +
            "- Use evidence when present; do not invent facts.\n" +
            "- If evidence is missing, state exactly what is missing and ask one focused clarification.\n" +
            "- Keep the same language requested in Target language.\n"
        },
        {
          role: "user",
          content:
            `Target language: ${languageLabel}\n` +
            `Previous assistant question/topic: ${context.previousQuestion}\n` +
            `Resolved follow-up query: ${context.resolvedKnowledgeQuery}\n` +
            `Current weak/deflective reply:\n${reply}\n\n` +
            `Evidence:\n${evidenceSnippet || "(none)"}`
        }
      ],
      usageContext: {
        ...usageContext,
        operation: "chat_short_followup_repair"
      }
    });
    return rewritten?.trim() || null;
  } catch {
    return null;
  }
}

function resolvePolicyTargetLanguage(params: {
  lockedLanguage: string | null;
  routedLanguage: string | null;
  followUpLanguage: SupportedLanguage | null;
  detectedLanguage: SupportedLanguage | null;
  historyLanguage: SupportedLanguage | null;
  quickLanguage: SupportedLanguage | null;
}): SupportedLanguage | null {
  const {
    lockedLanguage,
    routedLanguage,
    followUpLanguage,
    detectedLanguage,
    historyLanguage,
    quickLanguage
  } = params;
  if (isSupportedLanguage(lockedLanguage)) {
    return lockedLanguage;
  }
  if (isSupportedLanguage(routedLanguage)) {
    return routedLanguage;
  }
  if (followUpLanguage) return followUpLanguage;
  if (detectedLanguage) return detectedLanguage;
  if (historyLanguage) return historyLanguage;
  return quickLanguage;
}

function buildLanguageConsistencyFallback(
  lang: "it" | "en" | "es" | "de" | "fr"
): string {
  if (lang === "it") {
    return "Certo, continuo in italiano. Dimmi pure cosa vuoi sapere e ti aiuto subito.";
  }
  if (lang === "es") {
    return "Claro, continuo en espanol. Dime que necesitas y te ayudo enseguida.";
  }
  if (lang === "de") {
    return "Klar, ich mache auf Deutsch weiter. Sag mir einfach, was du brauchst, und ich helfe dir direkt.";
  }
  if (lang === "fr") {
    return "Bien sur, je continue en francais. Dis-moi ce dont tu as besoin et je t'aide tout de suite.";
  }
  return "Sure, I will continue in English. Tell me what you need and I will help right away.";
}

function foldContextText(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractContextQueryTokens(message: string): string[] {
  const normalized = foldContextText(message);
  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !CONTEXT_TOKEN_STOPWORDS.has(t));
  return Array.from(new Set(tokens)).slice(0, 10);
}

function buildContextTokenCandidates(token: string): Array<{
  term: string;
  mode: "exact" | "stem" | "prefix";
}> {
  const out: Array<{ term: string; mode: "exact" | "stem" | "prefix" }> = [
    { term: token, mode: "exact" }
  ];
  const seen = new Set<string>([token]);

  const stemSuffixes = [
    "mente",
    "zione",
    "zioni",
    "sione",
    "sioni",
    "mento",
    "menti",
    "ing",
    "ers",
    "er",
    "es",
    "en",
    "ed",
    "ly",
    "no",
    "na",
    "ni",
    "ne",
    "i",
    "e",
    "o",
    "a",
    "s"
  ];

  for (const suffix of stemSuffixes) {
    if (!token.endsWith(suffix)) continue;
    const stem = token.slice(0, token.length - suffix.length);
    if (stem.length < 4 || seen.has(stem)) continue;
    seen.add(stem);
    out.push({ term: stem, mode: "stem" });
  }

  if (token.length >= 6) {
    const prefix = token.slice(0, 4);
    if (!seen.has(prefix)) {
      out.push({ term: prefix, mode: "prefix" });
    }
  }

  return out;
}

function findTermPositions(params: {
  text: string;
  term: string;
  mode: "exact" | "stem" | "prefix";
}): number[] {
  const { text, term, mode } = params;
  if (!term || term.length < 3) return [];

  const pattern =
    mode === "exact"
      ? new RegExp(`\\b${escapeRegex(term)}\\b`, "g")
      : mode === "stem"
        ? new RegExp(`\\b${escapeRegex(term)}[a-z0-9]{0,12}\\b`, "g")
        : new RegExp(`\\b${escapeRegex(term)}[a-z0-9]{0,20}\\b`, "g");

  const positions: number[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text)) !== null) {
    positions.push(match.index);
  }
  return positions;
}

function buildContextWindow(params: {
  contentLength: number;
  anchorPos: number;
  windowChars: number;
  beforeRatio: number;
}): { start: number; end: number } {
  const { contentLength, anchorPos, windowChars, beforeRatio } = params;
  const before = Math.floor(windowChars * beforeRatio);
  let start = Math.max(0, anchorPos - before);
  let end = Math.min(contentLength, start + windowChars);
  if (end - start < windowChars) {
    start = Math.max(0, end - windowChars);
  }
  return { start, end };
}

function clipWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const target = Math.max(0, maxChars - 1);
  const boundaryCandidates = [
    text.lastIndexOf("\n", target),
    text.lastIndexOf(". ", target),
    text.lastIndexOf("; ", target),
    text.lastIndexOf(": ", target),
    text.lastIndexOf(", ", target)
  ].filter((idx) => idx >= 0);
  const bestBoundary = boundaryCandidates.length > 0 ? Math.max(...boundaryCandidates) : -1;
  const safeCut = bestBoundary >= Math.floor(target * 0.72) ? bestBoundary + 1 : target;
  return text.slice(0, safeCut).trimEnd() + "…";
}

function findRegexPositions(text: string, pattern: RegExp): number[] {
  const positions: number[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text)) !== null) {
    positions.push(match.index);
    if (pattern.lastIndex === match.index) {
      pattern.lastIndex += 1;
    }
  }
  return positions;
}

function dedupeAnchorPositions(positions: number[], minGap: number): number[] {
  const out: number[] = [];
  for (const pos of positions) {
    if (pos < 0) continue;
    if (out.some((existing) => Math.abs(existing - pos) < minGap)) continue;
    out.push(pos);
  }
  return out;
}

function collectFactualAnchorPositions(loweredRaw: string): number[] {
  const factualPatterns = [
    /\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\s?(?:€|euro|eur|\$|usd|kg|kw|w|v|ah|lt|mm|cm|m|ore|ora|hours?|giorni?|days?|mesi?|months?|stagion\w*|weekend|%)\b/g,
    /\b(?:weekend|stagion\w*|mese|mesi|month|months|giorno|giorni|day|days|durata|duration|prezz\w*|cost\w*|tariff\w*|finanzi\w*|rateal\w*|pagament\w*)\b/g,
    /(?:^|[\n\r])\s*(?:[-*•]|\d+[.)])\s+/gm
  ];

  const anchors: number[] = [];
  for (const pattern of factualPatterns) {
    anchors.push(...findRegexPositions(loweredRaw, pattern));
  }
  return dedupeAnchorPositions(
    Array.from(new Set(anchors)).sort((a, b) => a - b),
    90
  );
}

function mergeContextSpans(
  spans: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  if (spans.length <= 1) return spans;
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  if (sorted.length <= 1) return sorted;

  const merged: Array<{ start: number; end: number }> = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + 80) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function buildContextSnippet(params: {
  rawText: string;
  message: string;
  maxChars: number;
}): string {
  const raw = (params.rawText || "").trim();
  if (!raw) return "";
  if (raw.length <= params.maxChars) return raw;

  const loweredRaw = foldContextText(raw);
  const queryTokens = extractContextQueryTokens(params.message);
  const factualAnchors = collectFactualAnchorPositions(loweredRaw);

  const tokenMatches = queryTokens
    .map((token) => {
      const candidateMatches = buildContextTokenCandidates(token)
        .map((candidate) => ({
          ...candidate,
          positions: findTermPositions({
            text: loweredRaw,
            term: candidate.term,
            mode: candidate.mode
          })
        }))
        .filter((candidate) => candidate.positions.length > 0)
        .sort((a, b) => {
          const modeRank = (mode: "exact" | "stem" | "prefix") =>
            mode === "exact" ? 0 : mode === "stem" ? 1 : 2;
          if (modeRank(a.mode) !== modeRank(b.mode)) {
            return modeRank(a.mode) - modeRank(b.mode);
          }
          if (a.positions.length !== b.positions.length) {
            return a.positions.length - b.positions.length;
          }
          return b.term.length - a.term.length;
        });

      if (!candidateMatches.length) return null;
      return {
        token,
        ...candidateMatches[0]
      };
    })
    .filter(
      (
        match
      ): match is {
        token: string;
        term: string;
        mode: "exact" | "stem" | "prefix";
        positions: number[];
      } => !!match
    );

  const anchorCandidates: number[] = [];
  if (tokenMatches.length > 0) {
    const rankedMatches = tokenMatches.sort((a, b) => {
      const modeRank = (mode: "exact" | "stem" | "prefix") =>
        mode === "exact" ? 0 : mode === "stem" ? 1 : 2;
      if (modeRank(a.mode) !== modeRank(b.mode)) {
        return modeRank(a.mode) - modeRank(b.mode);
      }
      if (a.positions.length !== b.positions.length) {
        return a.positions.length - b.positions.length;
      }
      return b.term.length - a.term.length;
    });

    const primaryPos = rankedMatches[0].positions[0];
    anchorCandidates.push(primaryPos);

    const allTokenPositions = rankedMatches.flatMap((match) => match.positions);
    const farthestTokenPos = allTokenPositions.reduce((best, current) => {
      if (best < 0) return current;
      const bestDistance = Math.abs(best - primaryPos);
      const currentDistance = Math.abs(current - primaryPos);
      return currentDistance > bestDistance ? current : best;
    }, -1);
    if (farthestTokenPos >= 0) {
      anchorCandidates.push(farthestTokenPos);
    }
  }

  if (factualAnchors.length > 0) {
    anchorCandidates.push(factualAnchors[0]);
    anchorCandidates.push(factualAnchors[Math.floor((factualAnchors.length - 1) / 2)]);
    anchorCandidates.push(factualAnchors[factualAnchors.length - 1]);
  }

  const maxAnchors = params.maxChars >= 1400 ? 4 : 3;
  const selectedAnchors = dedupeAnchorPositions(
    anchorCandidates,
    Math.max(90, Math.floor(params.maxChars * 0.1))
  ).slice(0, maxAnchors);

  const primaryWindow = Math.max(560, Math.floor(params.maxChars * 0.6));
  const secondaryWindow = Math.max(240, Math.floor(params.maxChars * 0.3));
  const spans = selectedAnchors.map((anchorPos, index) =>
    buildContextWindow({
      contentLength: raw.length,
      anchorPos,
      windowChars: index === 0 ? primaryWindow : secondaryWindow,
      beforeRatio: index === 0 ? 0.3 : 0.24
    })
  );

  const mergedSpans = mergeContextSpans(spans);
  if (mergedSpans.length > 0) {
    const mergedSegments: string[] = [];
    let hasLeadingGap = false;
    let hasTrailingGap = false;

    for (let i = 0; i < mergedSpans.length; i += 1) {
      const span = mergedSpans[i];
      if (i === 0 && span.start > 0) hasLeadingGap = true;
      if (i === mergedSpans.length - 1 && span.end < raw.length) hasTrailingGap = true;
      const section = raw.slice(span.start, span.end).trim();
      if (section) mergedSegments.push(section);
    }

    let snippet = mergedSegments.join("\n...\n");
    if (hasLeadingGap) snippet = "..." + snippet;
    if (hasTrailingGap) snippet += "...";
    return clipWithEllipsis(snippet, params.maxChars);
  }

  if (factualAnchors.length > 0) {
    const factualFocus = factualAnchors[factualAnchors.length - 1];
    const factualSpan = buildContextWindow({
      contentLength: raw.length,
      anchorPos: factualFocus,
      windowChars: Math.max(420, Math.floor(params.maxChars * 0.74)),
      beforeRatio: 0.2
    });
    const introSpan = {
      start: 0,
      end: Math.min(raw.length, Math.max(180, Math.floor(params.maxChars * 0.2)))
    };
    const combined = mergeContextSpans([introSpan, factualSpan]);
    const sections = combined.map((span) => raw.slice(span.start, span.end).trim());
    return clipWithEllipsis(sections.join("\n...\n"), params.maxChars);
  }

  const headChars = Math.floor(params.maxChars * 0.5);
  const tailChars = Math.max(260, params.maxChars - headChars - 8);
  const head = raw.slice(0, headChars).trim();
  const tail = raw.slice(-tailChars).trim();
  return clipWithEllipsis(`${head}\n...\n${tail}`, params.maxChars);
}

function buildContextChunkBudgets(chunkCount: number): number[] {
  if (chunkCount <= 0) return [];
  const budgets: number[] = Array.from({ length: chunkCount }, (_, index) =>
    PRIORITIZED_CONTEXT_CHARS[index] ?? BASE_CONTEXT_CHARS_PER_CHUNK
  );

  let total = budgets.reduce((sum, value) => sum + value, 0);
  if (total <= MAX_TOTAL_CONTEXT_CHARS) return budgets;

  let overflow = total - MAX_TOTAL_CONTEXT_CHARS;
  for (let i = budgets.length - 1; i >= 0 && overflow > 0; i -= 1) {
    const reducible = Math.max(0, budgets[i] - MIN_CONTEXT_CHARS_PER_CHUNK);
    if (reducible <= 0) continue;
    const cut = Math.min(reducible, overflow);
    budgets[i] -= cut;
    overflow -= cut;
  }

  if (overflow > 0) {
    for (let i = 0; i < budgets.length && overflow > 0; i += 1) {
      const reducible = Math.max(0, budgets[i] - MIN_CONTEXT_CHARS_PER_CHUNK);
      if (reducible <= 0) continue;
      const cut = Math.min(reducible, overflow);
      budgets[i] -= cut;
      overflow -= cut;
    }
  }

  total = budgets.reduce((sum, value) => sum + value, 0);
  if (total > MAX_TOTAL_CONTEXT_CHARS && budgets.length > 0) {
    budgets[budgets.length - 1] = Math.max(
      MIN_CONTEXT_CHARS_PER_CHUNK,
      budgets[budgets.length - 1] - (total - MAX_TOTAL_CONTEXT_CHARS)
    );
  }

  return budgets;
}

// Intent routing is handled by the LLM-based router; avoid heuristic keyword lists here.

export class ChatServiceError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Narrowed/normalized view of booking config that the chat layer needs.
 */
type BotBookingConfig = {
  requiredFields: string[];
  customFields: string[];
  minLeadHours: number | null;
  maxAdvanceDays: number | null;
  services: Array<{ name: string; aliases?: string[] }>;
};

function normalizeBookingConfigForChat(
  booking?: BookingConfig
): BotBookingConfig | null {
  if (!booking || !booking.enabled) return null;

  const minLeadHours =
    typeof booking.minLeadHours === "number" && booking.minLeadHours > 0
      ? booking.minLeadHours
      : null;

  const maxAdvanceDays =
    typeof booking.maxAdvanceDays === "number" && booking.maxAdvanceDays > 0
      ? booking.maxAdvanceDays
      : null;

  let requiredFields: string[] =
    Array.isArray(booking.requiredFields) && booking.requiredFields.length > 0
      ? booking.requiredFields
      : BASE_BOOKING_FIELDS.slice();

  // Clean + dedupe + ensure base fields exist
  const set = new Set<string>();
  for (const f of requiredFields) {
    const trimmed = f.trim();
    if (trimmed) set.add(trimmed);
  }
  for (const base of BASE_BOOKING_FIELDS) {
    set.add(base);
  }
  requiredFields = Array.from(set);

  const customFields = requiredFields.filter(
    (f) =>
      !BASE_BOOKING_FIELDS.includes(f as (typeof BASE_BOOKING_FIELDS)[number])
  );

  return {
    requiredFields,
    customFields,
    minLeadHours,
    maxAdvanceDays,
    services:
      Array.isArray(booking.services) && booking.services.length > 0
        ? booking.services.map((s) => ({
            name: s.name,
            aliases: s.aliases
          }))
        : []
  };
}

function buildBookingTool(bookingCfg: BotBookingConfig): ChatTool {
  const properties: Record<string, any> = {
    name: {
      type: "string",
      description: "User's full name"
    },
    email: {
      type: "string",
      description:
        "User's email address, used for booking confirmations and reminders"
    },
    phone: {
      type: "string",
      description:
        "User's phone number including country code if possible"
    },
    service: {
      type: "string",
      description:
        "Requested service or treatment (must match one of the configured services; ask if unsure)."
    },
    datetime: {
      type: "string",
      description:
        "Requested appointment date and time in ISO 8601 (e.g. 2025-11-23T15:00:00). Treat as local time in the business's time zone."
    }
  };

  // Add custom fields from config so the model can pass them through
  for (const customField of bookingCfg.customFields) {
    if (properties[customField]) continue;
    properties[customField] = {
      type: "string",
      description: `Custom booking field '${customField}' as free text provided by the user.`
    };
  }

  const required = bookingCfg.requiredFields.slice();

  return {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Create an appointment for the user in the business calendar.",
      parameters: {
        type: "object",
        properties,
        required
      }
    }
  };
}

function buildUpdateBookingTool(bookingCfg: BotBookingConfig): ChatTool {
  return {
    type: "function",
    function: {
      name: "update_appointment",
      description:
        "Reschedule an existing appointment to a new date/time and/or service.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description:
              "User's email used for the original booking. Used to find the booking."
          },
          originalDatetime: {
            type: "string",
            description:
              "Date/time of the existing booking in ISO 8601 (e.g. 2025-11-23T15:00:00). Treated as local time in the business time zone."
          },
          newDatetime: {
            type: "string",
            description:
              "Requested new appointment date/time in ISO 8601, local to the business time zone."
          },
          service: {
            type: "string",
            description:
              "New service name if the user wants to change the service."
          }
        },
        required: ["email", "originalDatetime", "newDatetime"]
      }
    }
  };
}

function buildCancelBookingTool(): ChatTool {
  return {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Cancel an existing appointment for the user.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description:
              "User's email used for the original booking. Used to find the booking."
          },
          originalDatetime: {
            type: "string",
            description:
              "Date/time of the existing booking in ISO 8601 (e.g. 2025-11-23T15:00:00). Treated as local time in the business time zone."
          },
          reason: {
            type: "string",
            description: "Optional cancellation reason provided by the user."
          }
        },
        required: ["email", "originalDatetime"]
      }
    }
  };
}

type RestaurantChatToolConfig = {
  timeZone: string;
  askSmokingPreference: boolean;
};

function buildRestaurantCreateReservationTool(
  cfg: RestaurantChatToolConfig
): ChatTool {
  const properties: Record<string, any> = {
    name: {
      type: "string",
      description: "Reservation name."
    },
    email: {
      type: "string",
      description: "Customer email."
    },
    phone: {
      type: "string",
      description: "Customer phone number."
    },
    partySize: {
      type: "number",
      description: "Number of guests."
    },
    datetime: {
      type: "string",
      description: `Requested reservation datetime in ISO 8601 local to ${cfg.timeZone} (example: 2026-03-18T20:30:00).`
    },
    notes: {
      type: "string",
      description: "Optional customer notes."
    }
  };

  if (cfg.askSmokingPreference) {
    properties.smokingPreference = {
      type: "string",
      enum: ["smoking", "non_smoking", "no_preference"],
      description:
        "Smoking preference. Ask only when needed and only if options differ."
    };
  }

  return {
    type: "function",
    function: {
      name: "create_restaurant_reservation",
      description: "Create a restaurant table reservation.",
      parameters: {
        type: "object",
        properties,
        required: ["name", "email", "phone", "partySize", "datetime"]
      }
    }
  };
}

function buildRestaurantCancelReservationTool(): ChatTool {
  return {
    type: "function",
    function: {
      name: "cancel_restaurant_reservation",
      description:
        "Cancel an existing restaurant reservation by email and datetime.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "Customer email used for the reservation."
          },
          datetime: {
            type: "string",
            description:
              "Original reservation datetime in ISO 8601 local to the restaurant time zone."
          },
          reason: {
            type: "string",
            description: "Optional cancellation reason."
          }
        },
        required: ["email", "datetime"]
      }
    }
  };
}

function getRestaurantBookingInstructions(
  cfg: RestaurantChatToolConfig,
  nowIso: string
): string {
  const smokingHint = cfg.askSmokingPreference
    ? "- Ask smoking preference only once and only if the user did not already provide it.\n"
    : "- Do not ask about smoking preference.\n";

  return (
    `Restaurant booking mode is active. Time zone: ${cfg.timeZone}.\n` +
    `Server time (ISO 8601): ${nowIso}.\n` +
    "Use this as the reference for words like now, today, tomorrow, and in X days.\n" +
    "Collect these fields naturally: name, email, phone, party size, datetime.\n" +
    smokingHint +
    "- Convert relative date expressions (e.g. domani, tomorrow, stasera) into an explicit ISO datetime before calling tools.\n" +
    "- Never use guessed or old years for relative dates. Relative dates must be computed from the server time above.\n" +
    "Use tool `create_restaurant_reservation` only when all required fields are known.\n" +
    "If the user wants cancellation, use `cancel_restaurant_reservation`.\n" +
    "Do not claim confirmation before tool success.\n" +
    "If the tool fails with threshold/policy errors, politely ask the customer to contact the restaurant directly.\n"
  );
}

function buildShopifySearchTool(): ChatTool {
  return {
    type: "function",
    function: {
      name: "search_shopify_products",
      description:
        "Search the connected Shopify catalog by keywords and optional price filters.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query text" },
          minPrice: { type: "number", description: "Minimum price filter" },
          maxPrice: { type: "number", description: "Maximum price filter" },
          limit: { type: "number", description: "Max number of results (1-100)" },
          cursor: { type: "number", description: "Pagination cursor offset" }
        }
      }
    }
  };
}

function buildShopifyProductDetailsTool(): ChatTool {
  return {
    type: "function",
    function: {
      name: "get_shopify_product_details",
      description:
        "Get detailed Shopify product data including variants and availability.",
      parameters: {
        type: "object",
        properties: {
          productId: {
            type: "string",
            description: "Shopify product ID (gid://shopify/Product/...)"
          }
        },
        required: ["productId"]
      }
    }
  };
}

function buildShopifyAddToCartTool(): ChatTool {
  return {
    type: "function",
    function: {
      name: "shopify_add_to_cart",
      description:
        "Generate cart URLs for adding a product variant to the Shopify cart.",
      parameters: {
        type: "object",
        properties: {
          variantId: {
            type: "string",
            description: "Shopify variant ID (gid://shopify/ProductVariant/...)"
          },
          quantity: { type: "number", description: "Quantity to add" },
          sessionId: {
            type: "string",
            description:
              "Session identifier for the user (defaults to current conversation if omitted)."
          }
        },
        required: ["variantId", "quantity"]
      }
    }
  };
}

function buildShopifyCheckoutLinkTool(): ChatTool {
  return {
    type: "function",
    function: {
      name: "shopify_get_checkout_link",
      description: "Get the Shopify cart URL for checkout.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  };
}

function buildShopifyOrderStatusTool(): ChatTool {
  return {
    type: "function",
    function: {
      name: "shopify_get_order_status",
      description: "Lookup order status by customer email and order number.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "Customer email address" },
          orderNumber: { type: "string", description: "Order number or name" }
        },
        required: ["email", "orderNumber"]
      }
    }
  };
}

function getShopifyInstructions(): string {
  return (
    "Shopify tools are available to search products, fetch product details, add items to cart, and check order status. " +
    "If a Shopify shop is connected, assume product questions refer to the store catalog and use Shopify tools proactively, even for short questions like 'Avete snowboard?' or 'Do you sell X?'. " +
    "Prefer search before product details if you need to narrow options. " +
    "When a tool returns URLs (addToCartUrl, productUrl, cartUrl), include them verbatim in your reply so the widget can render actions. " +
    "When presenting Shopify tool results, keep the reply in the user's language and do not switch to English unless the user does. " +
    "If the user wants to buy something (e.g. 'voglio il primo', 'lo compro', 'buy this'), call shopify_add_to_cart instead of asking for email. " +
    "Email is only required for order status lookups. If the user asks 'Where is my order?', ask for email and order number, then call shopify_get_order_status. " +
    "For order status replies: use the tool's summary, include tracking company/number/URL if present, mention partial fulfillment if indicated, and add the delivery + address guidance. " +
    "Never invent product URLs, shop domains, or checkout links; only use URLs returned by Shopify tools. " +
    "Do not claim you added items to the cart; you must provide the add-to-cart link (the user must open it). " +
    "Do not include any URLs in the reply text; use tool outputs for buttons/actions only, except for order tracking URLs. " +
    "When listing multiple products, include one image per product (as markdown image) on its own line."
  );
}



function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const SHOPIFY_TOOL_NAMES = new Set([
  "search_shopify_products",
  "get_shopify_product_details",
  "shopify_add_to_cart",
  "shopify_get_checkout_link",
  "shopify_get_order_status"
]);

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

const shopifySearchSchema = z.object({
  query: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  limit: z.number().optional(),
  cursor: z.number().optional()
});

const shopifyProductDetailsSchema = z.object({
  productId: z.string().min(1)
});

const shopifyAddToCartSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().positive(),
  sessionId: z.string().optional()
});

const shopifyCheckoutSchema = z.object({}).passthrough();

const shopifyOrderStatusSchema = z.object({
  email: z.string().email(),
  orderNumber: z.string().min(1)
});

/**
 * Tool used to keep a per-conversation snapshot of booking details.
 */
function buildBookingDraftTool(bookingCfg: BotBookingConfig): ChatTool {
  const properties: Record<string, any> = {
    name: {
      type: "string",
      description: "User's full name, if known."
    },
    email: {
      type: "string",
      description: "User's email address, if known."
    },
    phone: {
      type: "string",
      description: "User's phone number, if known."
    },
    service: {
      type: "string",
      description: "Requested service or treatment, if known."
    },
    datetime: {
      type: "string",
      description:
        "Requested appointment date and time in ISO 8601, if known."
    }
  };

  for (const customField of bookingCfg.customFields) {
    if (properties[customField]) continue;
    properties[customField] = {
      type: "string",
      description: `Custom booking field '${customField}' as free text provided by the user. Include it when you learn or update this field.`
    };
  }

  return {
    type: "function",
    function: {
      name: "update_booking_draft",
      description:
        "Update the partial booking details collected so far for this conversation. Call this whenever you learn or change any booking fields.",
      parameters: {
        type: "object",
        properties
        // No required fields: send only the fields you just learned / updated.
      }
    }
  };
}

// Generic booking instructions injected as extra system message
function getBookingInstructions(bookingCfg: BotBookingConfig): string {
  const requiredList = bookingCfg.requiredFields.join(", ");
  const customList =
    bookingCfg.customFields.length > 0
      ? bookingCfg.customFields.join(", ")
      : "none";
  const serviceList =
    bookingCfg.services.length > 0
      ? bookingCfg.services.map((s) => s.name).join(", ")
      : "none";

  // Preferred step-by-step order: base fields (that are required) first, then custom fields
  const orderedFields: string[] = [];
  for (const base of BASE_BOOKING_FIELDS) {
    if (bookingCfg.requiredFields.includes(base)) {
      orderedFields.push(base);
    }
  }
  for (const custom of bookingCfg.customFields) {
    orderedFields.push(custom);
  }
  const orderedFieldsList =
    orderedFields.length > 0 ? orderedFields.join(" â†’ ") : "none";

  const nowIso = new Date().toISOString();

  return (
    `Server time (ISO 8601): ${nowIso}.\n` +
    "Use this as the reference for words like 'now', 'today', or 'in X days'.\n\n" +

    "BOOKING CONFIG:\n" +
    `- Required fields: ${requiredList}.\n` +
    `- Custom fields: ${customList}.\n` +
    `- Available services: ${serviceList}.\n` +
    "- Never enforce time rules yourself (past / lead time / max days / opening hours). Always send the user's requested datetime to the booking tools and let the backend validate.\n\n" +

    "STEP-BY-STEP COLLECTION:\n" +
    "- Use conversation history and any booking snapshot to see which fields (name, email, phone, service, datetime, custom fields) are already known.\n" +
    "- Do NOT re-ask a field that is clearly known, unless the user corrects it or says they never sent it.\n" +
    '- If the user says things like \"te l\'ho giÃ  mandato\" / \"I already gave it to you\", briefly apologise and reuse the earlier value.\n' +
    `- Ask for EXACTLY ONE missing booking field per message, always in this order: ${orderedFieldsList}.\n` +
    "- If several fields are missing, ask them one by one in that order.\n" +
    "- If a field (especially datetime) is ambiguous or incomplete, ask a focused follow-up only about that field.\n\n" +

    "WHEN TO CALL BOOKING TOOLS:\n" +
    "- As soon as ALL required fields are known and the user clearly wants to book (or is continuing a booking flow), you MUST call the appropriate booking tool in that same turn.\n" +
    '- Do NOT wait for an extra confirmation like "ok" or "grazie" once the user has already asked to book.\n' +
    "- Do NOT send a recap-only message saying you will book later; the tool call should be your next action once data is complete.\n\n" +

    "BOOKING DRAFT TOOL (`update_booking_draft`):\n" +
    "- When available, call this tool whenever you learn or change any booking field.\n" +
    "- Only include the fields that are new or updated in that turn.\n\n" +

    "DATE/TIME BEHAVIOR:\n" +
    "- When the user proposes a specific date/time, assume it might be valid.\n" +
    "- Once all required fields are known, call a booking tool and let the backend decide if the time is allowed or available.\n" +
    "- Do NOT say a time is invalid, unavailable, or in the past unless the booking tool result indicates a problem.\n\n" +

    "BOOKING TOOL RESPONSES, RECAP, AND ALTERNATIVES:\n" +
    "Booking tools return JSON with fields such as:\n" +
    "- success (boolean)\n" +
    "- action (created | updated | cancelled)\n" +
    "- start, end (strings)\n" +
    "- addToCalendarUrl (INTERNAL ONLY â€“ never show or paste this link)\n" +
    "- confirmationEmailSent (boolean | undefined)\n" +
    "- confirmationEmailError (string | undefined)\n" +
    "- possibly suggestedSlots: an array of alternative datetimes in ISO 8601, sorted by closeness to the requested time (this is OPTIONAL and may be missing).\n\n" +
    "- possibly suggestedSlotsDisplay: an array of pre-formatted alternative slots with fields {iso, weekday, date, time, label}. Use these labels verbatim when proposing alternatives (do NOT re-compute weekday names).\n\n" +
    "- possibly suggestedServices: an array of service names when the service is unclear or not matched (OPTIONAL).\n\n" +
    "After receiving the booking tool result:\n" +
    "- You may include a short recap of the final booking details (name, service, date/time) in the confirmation message.\n" +
    "- If success is true AND confirmationEmailSent is true: confirm that the booking/update/cancellation is complete and that a confirmation email has been sent.\n" +
    "- If success is true BUT confirmationEmailSent is false or missing: confirm that the booking/update/cancellation is complete, explain that the email may not arrive, and ask the user to note the date/time themselves. Never show any calendar link or raw URL.\n" +
    "- If success is false: apologise briefly and explain the error in simple language.\n" +
    "- If success is false AND suggestedSlots is present:\n" +
    "  â€¢ Never invent new times; only use the suggestedSlots data.\n" +
    "  â€¢ Propose up to two alternatives, giving priority to one just before and one just after the requested time if such options exist.\n" +
    "  â€¢ If there is no suitable option before, propose the first two options after the requested time.\n" +
    "  â€¢ If suggestedSlotsDisplay is present, use its labels verbatim for day/date/time.\n" +
    "- If success is false AND suggestedServices is present: ask the user to pick one of those services.\n" +
    "- Do NOT tell the user to wait while you \"process\" or \"book\"; silently use tools and then respond with the final result.\n"
  );
}

type GenerateReplyOptions = {
  conversationId?: string;
  channel?: "WEB" | "WHATSAPP" | "FACEBOOK" | "INSTAGRAM";
  sessionId?: string;
};

function detectReplyLanguageHint(): string | null {
  return null;
}

function languageHintFromLock(lang: "it" | "es" | "en" | "de" | "fr" | null): string | null {
  if (!lang) return null;
  if (lang === "it") return "Rispondi in italiano.";
  if (lang === "es") return "Responde en espanol.";
  if (lang === "de") return "Antworte auf Deutsch.";
  if (lang === "fr") return "Reponds en francais.";
  return "Respond in English.";
}

function languageHintFromDetected(lang: "it" | "es" | "en" | "de" | "fr" | null): string | null {
  if (!lang) return null;
  if (lang === "it") {
    return "L'utente ha scritto in italiano. Rispondi sempre in italiano, anche se il contesto e' in un'altra lingua.";
  }
  if (lang === "es") {
    return "El usuario escribio en espanol. Responde siempre en espanol, aunque el contexto este en otro idioma.";
  }
  if (lang === "de") {
    return "Der Nutzer hat auf Deutsch geschrieben. Antworte immer auf Deutsch, auch wenn der Kontext in einer anderen Sprache ist.";
  }
  if (lang === "fr") {
    return "L'utilisateur a ecrit en francais. Reponds toujours en francais, meme si le contexte est dans une autre langue.";
  }
  return "The user wrote in English. Always reply in English, even if the context is in another language.";
}

function strictLanguageInstruction(
  lang: "it" | "es" | "en" | "de" | "fr" | null
): string | null {
  if (!lang) return null;
  if (lang === "it") {
    return "STRICT OUTPUT LANGUAGE: Italian only. Translate any context snippets before answering.";
  }
  if (lang === "es") {
    return "STRICT OUTPUT LANGUAGE: Spanish only. Translate any context snippets before answering.";
  }
  if (lang === "de") {
    return "STRICT OUTPUT LANGUAGE: German only. Translate any context snippets before answering.";
  }
  if (lang === "fr") {
    return "STRICT OUTPUT LANGUAGE: French only. Translate any context snippets before answering.";
  }
  return "STRICT OUTPUT LANGUAGE: English only. Translate any context snippets before answering.";
}

type ReplyLang = "it" | "es" | "en" | "de" | "fr";
type WeekdayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";


const BOOKING_I18N: Record<ReplyLang, Record<string, string>> = {
  it: {
    bot_not_found: "Non riesco a trovare l'azienda per questa prenotazione.",
    booking_disabled: "Le prenotazioni non sono attive per questa azienda.",
    missing_fields: "Mi serve ancora: {fields}.",
    invalid_email: "L'indirizzo email non sembra valido. Puoi controllarlo?",
    invalid_datetime:
      "La data o l'orario non sono in un formato valido. Riprova per favore.",
    time_in_past: "L'orario richiesto Ã¨ nel passato. Scegli un altro orario.",
    min_lead_hours:
      "Le prenotazioni devono essere fatte con almeno {hours} ore di anticipo.",
    max_advance_days:
      "Le prenotazioni non possono essere fatte oltre {days} giorni in anticipo.",
    outside_opening_hours:
      "Questo orario Ã¨ fuori dagli orari di apertura. Scegli un altro orario.",
    fully_booked: "Quella fascia oraria Ã¨ giÃ  piena. Scegli un altro orario.",
    service_ambiguous:
      "Il servizio indicato corrisponde a piÃ¹ opzioni. {suggestions}",
    service_missing: "Quale servizio desideri?",
    service_not_found:
      "Non riesco a trovare quel servizio. {suggestions}",
    service_change_requires_new_booking:
      "Per cambiare servizio serve una nuova prenotazione. Annulla e prenota di nuovo con il nuovo servizio.",
    calendar_create_failed:
      "Non sono riuscito a creare l'appuntamento nel calendario per un errore interno.",
    calendar_update_failed:
      "Non sono riuscito ad aggiornare l'appuntamento nel calendario per un errore interno.",
    calendar_delete_failed:
      "Non sono riuscito ad annullare l'appuntamento nel calendario per un errore interno.",
    booking_not_found:
      "Non riesco a trovare una prenotazione con questa email e data/ora. Controlla i dati.",
    booking_update_failed:
      "Ho annullato l'evento nel calendario, ma non sono riuscito ad aggiornare la prenotazione.",
    invalid_booking_data:
      "I dati della prenotazione non sono validi. Inviami nome, email, telefono, servizio e data/ora.",
    unknown_booking_operation:
      "Non riesco a completare questa operazione di prenotazione. Riprova."
  },
  es: {
    bot_not_found: "No puedo encontrar el negocio para esta reserva.",
    booking_disabled: "Las reservas no estÃ¡n activas para este negocio.",
    missing_fields: "AÃºn necesito: {fields}.",
    invalid_email: "El correo no parece vÃ¡lido. Â¿Puedes revisarlo?",
    invalid_datetime:
      "La fecha u hora no tiene un formato vÃ¡lido. IntÃ©ntalo de nuevo.",
    time_in_past:
      "La hora solicitada estÃ¡ en el pasado. Elige otra hora.",
    min_lead_hours:
      "Las reservas deben hacerse con al menos {hours} horas de antelaciÃ³n.",
    max_advance_days:
      "Las reservas no pueden hacerse con mÃ¡s de {days} dÃ­as de antelaciÃ³n.",
    outside_opening_hours:
      "Ese horario estÃ¡ fuera del horario de apertura. Elige otro horario.",
    fully_booked:
      "Ese horario ya estÃ¡ completo. Por favor elige otra hora.",
    service_ambiguous:
      "Ese servicio coincide con varias opciones. {suggestions}",
    service_missing: "Â¿QuÃ© servicio deseas?",
    service_not_found:
      "No pude encontrar ese servicio. {suggestions}",
    service_change_requires_new_booking:
      "Para cambiar de servicio se requiere una nueva reserva. Cancela y reserva de nuevo con el nuevo servicio.",
    calendar_create_failed:
      "No pude crear la cita en el calendario por un error interno.",
    calendar_update_failed:
      "No pude actualizar la cita en el calendario por un error interno.",
    calendar_delete_failed:
      "No pude cancelar la cita en el calendario por un error interno.",
    booking_not_found:
      "No encontrÃ© una reserva con ese correo y fecha/hora. Revisa los datos.",
    booking_update_failed:
      "CancelÃ© el evento del calendario, pero no pude actualizar la reserva.",
    invalid_booking_data:
      "Los datos de la reserva no son vÃ¡lidos. EnvÃ­ame nombre, correo, telÃ©fono, servicio y fecha/hora.",
    unknown_booking_operation:
      "No puedo completar esta operaciÃ³n de reserva. IntÃ©ntalo de nuevo."
  },
  de: {
    bot_not_found: "Ich konnte das Unternehmen fÃ¼r diese Buchung nicht finden.",
    booking_disabled: "Buchungen sind fÃ¼r dieses Unternehmen nicht aktiviert.",
    missing_fields: "Ich brauche noch: {fields}.",
    invalid_email: "Diese E-Mail-Adresse scheint ungÃ¼ltig zu sein. Bitte prÃ¼fe sie.",
    invalid_datetime:
      "Das Datum oder die Uhrzeit ist nicht gÃ¼ltig. Bitte versuche es erneut.",
    time_in_past:
      "Die angegebene Zeit liegt in der Vergangenheit. Bitte wÃ¤hle eine andere Zeit.",
    min_lead_hours:
      "Buchungen mÃ¼ssen mindestens {hours} Stunde(n) im Voraus erfolgen.",
    max_advance_days:
      "Buchungen kÃ¶nnen nicht mehr als {days} Tage im Voraus erfolgen.",
    outside_opening_hours:
      "Diese Zeit liegt auÃŸerhalb der Ã–ffnungszeiten. Bitte wÃ¤hle eine andere Zeit.",
    fully_booked:
      "Dieses Zeitfenster ist bereits ausgebucht. Bitte wÃ¤hle eine andere Zeit.",
    service_ambiguous:
      "Dieser Service passt zu mehreren Optionen. {suggestions}",
    service_missing: "Welchen Service mÃ¶chtest du?",
    service_not_found: "Ich konnte diesen Service nicht finden. {suggestions}",
    service_change_requires_new_booking:
      "Um den Service zu Ã¤ndern, ist eine neue Buchung erforderlich. Bitte storniere und buche erneut.",
    calendar_create_failed:
      "Wir konnten den Termin aufgrund eines internen Fehlers nicht im Kalender erstellen.",
    calendar_update_failed:
      "Wir konnten den Termin aufgrund eines internen Fehlers nicht aktualisieren.",
    calendar_delete_failed:
      "Wir konnten den Termin aufgrund eines internen Fehlers nicht stornieren.",
    booking_not_found:
      "Ich konnte keine Buchung mit dieser E-Mail und diesem Datum/Uhrzeit finden. Bitte prÃ¼fe deine Angaben.",
    booking_update_failed:
      "Wir haben den Kalendereintrag storniert, konnten die Buchung aber nicht aktualisieren.",
    invalid_booking_data:
      "UngÃ¼ltige Buchungsdaten. Bitte sende mir Name, E-Mail, Telefon, Service und Datum/Uhrzeit.",
    unknown_booking_operation:
      "Unbekannter Buchungsvorgang. Bitte versuche es erneut oder kontaktiere den Support."
  },
  fr: {
    bot_not_found: "Je ne peux pas trouver l'entreprise pour cette reservation.",
    booking_disabled: "Les reservations ne sont pas actives pour cette entreprise.",
    missing_fields: "Il me manque encore : {fields}.",
    invalid_email: "Cette adresse e-mail ne semble pas valide. Peux-tu verifier ?",
    invalid_datetime:
      "La date ou l'heure n'est pas valide. Reessaie, s'il te plait.",
    time_in_past:
      "Cette heure est dans le passe. Choisis une autre heure.",
    min_lead_hours:
      "Les reservations doivent etre faites au moins {hours} heure(s) a l'avance.",
    max_advance_days:
      "Les reservations ne peuvent pas etre faites plus de {days} jours a l'avance.",
    outside_opening_hours:
      "Cet horaire est en dehors des heures d'ouverture. Choisis un autre horaire.",
    fully_booked:
      "Ce creneau est complet. Choisis un autre horaire.",
    service_ambiguous:
      "Ce service correspond a plusieurs options. {suggestions}",
    service_missing: "Quel service souhaites-tu ?",
    service_not_found: "Je n'ai pas trouve ce service. {suggestions}",
    service_change_requires_new_booking:
      "Pour changer de service, une nouvelle reservation est necessaire. Annule et reserve a nouveau.",
    calendar_create_failed:
      "Nous n'avons pas pu creer le rendez-vous dans le calendrier a cause d'une erreur interne.",
    calendar_update_failed:
      "Nous n'avons pas pu mettre a jour le rendez-vous dans le calendrier a cause d'une erreur interne.",
    calendar_delete_failed:
      "Nous n'avons pas pu annuler le rendez-vous dans le calendrier a cause d'une erreur interne.",
    booking_not_found:
      "Je n'ai pas trouve de reservation avec cet e-mail et cette date/heure. Verifie tes informations.",
    booking_update_failed:
      "Nous avons annule l'evenement du calendrier, mais nous n'avons pas pu mettre a jour la reservation.",
    invalid_booking_data:
      "Donnees de reservation invalides. Merci d'envoyer nom, e-mail, telephone, service et date/heure.",
    unknown_booking_operation:
      "Operation de reservation inconnue. Reessaie ou contacte le support."
  },
  en: {
    bot_not_found: "I couldn't find this business for the booking.",
    booking_disabled: "Booking isn't enabled for this business.",
    missing_fields: "I still need: {fields}.",
    invalid_email: "That email address doesn't look valid. Please check it.",
    invalid_datetime:
      "The date/time you provided isn't valid. Please try again.",
    time_in_past: "That time is in the past. Please choose another time.",
    min_lead_hours:
      "Bookings must be made at least {hours} hour(s) in advance.",
    max_advance_days:
      "Bookings can't be made more than {days} day(s) in advance.",
    outside_opening_hours:
      "That time is outside of the business's opening hours. Please choose another time.",
    fully_booked: "That time slot is fully booked. Please choose another time.",
    service_ambiguous: "That service matches multiple options. {suggestions}",
    service_missing: "Which service would you like?",
    service_not_found: "I couldn't match that service. {suggestions}",
    service_change_requires_new_booking:
      "Changing to a different service requires a new booking. Please cancel and book again with the new service.",
    calendar_create_failed:
      "We couldn't create the appointment in the calendar due to an internal error.",
    calendar_update_failed:
      "We couldn't update the appointment in the calendar due to an internal error.",
    calendar_delete_failed:
      "We couldn't cancel the appointment in the calendar due to an internal error.",
    booking_not_found:
      "I couldn't find an existing booking with that email and date/time. Please check your details.",
    booking_update_failed:
      "We cancelled the calendar event, but failed to update the booking record.",
    invalid_booking_data:
      "Invalid booking data. Please provide your name, email, phone, service and desired date/time.",
    unknown_booking_operation:
      "Unknown booking operation. Please try again or contact support."
  }
};

const BOOKING_FIELD_LABELS: Record<ReplyLang, Record<string, string>> = {
  it: {
    name: "nome",
    email: "email",
    phone: "telefono",
    service: "servizio",
    datetime: "data e ora"
  },
  es: {
    name: "nombre",
    email: "correo",
    phone: "telÃ©fono",
    service: "servicio",
    datetime: "fecha y hora"
  },
  de: {
    name: "name",
    email: "email",
    phone: "telefon",
    service: "service",
    datetime: "datum und uhrzeit"
  },
  fr: {
    name: "nom",
    email: "email",
    phone: "telephone",
    service: "service",
    datetime: "date et heure"
  },
  en: {
    name: "name",
    email: "email",
    phone: "phone",
    service: "service",
    datetime: "date and time"
  }
};

const WEEKDAY_LABELS: Record<ReplyLang, Record<WeekdayKey, string>> = {
  it: {
    monday: "lunedÃ¬",
    tuesday: "martedÃ¬",
    wednesday: "mercoledÃ¬",
    thursday: "giovedÃ¬",
    friday: "venerdÃ¬",
    saturday: "sabato",
    sunday: "domenica"
  },
  es: {
    monday: "lunes",
    tuesday: "martes",
    wednesday: "miÃ©rcoles",
    thursday: "jueves",
    friday: "viernes",
    saturday: "sÃ¡bado",
    sunday: "domingo"
  },
  de: {
    monday: "Montag",
    tuesday: "Dienstag",
    wednesday: "Mittwoch",
    thursday: "Donnerstag",
    friday: "Freitag",
    saturday: "Samstag",
    sunday: "Sonntag"
  },
  fr: {
    monday: "lundi",
    tuesday: "mardi",
    wednesday: "mercredi",
    thursday: "jeudi",
    friday: "vendredi",
    saturday: "samedi",
    sunday: "dimanche"
  },
  en: {
    monday: "Monday",
    tuesday: "Tuesday",
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday",
    saturday: "Saturday",
    sunday: "Sunday"
  }
};

function resolveReplyLanguage(
  shoppingState: ShoppingState | null,
  routerResult: RouterResult | null
): ReplyLang {
  const locked = shoppingState?.language;
  if (
    locked === "it" ||
    locked === "es" ||
    locked === "en" ||
    locked === "de" ||
    locked === "fr"
  ) {
    return locked;
  }
  const routed = routerResult?.language;
  if (
    routed === "it" ||
    routed === "es" ||
    routed === "en" ||
    routed === "de" ||
    routed === "fr"
  ) {
    return routed;
  }
  return "en";
}

function foldDiacritics(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extractWeekdayFromMessage(message: string): WeekdayKey | null {
  const normalized = foldDiacritics(message).toLowerCase();
  const checks: Array<[WeekdayKey, string[]]> = [
    ["monday", ["monday", "lunedi", "lunes", "montag", "lundi"]],
    ["tuesday", ["tuesday", "martedi", "martes", "dienstag", "mardi"]],
    ["wednesday", ["wednesday", "mercoledi", "miercoles", "mittwoch", "mercredi"]],
    ["thursday", ["thursday", "giovedi", "jueves", "donnerstag", "jeudi"]],
    ["friday", ["friday", "venerdi", "viernes", "freitag", "vendredi"]],
    ["saturday", ["saturday", "sabato", "sabado", "samstag", "samedi"]],
    ["sunday", ["sunday", "domenica", "domingo", "sonntag", "dimanche"]]
  ];
  for (const [key, tokens] of checks) {
    for (const token of tokens) {
      const re = new RegExp(`\\b${token}\\b`, "i");
      if (re.test(normalized)) return key;
    }
  }
  return null;
}

function formatDateTimeLabel(params: {
  iso: string;
  timeZone: string;
  lang: ReplyLang;
}): string {
  const { iso, timeZone, lang } = params;
  const dt = DateTime.fromISO(iso, { zone: timeZone });
  if (!dt.isValid) return iso;
  const locale =
    lang === "it"
      ? "it"
      : lang === "es"
        ? "es"
        : lang === "de"
          ? "de"
          : lang === "fr"
            ? "fr"
            : "en";
  const localized = dt.setLocale(locale);
  const weekday = localized.toFormat("cccc");
  const date =
    lang === "es"
      ? localized.toFormat("d 'de' LLLL 'de' yyyy")
      : lang === "fr"
        ? localized.toFormat("d LLLL yyyy")
        : lang === "de"
          ? localized.toFormat("d. LLLL yyyy")
      : lang === "en"
      ? localized.toFormat("LLLL d, yyyy")
      : localized.toFormat("d LLLL yyyy");
  const time = localized.toFormat("HH:mm");
  return lang === "it"
    ? `${weekday} ${date} alle ${time}`
    : lang === "es"
    ? `${weekday} ${date} a las ${time}`
    : lang === "de"
    ? `${weekday}, ${date} um ${time}`
    : lang === "fr"
    ? `${weekday} ${date} a ${time}`
    : `${weekday}, ${date} at ${time}`;
}

function getWeekdayKeyForDate(dt: DateTime): WeekdayKey {
  const keys: WeekdayKey[] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday"
  ];
  return keys[dt.weekday - 1];
}

function buildWeekdayMismatchReply(params: {
  lang: ReplyLang;
  requested: WeekdayKey;
  actualIso: string;
  timeZone: string;
}): string {
  const { lang, requested, actualIso, timeZone } = params;
  const requestedLabel = WEEKDAY_LABELS[lang][requested];
  const actualLabel = formatDateTimeLabel({ iso: actualIso, timeZone, lang });
  if (lang === "it") {
    return `Hai indicato ${requestedLabel}, ma la data corrisponde a ${actualLabel}. Puoi confermare la data corretta?`;
  }
  if (lang === "es") {
    return `Has indicado ${requestedLabel}, pero la fecha corresponde a ${actualLabel}. Â¿Puedes confirmar la fecha correcta?`;
  }
  if (lang === "de") {
    return `Du hast ${requestedLabel} angegeben, aber das Datum entspricht ${actualLabel}. Kannst du das richtige Datum bestaetigen?`;
  }
  if (lang === "fr") {
    return `Tu as indique ${requestedLabel}, mais la date correspond a ${actualLabel}. Peux-tu confirmer la date correcte ?`;
  }
  return `You asked for ${requestedLabel}, but the date corresponds to ${actualLabel}. Please confirm the correct date.`;
}

function localizeBookingError(
  result: BookingResult,
  lang: ReplyLang
): string | null {
  if (!result.errorCode) return result.errorMessage || null;
  const templates = BOOKING_I18N[lang] || BOOKING_I18N.en;
  let base = templates[result.errorCode] || result.errorMessage || null;
  if (!base) return null;

  if (result.errorCode === "missing_fields") {
    const missing = Array.isArray(result.errorMeta?.missing)
      ? (result.errorMeta?.missing as string[])
      : [];
    const labels = missing.length
      ? missing.map((f) => BOOKING_FIELD_LABELS[lang][f] || f)
      : [];
    const fieldsText =
      labels.length > 0 ? labels.join(", ") : BOOKING_FIELD_LABELS[lang].datetime;
    return base.replace("{fields}", fieldsText);
  }

  if (result.errorCode === "min_lead_hours") {
    const hours = result.errorMeta?.minLeadHours ?? "";
    return base.replace("{hours}", String(hours));
  }

  if (result.errorCode === "max_advance_days") {
    const days = result.errorMeta?.maxAdvanceDays ?? "";
    return base.replace("{days}", String(days));
  }

  if (
    result.errorCode === "service_ambiguous" ||
    result.errorCode === "service_not_found"
  ) {
    const suggestions: string[] =
      (result.errorMeta?.suggestions as string[]) ||
      result.suggestedServices ||
      [];
    const suffix =
      suggestions.length > 0
        ? lang === "it"
          ? `Opzioni: ${suggestions.join(", ")}.`
          : lang === "es"
          ? `Opciones: ${suggestions.join(", ")}.`
          : lang === "de"
          ? `Optionen: ${suggestions.join(", ")}.`
          : lang === "fr"
          ? `Options: ${suggestions.join(", ")}.`
          : `Options: ${suggestions.join(", ")}.`
        : "";
    return base.replace("{suggestions}", suffix).trim();
  }

  return base;
}

function mapRouterIntentToRevenueIntent(router: RouterResult | null) {
  if (!router) return null;
  const shoppingIntents = new Set([
    "BROWSE",
    "QUALIFY",
    "SELECT",
    "DETAILS",
    "COMPARE",
    "HESITATE",
    "FEEDBACK"
  ]);
  if (shoppingIntents.has(router.intent)) {
    return {
      intent: "SHOPPING" as const,
      confidence: Math.max(0.6, router.confidence || 0.6),
      signals: ["router_intent"]
    };
  }
  if (router.intent === "SUPPORT") {
    return { intent: "SUPPORT" as const, confidence: 0.7, signals: ["router_intent"] };
  }
  return { intent: "OTHER" as const, confidence: 0, signals: ["router_intent"] };
}

function formatShopCatalogContext(context: {
  summary: string;
  categories?: string[];
  useCases?: string[];
  audiences?: string[];
  notableAttributes?: string[];
  pricePositioning?: string;
}) {
  const lines: string[] = [];
  if (context.summary) lines.push(`Summary: ${context.summary}`);
  if (context.categories?.length) {
    lines.push(`Categories: ${context.categories.slice(0, 8).join(", ")}`);
  }
  if (context.useCases?.length) {
    lines.push(`Use cases: ${context.useCases.slice(0, 8).join(", ")}`);
  }
  if (context.audiences?.length) {
    lines.push(`Audiences: ${context.audiences.slice(0, 6).join(", ")}`);
  }
  if (context.notableAttributes?.length) {
    lines.push(
      `Notable attributes: ${context.notableAttributes.slice(0, 6).join(", ")}`
    );
  }
  if (context.pricePositioning) {
    lines.push(`Price positioning: ${context.pricePositioning}`);
  }
  return lines.join("\n");
}

function formatSuggestedSlot(params: {
  iso: string;
  timeZone: string;
  lang: "it" | "es" | "en" | "de" | "fr";
}): { iso: string; weekday: string; date: string; time: string; label: string } | null {
  const { iso, timeZone, lang } = params;
  const dt = DateTime.fromISO(iso, { zone: timeZone });
  if (!dt.isValid) return null;

  const locale =
    lang === "it"
      ? "it"
      : lang === "es"
        ? "es"
        : lang === "de"
          ? "de"
          : lang === "fr"
            ? "fr"
            : "en";
  const localized = dt.setLocale(locale);

  const weekday = localized.toFormat("cccc");
  const date =
    lang === "es"
      ? localized.toFormat("d 'de' LLLL 'de' yyyy")
      : lang === "fr"
        ? localized.toFormat("d LLLL yyyy")
        : lang === "de"
          ? localized.toFormat("d. LLLL yyyy")
      : lang === "en"
        ? localized.toFormat("LLLL d, yyyy")
        : localized.toFormat("d LLLL yyyy");
  const time = localized.toFormat("HH:mm");

  const label =
    lang === "it"
      ? `${weekday} ${date} alle ${time}`
      : lang === "es"
        ? `${weekday} ${date} a las ${time}`
        : lang === "de"
          ? `${weekday}, ${date} um ${time}`
          : lang === "fr"
            ? `${weekday} ${date} a ${time}`
        : `${weekday}, ${date} at ${time}`;

  return { iso, weekday, date, time, label };
}

function buildShopifySummary(params: {
  lang: "it" | "es" | "en" | "de" | "fr";
  items: Array<{ title?: string | null; priceMin?: any }>;
}): string {
  const { lang, items } = params;
  const intro =
    lang === "it"
      ? "Ecco 3 opzioni:"
      : lang === "es"
        ? "Aqui tienes 3 opciones:"
        : lang === "de"
          ? "Hier sind 3 Optionen:"
          : lang === "fr"
            ? "Voici 3 options:"
        : "Here are 3 options:";
  const ask =
    lang === "it"
      ? "Quale ti interessa?"
      : lang === "es"
        ? "Cual te interesa?"
        : lang === "de"
          ? "Welche interessiert dich?"
          : lang === "fr"
            ? "Laquelle t'interesse ?"
        : "Which one interests you?";
  const lines = items.slice(0, 3).map((item, idx) => {
    const title =
      item.title ||
      (lang === "it"
        ? "Prodotto"
        : lang === "es"
          ? "Producto"
          : lang === "de"
            ? "Produkt"
            : lang === "fr"
              ? "Produit"
              : "Product");
    const price =
      item.priceMin != null
        ? typeof item.priceMin === "string"
          ? item.priceMin
          : item.priceMin.toString()
        : "";
    const priceLabel =
      price && lang === "it"
        ? `â‚¬${price}`
        : price && lang === "es"
          ? `â‚¬${price}`
          : price && lang === "de"
            ? `â‚¬${price}`
            : price && lang === "fr"
              ? `â‚¬${price}`
          : price
            ? `$${price}`
            : "";
    const suffix = priceLabel ? ` â€” ${priceLabel}` : "";
    return `${idx + 1}. ${title}${suffix}`;
  });
  return [intro, ...lines, ask].join("\n");
}

function shouldEnableBookingForTurn(message: string, shopifyEnabled: boolean): boolean {
  if (!shopifyEnabled) return true;
  const lower = message.trim().toLowerCase();
  if (!lower) return true;

  const bookingSignals = [
    "prenot",
    "appunt",
    "appointment",
    "book",
    "booking",
    "reserve",
    "reservation",
    "buch",
    "buchung",
    "termin",
    "reservierung",
    "rendez",
    "rdv",
    "schedule",
    "calendario",
    "slot",
    "disponibilit",
    "verfueg",
    "verfug",
    "dispo"
  ];

  const shopifySignals = [
    "prodotto",
    "product",
    "produkt",
    "produit",
    "prezzo",
    "price",
    "preis",
    "prix",
    "costo",
    "cost",
    "kosten",
    "carrello",
    "cart",
    "warenkorb",
    "panier",
    "checkout",
    "acquista",
    "buy",
    "kaufen",
    "acheter",
    "ordine",
    "ordina",
    "bestellung",
    "commande",
    "taglia",
    "groesse",
    "taille",
    "colore",
    "farbe",
    "couleur",
    "variant",
    "varianti",
    "variante",
    "spedizione",
    "shipping",
    "versand",
    "livraison",
    "sconto",
    "discount",
    "rabatt",
    "remise",
    "catalogo",
    "catalog",
    "catalogue",
    "avete"
  ];

  const hasBookingSignal = bookingSignals.some((s) => lower.includes(s));
  if (hasBookingSignal) return true;

  const hasShopifySignal = shopifySignals.some((s) => lower.includes(s));
  const hasPriceSignal = /[\d,.]+\s?(\$|eur|usd|euro)\b/i.test(lower);

  if (hasShopifySignal || hasPriceSignal) {
    return false;
  }

  return true;
}

const BOOKING_FLOW_SIGNAL_REGEX =
  /\b(prenot|appunt|appointment|book|booking|reserve|reservation|buch|buchung|termin|reservier|rendez|rdv|schedule|calendario|slot|disponibilit|dispo)\b/i;

function isBookingFlowActiveForTurn(params: {
  message: string;
  historyMessages: ChatMessage[];
  bookingEnabled: boolean;
  shopifyEnabled: boolean;
}): boolean {
  const { message, historyMessages, bookingEnabled, shopifyEnabled } = params;
  if (!bookingEnabled) return false;

  const lastAssistant = getLastAssistantContent(historyMessages);
  if (assistantAskedForPersonalField(lastAssistant)) {
    return true;
  }

  if (!shopifyEnabled) {
    if (BOOKING_FLOW_SIGNAL_REGEX.test(foldContextText(message))) {
      return true;
    }
  } else if (shouldEnableBookingForTurn(message, shopifyEnabled)) {
    return true;
  }

  const recentWindow = historyMessages
    .slice(-6)
    .map((msg) => (typeof msg.content === "string" ? msg.content : ""))
    .join(" ");
  return BOOKING_FLOW_SIGNAL_REGEX.test(foldContextText(recentWindow));
}

/**
 * Decide whether we really need to hit the knowledge backend for this turn.
 */
export function shouldUseKnowledgeForTurn(
  message: string,
  historyMessages: ChatMessage[],
  options?: { bookingFlowActive?: boolean }
): boolean {
  const normalized = message.trim().toLowerCase();
  const normalizedReply = normalizeShortReplyToken(message);
  const lastAssistantContent = getLastAssistantContent(historyMessages);
  const lastAssistantAskedQuestion =
    assistantMessageEndsWithQuestion(lastAssistantContent);
  const lastAssistantAskedPersonalField =
    assistantAskedForPersonalField(lastAssistantContent);
  const bookingFlowActive = options?.bookingFlowActive === true;

  // Always use knowledge for the first turn (no history yet)
  if (historyMessages.length === 0) return true;

  // Very short acknowledgements / small talk
  if (GENERIC_SHORT_REPLIES.has(normalizedReply)) {
    if (
      lastAssistantAskedQuestion &&
      isAffirmativeFollowUpSignal(normalizedReply)
    ) {
      if (bookingFlowActive || lastAssistantAskedPersonalField) {
        return false;
      }
      return true;
    }
    return false;
  }

  // Formatting / style only
  if (
    normalized.includes("shorter") ||
    normalized.includes("more concise") ||
    normalized.includes("summarize") ||
    normalized.includes("summary") ||
    normalized.includes("rephrase") ||
    normalized.includes("bullet points")
  ) {
    return false;
  }

  // Booking-like answers
  const isShort = normalized.length > 0 && normalized.length <= 80;
  const hasQuestionMark = normalized.includes("?");

  if (isShort && !hasQuestionMark) {
    const looksLikeEmail =
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(message.trim());

    const looksLikePhone =
      /[\d][\d\s().\-]{5,}/.test(message);

    const looksLikeDateWord =
      /\b(today|tomorrow|tonight|this\s+(morning|afternoon|evening)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        message
      );

    const looksLikeTime =
      /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(message) ||
      /\b(1[0-2]|0?[1-9])\s?(am|pm)\b/i.test(message);

    const folded = foldContextText(message);
    const words = normalized.split(/\s+/).filter(Boolean);
    const originalWords = message.trim().split(/\s+/).filter(Boolean);
    const hasDirectiveVerb =
      /\b(show|list|give|tell|provide|dimmi|dammi|elenca|mostra|indica|dime|quiero|muestrame|liste|zeige|gib|montre|donne)\b/i.test(
        normalized
      );
    const hasKnowledgeQueryToken =
      /\b(price|prices|pricing|prezzo|prezzi|costo|costi|cost|costs|acquisto|noleggio|buy|rent|vendita|finanzi|financing|details|dettagli|info|informazioni|contatti|contact|modelli|versioni)\b/i.test(
        folded
      );
    const hasConnectorWord =
      /\b(di|de|del|della|dello|da|per|for|con|su|a|al|la|le|lo|el|los|las|the|of)\b/i.test(
        folded
      );
    const hasCapitalizedToken = originalWords.some((word) =>
      /^[A-ZÀ-Ý]/.test(word)
    );
    const isNameLikeTokenSet = originalWords.every((word) =>
      /^[A-Za-zÀ-ÖØ-öø-ÿ.'-]+$/.test(word)
    );
    const looksLikeName =
      words.length > 0 &&
      words.length <= 3 &&
      isNameLikeTokenSet &&
      (hasCapitalizedToken || lastAssistantAskedPersonalField) &&
      !hasDirectiveVerb &&
      !hasKnowledgeQueryToken &&
      !hasConnectorWord &&
      !looksLikeEmail &&
      !looksLikeDateWord &&
      !looksLikeTime;

    const looksLikeBookingProgressToken =
      /\b(ok|okay|va bene|confermo|confermata|si|sì|yes|non fumatori|fumatori|no preference|no preferenze|nessuna preferenza)\b/i.test(
        folded
      );

    if (
      looksLikeEmail ||
      looksLikePhone ||
      looksLikeDateWord ||
      looksLikeTime ||
      (bookingFlowActive &&
        looksLikeBookingProgressToken &&
        !hasDirectiveVerb &&
        !hasKnowledgeQueryToken) ||
      (bookingFlowActive && looksLikeName)
    ) {
      return false;
    }
  }

  // Default: use knowledge
  return true;
}

function resolveAssistantMaxTokens(params: {
  message: string;
  useKnowledge: boolean;
  knowledgeIntent?: string | null;
  knowledgePolicyMode?: string | null;
  knowledgeResponseStrategy?: string | null;
}): number {
  const {
    message,
    useKnowledge,
    knowledgeIntent = null,
    knowledgePolicyMode = null,
    knowledgeResponseStrategy = null
  } = params;

  const normalized = ` ${foldContextText(message)} `;
  const hasListSignal =
    /\b(list|lista|elenco|catalog|catalogo|catalogue|enumerate|enumera|elenca|mostra|show|full|complete|completo|completa|intero|intera|tutti|tutte|all|every|todo|todos|todas|gesamt|vollstaendig|complet)\b/i.test(
      normalized
    );
  const hasPriceSignal =
    /\b(price|prices|pricing|prezzo|prezzi|costo|costi|tariff|cost|kosten|preis|preise|prix)\b/i.test(
      normalized
    ) || /[\d,.]+\s?(\$|eur|usd|euro)\b/i.test(message);
  const hasCompletenessSignal =
    /\b(all|every|tutti|tutte|todo|todos|todas|complete|completo|completa|full|entire|intero|intera|gesamt|vollstaendig|complet)\b/i.test(
      normalized
    );

  let maxTokens = 200;

  if (useKnowledge) {
    if (knowledgePolicyMode === "overview") maxTokens = Math.max(maxTokens, 260);
    if (knowledgeIntent === "specific") maxTokens = Math.max(maxTokens, 220);

    if (
      knowledgeResponseStrategy === "clarify" ||
      knowledgeResponseStrategy === "insufficient_info"
    ) {
      maxTokens = Math.min(maxTokens, 180);
    }
  }

  if (hasListSignal) maxTokens = Math.max(maxTokens, 320);
  if (hasListSignal && hasCompletenessSignal) maxTokens = Math.max(maxTokens, 380);
  if (hasListSignal && hasPriceSignal) maxTokens = Math.max(maxTokens, 440);
  if (hasPriceSignal && hasCompletenessSignal) maxTokens = Math.max(maxTokens, 380);

  return Math.min(520, Math.max(160, maxTokens));
}

function hasAnyBookingDraftData(draft: BookingDraft | null | undefined): boolean {
  if (!draft) return false;
  if (draft.name || draft.email || draft.phone || draft.service || draft.datetime)
    return true;
  if (draft.customFields) {
    for (const val of Object.values(draft.customFields)) {
      if (val && val.trim().length > 0) return true;
    }
  }
  return false;
}

function hasAllRequiredBookingFields(
  draft: BookingDraft | null | undefined,
  bookingCfg: BotBookingConfig
): boolean {
  if (!draft) return false;

  const draftAny: any = draft;

  for (const field of bookingCfg.requiredFields) {
    let value: unknown;

    // First look for a core field on the draft object
    if (field in draftAny) {
      value = draftAny[field];
    }

    // If not found, look inside customFields
    if (value == null && draft.customFields) {
      value = (draft.customFields as any)[field];
    }

    if (value == null) {
      return false;
    }

    if (typeof value === "string" && value.trim().length === 0) {
      return false;
    }
  }

  return true;
}

function formatBookingDraftSystemMessage(draft: BookingDraft): string {
  const lines: string[] = [];

  if (draft.name) lines.push(`- name: ${draft.name}`);
  if (draft.email) lines.push(`- email: ${draft.email}`);
  if (draft.phone) lines.push(`- phone: ${draft.phone}`);
  if (draft.service) lines.push(`- service: ${draft.service}`);
  if (draft.datetime) lines.push(`- datetime: ${draft.datetime}`);

  if (draft.customFields) {
    for (const [key, value] of Object.entries(draft.customFields)) {
      if (typeof value === "string" && value.trim().length > 0) {
        lines.push(`- ${key}: ${value}`);
      }
    }
  }

  if (lines.length === 0) {
    return "";
  }

  return (
    "Booking details collected so far for this conversation (may be incomplete):\n" +
    lines.join("\n") +
    "\n\nUse these values as defaults when completing or updating bookings unless the user explicitly changes them."
  );
}







/**
 * Generate a reply for a given bot slug and user message.
 */
export async function generateBotReplyForSlug(
  slug: string,
  rawMessage: string,
  options: GenerateReplyOptions = {}
): Promise<{
  reply: string;
  suggestion?: RevenueAISuggestion | null;
  clerk?: ClerkPayload;
}> {
  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) {
    throw new ChatServiceError(`Bot not found for slug '${slug}'`, 404);
  }
  const knowledgeSource = botConfig.knowledgeSource ?? "RAG";
  if (knowledgeSource === "RAG" && !botConfig.knowledgeClientId) {
    throw new ChatServiceError(
      "This bot has no knowledge base configured yet. Ask the owner to set up content & crawl the site.",
      400
    );
  }

  // Token quota gate
  if (botConfig.botId) {
    const quota = await ensureBotHasTokens(botConfig.botId, 0);
    if (!quota.ok) {
      throw new ChatServiceError(
        "This assistant has reached its monthly usage limit. Please try again next month or contact the account owner.",
        429
      );
    }
  }

  const message = (rawMessage || "").trim();
  if (!message) {
    throw new ChatServiceError("Message cannot be empty", 400);
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ChatServiceError(
      `Message is too long (max ${MAX_MESSAGE_LENGTH} chars)`,
      400
    );
  }

  const followUpStateKey = buildPendingFollowUpStateKey({
    botId: botConfig.botId ?? null,
    conversationId: options.conversationId ?? null,
    sessionId: options.sessionId ?? null
  });
  let conversationLanguageLock = loadConversationLanguageLock(followUpStateKey);
  // Language policy: never switch mid-conversation.
  // Set lock only when missing; once set, keep it fixed for the whole conversation/session.
  if (!conversationLanguageLock) {
    const detectedLockLanguage = await detectKnowledgeLanguageForLock({
      message,
      botId: botConfig.botId ?? null,
      minConfidence: 0.85
    });
    if (detectedLockLanguage) {
      conversationLanguageLock = detectedLockLanguage;
      saveConversationLanguageLock(followUpStateKey, conversationLanguageLock);
    }
  }
  const normalizedIncomingShortReply = normalizeShortReplyToken(message);
  const isShortAffirmativeReply = isAffirmativeFollowUpSignal(
    normalizedIncomingShortReply
  );
  if (followUpStateKey && !isShortAffirmativeReply) {
    clearPendingFollowUpState(followUpStateKey);
  }
  const pendingFollowUpState = loadPendingFollowUpState(followUpStateKey);

  const unsupportedAction = detectUnsupportedExternalAction(message);
  if (unsupportedAction) {
    const lang =
      conversationLanguageLock ??
      (await detectKnowledgeLanguageHint({
        message,
        lockedLanguage: null,
        routedLanguage: null,
        botId: botConfig.botId ?? null,
        allowLLM: false
      })) ?? detectQuickMessageLanguage(message);
    return {
      reply: buildUnsupportedActionReply(unsupportedAction, lang),
      suggestion: null,
      clerk: undefined
    };
  }

  const usageBase = {
    userId: botConfig.ownerUserId ?? null,
    botId: botConfig.botId ?? null
  };
  const executedToolNamesThisTurn = new Set<string>();

    const intentResult = classifyIntent(message);

  const shopifyShop =
    botConfig.botId ? await getShopForBotId(botConfig.botId) : null;
  const shopifyEnabled = knowledgeSource === "SHOPIFY" && !!shopifyShop;
  if (knowledgeSource === "SHOPIFY" && !shopifyEnabled) {
    throw new ChatServiceError(
      "This bot is configured to use Shopify knowledge, but no Shopify store is connected yet.",
      400
    );
  }

  let shoppingState: ShoppingState | null = null;
  let routerResult: RouterResult | null = null;
  if (shopifyEnabled && botConfig.botId) {
    shoppingState = await loadShoppingState({
      botId: botConfig.botId,
      conversationId: options.conversationId ?? null,
      sessionId: options.sessionId ?? null
    });

    try {
      routerResult = await routeConversation({
        botId: botConfig.botId,
        message,
        state: shoppingState,
        shopifyEnabled
      });
      console.log("[shopify_router] result", {
        botId: botConfig.botId,
        route: routerResult.route,
        intent: routerResult.intent,
        language: routerResult.language,
        confidence: routerResult.confidence,
        should_fetch_catalog: routerResult.should_fetch_catalog,
        switch_product_type: routerResult.switch_product_type
      });
      shoppingState = applyRouterToState(shoppingState, routerResult);
      if (routerResult.language && routerResult.language !== "unknown") {
        const updatedLang = updateStateLanguage(
          shoppingState,
          routerResult.language
        );
        if (updatedLang.language !== shoppingState.language) {
          shoppingState = updatedLang;
          console.log("[shopify_state] language_lock", {
            botId: botConfig.botId,
            language: shoppingState.language
          });
        }
      }
      if (routerResult.route === "SUPPORT" || routerResult.route === "ORDER_STATUS") {
        const prevMode = shoppingState.mode;
        shoppingState = { ...shoppingState, mode: "SUPPORT" };
        if (prevMode !== shoppingState.mode) {
          console.log("[shopify_state] mode_transition", {
            botId: botConfig.botId,
            from: prevMode,
            to: shoppingState.mode
          });
        }
      }
      await saveShoppingState(shoppingState);
    } catch (err) {
      console.warn("[shopify_router] failed, falling back", {
        botId: botConfig.botId,
        error: (err as Error)?.message || err
      });
      const fallbackRoute: RouterResult = shoppingState.shortlist.length > 0
        ? {
            route: "CONVERSE",
            language: shoppingState.language ?? "unknown",
            intent: "HESITATE",
            confidence: 0,
            should_fetch_catalog: false,
            switch_product_type: false,
            selection: { ordinal: null, productId: null },
            notes: "fallback_router_error"
          }
        : {
            route: "CLERK",
            language: shoppingState.language ?? "unknown",
            intent: "BROWSE",
            confidence: 0,
            should_fetch_catalog: true,
            switch_product_type: false,
            selection: { ordinal: null, productId: null },
            notes: "fallback_router_error"
          };
      routerResult = fallbackRoute;
      shoppingState = applyRouterToState(shoppingState, routerResult);
      await saveShoppingState(shoppingState);
    }
  }

  // --- Load recent conversation history ---
  let historyMessages: ChatMessage[] = [];
  if (options.conversationId) {
    const fullHistory = await getConversationHistoryAsChatMessages(
      options.conversationId
    );

    if (fullHistory.length > 0) {
      const maxMessages = HISTORY_TURNS_TO_KEEP * 2; // user+assistant per turn
      historyMessages =
        fullHistory.length > maxMessages
          ? fullHistory.slice(-maxMessages)
          : fullHistory;
    }

    if (ENABLE_CONVERSATION_MEMORY_SUMMARY) {
      await maybeUpdateConversationMemorySummary(slug, options.conversationId);
    }
  }

  // Booking config for chat (normalized)
  const bookingSystemType = botConfig.bookingSystemType ?? "GENERIC";
  const restaurantBookingMode = bookingSystemType === "RESTAURANT";
  const botBookingCfg = restaurantBookingMode
    ? null
    : normalizeBookingConfigForChat(botConfig.booking);
  let restaurantChatToolCfg: RestaurantChatToolConfig | null = null;
  if (restaurantBookingMode && botConfig.botId) {
    const restaurantContext = await getRestaurantChatContext(botConfig.botId);
    if (restaurantContext.enabled) {
      restaurantChatToolCfg = {
        timeZone: restaurantContext.timeZone,
        askSmokingPreference: restaurantContext.shouldAskSmokingPreference
      };
    }
  }

  const bookingEnabled = restaurantBookingMode
    ? !!restaurantChatToolCfg
    : !!botBookingCfg;
  const bookingFlowActiveForKnowledge = isBookingFlowActiveForTurn({
    message,
    historyMessages,
    bookingEnabled,
    shopifyEnabled
  });
  const shortAffirmativeFollowUp = resolveShortAffirmativeFollowUpContext({
    message,
    historyMessages,
    bookingFlowActive: bookingFlowActiveForKnowledge,
    pendingState: pendingFollowUpState
  });
  if (shortAffirmativeFollowUp?.source === "state") {
    clearPendingFollowUpState(followUpStateKey);
  }
  const knowledgeInputMessage = shortAffirmativeFollowUp
    ? shortAffirmativeFollowUp.hasSpecificTopic
      ? shortAffirmativeFollowUp.resolvedKnowledgeQuery
      : message
    : message;

  const useKnowledge =
    knowledgeSource === "RAG" &&
    shouldUseKnowledgeForTurn(message, historyMessages, {
      bookingFlowActive: bookingFlowActiveForKnowledge
    });
  const memorySummary =
    ENABLE_CONVERSATION_MEMORY_SUMMARY &&
    options.conversationId != null &&
    !useKnowledge
      ? await getConversationMemorySummary(options.conversationId)
      : null;

  const tokenDebug =
    String(process.env.TOKEN_DEBUG || "").toLowerCase() === "true";
  const countChars = (text?: string | null) => (text ? text.length : 0);
  const summarizeMessages = (msgs: ChatMessage[]) => {
    let total = 0;
    for (const m of msgs) {
      total += countChars(m.content as any);
      if ((m as any).tool_calls) {
        total += JSON.stringify((m as any).tool_calls).length;
      }
    }
    return { count: msgs.length, totalChars: total };
  };

  // 1) Build the RAG or no-RAG system message
  let contextSystemMessage: ChatMessage;
  let knowledgeEarlyReply: string | null = null;
  let knowledgeIntentForBudget: string | null = null;
  let knowledgePolicyModeForBudget: string | null = null;
  let knowledgeResponseStrategyForBudget: string | null = null;
  let knowledgeEvidenceText = "";
  let knowledgeLowConfidence = false;

  if (useKnowledge) {
    if (!botConfig.knowledgeClientId) {
      throw new Error(
        "Knowledge client ID is required when knowledge source is RAG."
      );
    }

    const intentResult = await classifyKnowledgeIntent({
      message: knowledgeInputMessage,
      usageContext: usageBase
    });
    knowledgeIntentForBudget = intentResult.intent;

    const contactDetection = await detectContactQuerySmart({
      message: knowledgeInputMessage,
      botId: botConfig.botId ?? null
    });

    const profile = resolveKnowledgeRetrievalProfile(
      botConfig.knowledgeRetrievalProfile
    );
    const retrievalParams = getKnowledgeRetrievalParams(profile);
    const forceDebug =
      String(process.env.KNOWLEDGE_FORCE_DEBUG || "").toLowerCase() === "true";
    const logDebug =
      String(process.env.KNOWLEDGE_DEBUG || "").toLowerCase() === "true";
    const effectiveRetrievalParams = forceDebug
      ? { ...retrievalParams, returnDebug: true }
      : retrievalParams;

    const weakLanguageSignalInput = isWeakLanguageSignalMessage(message);
    const historyLanguageForKnowledge = await detectHistoryLanguageHint({
      historyMessages,
      botId: botConfig.botId ?? null,
      preferUserMessages: true
    });
    const languageLockForKnowledge =
      (isSupportedLanguage(shoppingState?.language ?? null)
        ? shoppingState?.language
        : null) ??
      conversationLanguageLock ??
      historyLanguageForKnowledge;
    const knowledgeLanguage = await detectKnowledgeLanguage({
      message: knowledgeInputMessage,
      lockedLanguage: languageLockForKnowledge ?? null,
      routedLanguage: routerResult?.language ?? null,
      botId: botConfig.botId ?? null,
      allowLLM: !(weakLanguageSignalInput && languageLockForKnowledge != null),
      defaultLanguage:
        languageLockForKnowledge ??
        historyLanguageForKnowledge ??
        "en"
    });
    const contactReplyLanguage: SupportedLanguage =
      isWeakLanguageSignalMessage(message)
        ? historyLanguageForKnowledge ?? knowledgeLanguage
        : knowledgeLanguage;
    const ftsLanguage = knowledgeLanguage;

    if (logDebug) {
      console.log("[KnowledgeSearch] profile", {
        botId: botConfig.botId ?? null,
        profile,
        params: effectiveRetrievalParams
      });
    }

    if (logDebug && intentResult.intent === "overview") {
      const helperQueries = getOverviewCoverageQueries(knowledgeLanguage);
      console.log("[KnowledgeSearch] overview_mode_start", {
        botId: botConfig.botId ?? null,
        language: knowledgeLanguage,
        helperQueriesCount: helperQueries.length
      });
    }

    const shouldClarifyContactIntent =
      contactDetection.ambiguous === true && !contactDetection.isContactQuery;
    const shouldRouteToContactRetrieval =
      !bookingFlowActiveForKnowledge &&
      contactDetection.isContactQuery &&
      !shouldClarifyContactIntent;

    const retrievalRun = shouldRouteToContactRetrieval
      ? {
          source: "contact_retrieval" as const,
          response: await searchKnowledgeContacts({
            clientId: botConfig.knowledgeClientId,
            domain: botConfig.domain,
            ftsLanguage,
            retrievalParams: effectiveRetrievalParams,
            rawQuery: knowledgeInputMessage,
            includeRawQuery: true,
            preferPartnerSources: contactDetection.requestedFields.partner
          })
        }
      : await runKnowledgeRetrieval({
          intent: intentResult.intent,
          message: knowledgeInputMessage,
          clientId: botConfig.knowledgeClientId,
          domain: botConfig.domain,
          ftsLanguage,
          retrievalParams: effectiveRetrievalParams
        });

    const retrievalResponse = retrievalRun.response;

    if (logDebug) {
      const overviewDebug = (retrievalResponse as any)?.debug;
      if (overviewDebug?.mode === "overview") {
        console.log("[KnowledgeSearch] overview_mode_result", {
          ...overviewDebug,
          retrievalStatus: retrievalResponse.retrievalStatus,
          noAnswerRecommended: retrievalResponse.noAnswerRecommended,
          confidence: retrievalResponse.confidence
        });
      }
      const contactDebug = (retrievalResponse as any)?.debug;
      if (contactDebug?.mode === "contact") {
        console.log("[KnowledgeSearch] contact_mode_result", {
          ...contactDebug,
          retrievalStatus: retrievalResponse.retrievalStatus,
          noAnswerRecommended: retrievalResponse.noAnswerRecommended,
          confidence: retrievalResponse.confidence
        });
      }
      console.log("[KnowledgePolicy] input_source", {
        source: retrievalRun.source
      });
      if (shouldRouteToContactRetrieval || shouldClarifyContactIntent) {
        console.log("[KnowledgeContact] detection", {
          signals: contactDetection.contactSignals,
          source: contactDetection.source ?? "unknown",
          confidence: contactDetection.confidence ?? null,
          ambiguous: contactDetection.ambiguous ?? false,
          llmUnavailable: contactDetection.llmUnavailable ?? false
        });
      }
    }

    const results = retrievalResponse.results || [];
    knowledgeEvidenceText = results
      .slice(0, 6)
      .map((r) => String(r.text || ""))
      .join("\n");
    const retrievalMeta = {
      retrievalStatus: retrievalResponse.retrievalStatus,
      noAnswerRecommended: retrievalResponse.noAnswerRecommended,
      confidence: retrievalResponse.confidence
    };

    const policy = decideKnowledgePolicy({
      intent: intentResult.intent,
      retrieval: retrievalMeta,
      resultsCount: results.length
    });
    knowledgeLowConfidence = policy.lowConfidence;
    knowledgePolicyModeForBudget = policy.mode;
    knowledgeResponseStrategyForBudget = policy.responseStrategy;

    if (logDebug) {
      console.log("[KnowledgeIntent] result", {
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        reason: intentResult.reason,
        fallback: intentResult.isFallback ?? false
      });
      console.log("[KnowledgePolicy] decision", {
        mode: policy.mode,
        responseStrategy: policy.responseStrategy,
        shouldCallAnswerLLM: policy.shouldCallAnswerLLM,
        reasonCodes: policy.reasonCodes,
        lowConfidence: policy.lowConfidence,
        noAnswerRecommended: policy.noAnswerRecommended,
        retrievalStatus: retrievalMeta.retrievalStatus,
        confidence: retrievalMeta.confidence
      });
    }

    if (
      policy.mode === "overview" &&
      policy.responseStrategy === "insufficient_info" &&
      results.length === 0
    ) {
      knowledgeEarlyReply = getKnowledgeOverviewNoResultsMessage(knowledgeLanguage);
    }

    if (
      !knowledgeEarlyReply &&
      contactDetection.ambiguous === true &&
      !contactDetection.isContactQuery
    ) {
      knowledgeEarlyReply = resolveContactFallback(
        contactReplyLanguage,
        "intentClarify"
      );
    }

    if (shouldRouteToContactRetrieval) {
      const preferPartner = contactDetection.requestedFields.partner;
      const selection = selectContactExtractionPool({
        results,
        preferPartnerSources: preferPartner
      });

      const sources = selection.pool.map((r) => ({
        id: r.id,
        text: r.text || "",
        url: r.url,
        trusted: selection.trustedIds.has(r.id)
      }));
      const sourceById = new Map(
        sources.map((source) => [String(source.id || ""), source])
      );

      const extracted = extractContacts({ sources });

      const perSource = extractContactsBySource(
        sources.map((s) => ({
          ...s,
          trusted: s.trusted
        }))
      ).map((entry) => ({
        ...entry,
        sourceText: sourceById.get(String(entry.resultId || ""))?.text ?? "",
        classification: classifyContactSource({
          url: entry.url,
          text: sourceById.get(String(entry.resultId || ""))?.text ?? "",
          preferPartnerSources: preferPartner
        })
      }));

      if (logDebug) {
        console.log("[KnowledgeContact] extraction", {
          emailsFound: extracted.emails.length,
          phonesFound: extracted.phones.length,
          urlsFound: extracted.contactUrls.length,
          bucketCounts: {
            main: selection.buckets.main.length,
            partner: selection.buckets.partner.length,
            unknown: selection.buckets.unknown.length
          },
          excludedPartners: !preferPartner && selection.buckets.main.length > 0,
          unknownSourcesTrustedCount: selection.trustedUnknownCount,
          unknownSourcesRejectedCount: selection.rejectedUnknownCount
        });
      }

      const hasVerifiedDetails =
        extracted.emails.length > 0 || extracted.phones.length > 0;
      const hasVerifiedUrl = extracted.contactUrls.length > 0;
      const localizedContactLabel = (field: "email" | "phone" | "contactPage"): string => {
        if (field === "email") {
          if (contactReplyLanguage === "es") return "Correo";
          if (contactReplyLanguage === "de") return "E-Mail";
          if (contactReplyLanguage === "fr") return "Email";
          return "Email";
        }
        if (field === "phone") {
          if (contactReplyLanguage === "it") return "Telefono";
          if (contactReplyLanguage === "es") return "Telefono";
          if (contactReplyLanguage === "de") return "Telefon";
          if (contactReplyLanguage === "fr") return "Telephone";
          return "Phone";
        }
        if (contactReplyLanguage === "it") return "Pagina contatti";
        if (contactReplyLanguage === "es") return "Pagina de contacto";
        if (contactReplyLanguage === "de") return "Kontaktseite";
        if (contactReplyLanguage === "fr") return "Page contact";
        return "Contact page";
      };

      if (!preferPartner) {
        const genericSelection = selectBestGenericContactSource(perSource);
        if (genericSelection.conflict) {
          knowledgeEarlyReply = resolveContactFallback(
            contactReplyLanguage,
            "conflictClarify"
          );
        } else if (!genericSelection.selected) {
          knowledgeEarlyReply = resolveContactFallback(
            contactReplyLanguage,
            "noVerified"
          );
        } else if (
          genericSelection.selected.emails.length === 0 &&
          genericSelection.selected.phones.length === 0 &&
          genericSelection.selected.contactLikeUrl
        ) {
          knowledgeEarlyReply = resolveContactFallback(
            contactReplyLanguage,
            "contactPageOnly",
            { url: genericSelection.selected.url ?? undefined }
          );
        } else if (
          genericSelection.selected.emails.length === 0 &&
          genericSelection.selected.phones.length === 0
        ) {
          knowledgeEarlyReply = resolveContactFallback(
            contactReplyLanguage,
            "noVerified"
          );
        } else {
          const lines: string[] = [];
          if (genericSelection.selected.emails.length > 0) {
            lines.push(
              `${localizedContactLabel("email")}: ${genericSelection.selected.emails.join(", ")}`
            );
          }
          if (genericSelection.selected.phones.length > 0) {
            lines.push(
              `${localizedContactLabel("phone")}: ${genericSelection.selected.phones.join(", ")}`
            );
          }
          if (genericSelection.selected.contactLikeUrl && genericSelection.selected.url) {
            lines.push(
              `${localizedContactLabel("contactPage")}: ${genericSelection.selected.url}`
            );
          }
          knowledgeEarlyReply = lines.join("\n");
        }
        if (knowledgeEarlyReply) {
          if (logDebug) {
            console.log("[KnowledgeContact] response_mode", {
              mode: genericSelection.conflict ? "clarify" : "answer",
              selectedContactSourceId: genericSelection.selected?.resultId ?? null,
              selectedContactUrl: genericSelection.selected?.url ?? null,
              candidateSourceCount: perSource.length,
              conflictDetected: genericSelection.conflict
            });
          }
        }
        if (knowledgeEarlyReply) {
          // Skip generic fallback flow below.
        } else if (!hasVerifiedDetails && !hasVerifiedUrl) {
          knowledgeEarlyReply = resolveContactFallback(
            contactReplyLanguage,
            "noVerified"
          );
        }
      } else if (!hasVerifiedDetails && !hasVerifiedUrl) {
        knowledgeEarlyReply = resolveContactFallback(
          contactReplyLanguage,
          contactDetection.requestedFields.partner ? "partnerClarify" : "noVerified"
        );
      } else if (!hasVerifiedDetails && hasVerifiedUrl) {
        knowledgeEarlyReply = resolveContactFallback(contactReplyLanguage, "contactPageOnly", {
          url: extracted.contactUrls[0]
        });
      } else {
        const lines: string[] = [];
        if (extracted.emails.length > 0) {
          lines.push(`${localizedContactLabel("email")}: ${extracted.emails.join(", ")}`);
        }
        if (extracted.phones.length > 0) {
          lines.push(`${localizedContactLabel("phone")}: ${extracted.phones.join(", ")}`);
        }
        if (extracted.contactUrls.length > 0) {
          lines.push(
            `${localizedContactLabel("contactPage")}: ${extracted.contactUrls[0]}`
          );
        }

        knowledgeEarlyReply = lines.join("\n");
      }
    }

    const contextChunks = results.map((r, index) => {
      const safeUrl = r.url || botConfig.domain;
      const rawText = (r.text || "").trim();
      return `Chunk ${index + 1} (from ${safeUrl}):\n${rawText}`;
    });

    const contextText =
      contextChunks.length > 0
        ? contextChunks.join("\n\n")
        : "No relevant context was found for this query in the website content.";

    
    let systemPrompt: string;
    if (policy.mode === "overview") {
      systemPrompt = buildKnowledgeOverviewPrompt({
        contextText,
        hasResults: results.length > 0,
        lowConfidence: policy.lowConfidence
      });
    } else if (policy.mode === "ambiguous") {
      systemPrompt = buildKnowledgeAmbiguousPrompt({
        contextText,
        hasResults: results.length > 0
      });
    } else {
      const specificStrategy =
        policy.responseStrategy === "overview_summary"
          ? undefined
          : policy.responseStrategy;
      systemPrompt = buildKnowledgeSpecificPrompt({
        contextText,
        noAnswerRecommended: policy.noAnswerRecommended,
        retrievalStatus: retrievalMeta.retrievalStatus,
        confidenceLevel: retrievalMeta.confidence?.level,
        responseStrategy: specificStrategy
      });
    }

    contextSystemMessage = {
      role: "system",
      content: systemPrompt
    };
  } else {
    // No external context for this turn â€“ rely only on the conversation so far
    contextSystemMessage = {
      role: "system",
      content:
        "No external website or document CONTEXT is provided for this turn.\n" +
        "Answer based only on this conversation.\n" +
        "\n" +
        "Guidelines:\n" +
        "- Understand what the user wants; if their request is vague, ask 1â€“2 focused follow-up questions.\n" +
        "- Keep answers concise and easy to scan.\n" +
        "- Do NOT invent new factual details about the business (services, prices, policies, locations, team skills) that were not mentioned earlier in the conversation.\n" +
        "- If the user asks for business facts you cannot infer, say you don't know and suggest checking the website or contacting the business.\n" +
        "- Do NOT claim you can perform real-world actions (send emails, place calls, complete payments, or execute external workflows) unless such an action result is explicitly available in this conversation.\n" +
        "- Do NOT offer to send documents/files by email (or perform call/payment actions) unless that capability is explicitly confirmed by a tool result in this conversation.\n" +
        "- You may refer back to information already mentioned, but avoid repeating long lists in full.\n" +
        "- Reply in the user's language when reasonable.\n"
    };
  }

  // 2) Base messages for OpenAI
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: botConfig.systemPrompt
    }
  ];

  if (tokenDebug) {
    console.log("[TokenDebug] systemPrompt", {
      botId: botConfig.botId,
      chars: countChars(botConfig.systemPrompt)
    });
  }

  if (memorySummary) {
    messages.push({
      role: "system",
      content:
        "Long-term memory for this user. Use it as soft background only.\n" +
        "- Never use this memory as factual source for business details (prices, specs, durations, policies, contacts).\n" +
        "- For business facts, rely on current retrieved context for this turn.\n" +
        "- If memory conflicts with current messages or retrieved context, trust current turn evidence.\n" +
        memorySummary
    });
    if (tokenDebug) {
      console.log("[TokenDebug] memorySummary", {
        botId: botConfig.botId,
        chars: countChars(memorySummary)
      });
    }
  }

  messages.push(contextSystemMessage);
  if (tokenDebug) {
    console.log("[TokenDebug] contextSystemMessage", {
      botId: botConfig.botId,
      chars: countChars(contextSystemMessage.content as any),
      source: useKnowledge ? "RAG" : "NO_RAG"
    });
  }

  const preKnownLanguageForTurn =
    (isSupportedLanguage(shoppingState?.language ?? null)
      ? shoppingState?.language
      : null) ??
    conversationLanguageLock ??
    null;
  const detectedReplyLanguage =
    !shopifyEnabled && knowledgeSource === "RAG"
      ? await detectKnowledgeLanguageHint({
          message,
          lockedLanguage: preKnownLanguageForTurn,
          routedLanguage: routerResult?.language ?? null,
          botId: botConfig.botId ?? null,
          allowLLM:
            preKnownLanguageForTurn == null && !isWeakLanguageSignalMessage(message)
        })
      : null;
  const historyDetectedLanguage = await detectHistoryLanguageHint({
    historyMessages,
    botId: botConfig.botId ?? null,
    preferUserMessages: true
  });
  const quickDetectedLanguage = detectQuickMessageLanguageHint(message);
  const effectiveDetectedLanguage = isWeakLanguageSignalMessage(message)
    ? conversationLanguageLock ??
      historyDetectedLanguage ??
      detectedReplyLanguage
    : detectedReplyLanguage ??
      quickDetectedLanguage ??
      conversationLanguageLock ??
      historyDetectedLanguage;
  const lockedLanguage = shoppingState?.language ?? null;
  const enforcedLanguage =
    (isSupportedLanguage(lockedLanguage) ? lockedLanguage : null) ??
    conversationLanguageLock ??
    effectiveDetectedLanguage;
  const strictLanguageHint = strictLanguageInstruction(enforcedLanguage);
  if (strictLanguageHint) {
    const languageLockPrefix = "Language lock for this conversation.";
    const combinedLanguageHint = `${languageLockPrefix}\n${strictLanguageHint}`;
    messages.push({
      role: "system",
      content: combinedLanguageHint
    });
    if (tokenDebug) {
      console.log("[TokenDebug] strictLanguageHint", {
        botId: botConfig.botId,
        chars: countChars(combinedLanguageHint),
        language: enforcedLanguage
      });
    }
  }

  const historyForIntent = historyMessages.map((msg) => ({
    role: msg.role,
    content: typeof (msg as any).content === "string" ? ((msg as any).content as string) : null
  }));

  const shouldAskClarifier =
    (!shortAffirmativeFollowUp || !shortAffirmativeFollowUp.hasSpecificTopic) &&
    shouldAskClarifyingQuestion({
      message,
      history: historyForIntent
    });
  
  if (shouldAskClarifier) {
    messages.push({
      role: "system",
      content:
        "The user sounds indecisive. Ask exactly ONE clarifying question (budget, usage, preferences) before recommending anything. Do not suggest products in this turn."
    });
    if (tokenDebug) {
      console.log("[TokenDebug] clarifierInstruction", {
        botId: botConfig.botId,
        chars: countChars(
          "The user sounds indecisive. Ask exactly ONE clarifying question (budget, usage, preferences) before recommending anything. Do not suggest products in this turn."
        )
      });
    }
  }

  const bookingEnabledForTurn =
    bookingEnabled && shouldEnableBookingForTurn(message, shopifyEnabled);

  const policyTargetLanguage = resolvePolicyTargetLanguage({
    lockedLanguage:
      shoppingState?.language ??
      conversationLanguageLock ??
      null,
    routedLanguage: routerResult?.language ?? null,
    followUpLanguage: conversationLanguageLock,
    detectedLanguage: effectiveDetectedLanguage,
    historyLanguage: historyDetectedLanguage,
    quickLanguage: detectQuickMessageLanguageHint(` ${message} `)
  });

  const applyGenericReplyPolicy = async (
    reply: string,
    options?: { skipKnowledgeGroundingChecks?: boolean }
  ): Promise<string> => {
    const trimmed = String(reply || "").trim();
    if (!trimmed) return reply;
    const skipKnowledgeGroundingChecks =
      options?.skipKnowledgeGroundingChecks === true;
    const knowledgeGroundingEnabled =
      useKnowledge && !skipKnowledgeGroundingChecks;
    const followUpGroundingEnabled =
      !!shortAffirmativeFollowUp?.hasSpecificTopic &&
      !skipKnowledgeGroundingChecks;
    const fallbackLanguage =
      policyTargetLanguage ??
      conversationLanguageLock ??
      detectQuickMessageLanguage(message);
    const strictFollowUpLanguage =
      !!shortAffirmativeFollowUp &&
      String(message || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length <= 3;

    const proposal = detectUnsupportedActionProposalInReply(trimmed);
    if (proposal) {
      const rewritten = await rewriteReplyWithinCapabilities({
        reply: trimmed,
        targetLanguage: fallbackLanguage,
        usageContext: usageBase
      });
      if (rewritten && !detectUnsupportedActionProposalInReply(rewritten)) {
        return rewritten;
      }
      return buildUnsupportedProposalFallback(fallbackLanguage);
    }

    let safeReply = trimmed;
    if (policyTargetLanguage) {
      const inferReplyLanguage = async (
        value: string
      ): Promise<"it" | "en" | "es" | "de" | "fr" | null> => {
        const fastHint = await detectKnowledgeLanguageHint({
          message: value,
          lockedLanguage: null,
          routedLanguage: null,
          botId: botConfig.botId ?? null,
          allowLLM: false
        });
        if (fastHint) return fastHint;
        if (value.length >= 80) {
          const quickHint = detectQuickMessageLanguageHint(value);
          if (quickHint) return quickHint;
          return await detectKnowledgeLanguageHint({
            message: value,
            lockedLanguage: null,
            routedLanguage: null,
            botId: botConfig.botId ?? null,
            allowLLM: true
          });
        }
        return null;
      };

      const beforeLang = await inferReplyLanguage(safeReply);
      const shouldRewrite =
        (beforeLang && beforeLang !== policyTargetLanguage) ||
        (strictFollowUpLanguage && beforeLang !== policyTargetLanguage);
      if (shouldRewrite) {
        const rewritten = await rewriteReplyToLanguage({
          reply: safeReply,
          targetLanguage: policyTargetLanguage,
          usageContext: usageBase
        });
        if (!rewritten) {
          if (strictFollowUpLanguage) {
            return buildLanguageConsistencyFallback(policyTargetLanguage);
          }
        } else {
          safeReply = rewritten;
          const afterLang = await inferReplyLanguage(safeReply);
          if ((!afterLang || afterLang !== policyTargetLanguage) && strictFollowUpLanguage) {
            return buildLanguageConsistencyFallback(policyTargetLanguage);
          }
        }
      }
    }

    if (
      followUpGroundingEnabled &&
      (
        looksLikeShortAffirmativeDeflection(safeReply) ||
        !isConcreteFollowUpResolution(safeReply, shortAffirmativeFollowUp!)
      )
    ) {
      const repaired = await repairShortAffirmativeFollowUpReply({
        reply: safeReply,
        context: shortAffirmativeFollowUp!,
        evidenceText: knowledgeEvidenceText,
        targetLanguage: fallbackLanguage,
        usageContext: usageBase
      });
      if (repaired) {
        safeReply = repaired;
      }
    }

    if (
      followUpGroundingEnabled &&
      !isConcreteFollowUpResolution(safeReply, shortAffirmativeFollowUp!)
    ) {
      const groundedFollowUp = await rewriteReplyUsingEvidenceOnly({
        reply: safeReply,
        userMessage: shortAffirmativeFollowUp!.resolvedKnowledgeQuery,
        evidenceText: knowledgeEvidenceText,
        targetLanguage: fallbackLanguage,
        usageContext: usageBase
      });
      if (groundedFollowUp) {
        safeReply = groundedFollowUp;
      }
      if (!isConcreteFollowUpResolution(safeReply, shortAffirmativeFollowUp!)) {
        return buildInsufficientEvidenceClaimReply(fallbackLanguage);
      }
    }

    if (
      followUpGroundingEnabled &&
      hasUnsupportedActionRefusal(safeReply)
    ) {
      const repairedRefusal = await rewriteReplyUsingEvidenceOnly({
        reply: safeReply,
        userMessage: shortAffirmativeFollowUp!.resolvedKnowledgeQuery,
        evidenceText: knowledgeEvidenceText,
        targetLanguage: fallbackLanguage,
        usageContext: usageBase
      });
      if (repairedRefusal && !hasUnsupportedActionRefusal(repairedRefusal)) {
        safeReply = repairedRefusal;
      }
    }

    if (followUpGroundingEnabled) {
      safeReply = alignReplyUrlWithEvidence({
        reply: safeReply,
        resolvedQuery: shortAffirmativeFollowUp!.resolvedKnowledgeQuery,
        evidenceText: knowledgeEvidenceText,
        lang: fallbackLanguage
      });
    }

    if (knowledgeGroundingEnabled && queryLooksLikeDirectLinkRequest(message)) {
      safeReply = alignReplyUrlWithEvidence({
        reply: safeReply,
        resolvedQuery: message,
        evidenceText: knowledgeEvidenceText,
        lang: fallbackLanguage
      });
    }

    if (hasExplicitExternalCapabilityAction(safeReply)) {
      const rewritten = await rewriteReplyWithinCapabilities({
        reply: safeReply,
        targetLanguage: fallbackLanguage,
        usageContext: usageBase
      });
      if (rewritten) {
        safeReply = rewritten;
      }
    }

    const proposalAfterRewrite = detectUnsupportedActionProposalInReply(safeReply);
    if (proposalAfterRewrite) {
      const rewritten = await rewriteReplyWithinCapabilities({
        reply: safeReply,
        targetLanguage: fallbackLanguage,
        usageContext: usageBase
      });
      if (rewritten && !detectUnsupportedActionProposalInReply(rewritten)) {
        safeReply = rewritten;
      } else {
        return buildUnsupportedProposalFallback(fallbackLanguage);
      }
    }

    const unsupportedCapability = await isUnsupportedCapabilityProposal({
      userMessage: message,
      reply: safeReply,
      evidenceText: knowledgeEvidenceText,
      supportedActionHints: Array.from(executedToolNamesThisTurn.values()),
      usageContext: usageBase
    });
    if (unsupportedCapability) {
      return buildCapabilityScopeFallback(fallbackLanguage);
    }

    if (knowledgeGroundingEnabled) {
      const sanitized = stripUnsupportedFollowUpQuestions({
        reply: safeReply,
        evidenceText: knowledgeEvidenceText,
        useKnowledge: knowledgeGroundingEnabled,
        userMessage: shortAffirmativeFollowUp?.resolvedKnowledgeQuery ?? message
      });
      safeReply = sanitized.reply;
    }

    if (
      knowledgeGroundingEnabled &&
      knowledgeLowConfidence &&
      looksLikeOutOfScopeExternalGuidance(safeReply) &&
      !hasEvidenceForExternalGuidance(safeReply, knowledgeEvidenceText)
    ) {
      const rewritten = await rewriteReplyUsingEvidenceOnly({
        reply: safeReply,
        userMessage: message,
        evidenceText: knowledgeEvidenceText,
        targetLanguage: fallbackLanguage,
        usageContext: usageBase
      });
      if (rewritten) {
        safeReply = rewritten;
      }
      if (
        looksLikeOutOfScopeExternalGuidance(safeReply) &&
        !hasEvidenceForExternalGuidance(safeReply, knowledgeEvidenceText)
      ) {
        return buildInsufficientEvidenceClaimReply(fallbackLanguage);
      }
    }

    if (
      knowledgeGroundingEnabled &&
      isFactualClaimRiskyReply(message, safeReply)
    ) {
      const numericClaimsSupported = hasEvidenceForNumericClaims(
        safeReply,
        knowledgeEvidenceText
      );
      const claimEvidenceSupported = hasEvidenceForClaim(
        message,
        knowledgeEvidenceText
      );
      const binaryDefinitiveReply =
        isBinaryClaimQuestion(message) &&
        isDefinitiveClaimReply(safeReply);
      let unsupportedFactualClaim =
        !numericClaimsSupported ||
        (binaryDefinitiveReply && !claimEvidenceSupported);

      if (
        !unsupportedFactualClaim &&
        shouldRunFactualGroundingGuard({
          message,
          reply: safeReply,
          evidenceText: knowledgeEvidenceText
        })
      ) {
        unsupportedFactualClaim = await isUnsupportedFactualClaim({
          userMessage: message,
          reply: safeReply,
          evidenceText: knowledgeEvidenceText,
          usageContext: usageBase
        });
      }

      if (unsupportedFactualClaim) {
        const rewritten = await rewriteReplyUsingEvidenceOnly({
          reply: safeReply,
          userMessage: message,
          evidenceText: knowledgeEvidenceText,
          targetLanguage: fallbackLanguage,
          usageContext: usageBase
        });
        if (!rewritten) {
          return buildInsufficientEvidenceClaimReply(fallbackLanguage);
        }
        safeReply = rewritten;
        if (!hasEvidenceForNumericClaims(safeReply, knowledgeEvidenceText)) {
          return buildInsufficientEvidenceClaimReply(fallbackLanguage);
        }
      }
    }

    if (
      knowledgeGroundingEnabled &&
      isBinaryClaimQuestion(message) &&
      isDefinitiveClaimReply(safeReply) &&
      !hasEvidenceForClaim(message, knowledgeEvidenceText)
    ) {
      return buildInsufficientEvidenceClaimReply(fallbackLanguage);
    }

    if (policyTargetLanguage) {
      const finalQuickLang = detectQuickMessageLanguageHint(safeReply);
      if (finalQuickLang && finalQuickLang !== policyTargetLanguage) {
        const rewritten = await rewriteReplyToLanguage({
          reply: safeReply,
          targetLanguage: policyTargetLanguage,
          usageContext: usageBase
        });
        if (rewritten) {
          safeReply = rewritten;
        } else if (strictFollowUpLanguage) {
          return buildLanguageConsistencyFallback(policyTargetLanguage);
        }
      }
    }
    if (followUpGroundingEnabled) {
      const aligned = hasMinimumTopicAlignment({
        reply: safeReply,
        query: shortAffirmativeFollowUp!.resolvedKnowledgeQuery,
        minMatches: 1
      });
      if (!aligned) {
        const rewritten = await rewriteReplyUsingEvidenceOnly({
          reply: safeReply,
          userMessage: shortAffirmativeFollowUp!.resolvedKnowledgeQuery,
          evidenceText: knowledgeEvidenceText,
          targetLanguage: fallbackLanguage,
          usageContext: usageBase
        });
        if (rewritten) {
          safeReply = rewritten;
        }
      }
    }
    return safeReply;
  };

  const persistPendingFollowUpFromReply = (finalReply: string): void => {
    if (!followUpStateKey) return;
    if (bookingFlowActiveForKnowledge) {
      clearPendingFollowUpState(followUpStateKey);
      return;
    }

    const candidate = buildPendingFollowUpStateFromAssistantReply({
      reply: finalReply,
      baseUserQuery: knowledgeInputMessage
    });
    if (!candidate) {
      clearPendingFollowUpState(followUpStateKey);
      return;
    }
    savePendingFollowUpState(followUpStateKey, candidate);
  };

  const finalizeReply = async (
    reply: string,
    extra?: {
      hasShopifyActionsInReply?: boolean;
      skipKnowledgeGroundingChecks?: boolean;
    }
  ): Promise<{ reply: string; suggestion?: RevenueAISuggestion | null; clerk?: ClerkPayload }> => {
    const safeReply = await applyGenericReplyPolicy(reply, {
      skipKnowledgeGroundingChecks: extra?.skipKnowledgeGroundingChecks
    });

    if (!botConfig.botId || !shopifyEnabled || !botConfig.revenueAIEnabled) {
      persistPendingFollowUpFromReply(safeReply);
      return { reply: safeReply, suggestion: null };
    }

    const intentOverride = mapRouterIntentToRevenueIntent(routerResult);
    const indecisionSignal =
      routerResult?.intent === "HESITATE" ||
      routerResult?.intent === "COMPARE" ||
      routerResult?.intent === "FEEDBACK";

    const offer = await safeMaybeBuildRevenueAIOffer({
      botConfig,
      conversationId: options.conversationId,
      sessionId: options.sessionId,
      userMessage: message,
      assistantReply: safeReply,
      channel: options.channel,
      hasShopifyActionsInReply: extra?.hasShopifyActionsInReply,
      intentResult: intentOverride ?? intentResult,
      forceBlockOffer: shouldAskClarifier,
      indecisionSignal
    });

    if (!offer) {
      persistPendingFollowUpFromReply(safeReply);
      return { reply: safeReply, suggestion: null };
    }

    // Allow RevenueAI to suggest items outside the current shortlist.

    const suggestionTitle = offer.suggestion.product.title || "this option";
    const lang = (shoppingState?.language ?? routerResult?.language ?? "en") as
      | "en"
      | "it"
      | "es"
      | "de"
      | "fr"
      | "unknown";
    const webAppend =
      lang === "it"
        ? `Se vuoi, posso consigliarti anche: ${suggestionTitle}.`
        : lang === "es"
          ? `Si quieres, tambiÃ©n puedo recomendar: ${suggestionTitle}.`
          : lang === "de"
            ? `Wenn du moechtest, kann ich auch Folgendes empfehlen: ${suggestionTitle}.`
            : lang === "fr"
              ? `Si tu veux, je peux aussi recommander : ${suggestionTitle}.`
          : `If you'd like, I can also recommend: ${suggestionTitle}.`;

    const appendText =
      offer.appendText && offer.appendText.trim().length > 0
        ? offer.appendText
        : webAppend;

    let appended = appendText
      ? `${safeReply}\n\n${appendText}`
      : safeReply;

    const channel = options.channel;
    const isNonWebChannel = channel && channel !== "WEB";
    if (isNonWebChannel) {
      const productUrl = offer.suggestion.product.productUrl || "";
      const addToCartUrl = offer.suggestion.product.addToCartUrl || "";
      const hasProductUrl = productUrl && appended.includes(productUrl);
      const hasAddUrl = addToCartUrl && appended.includes(addToCartUrl);
      const actionLines: string[] = [];
      if (productUrl && !hasProductUrl) {
        const label =
          lang === "it"
            ? "Vedi prodotto"
            : lang === "es"
              ? "Ver producto"
              : lang === "de"
                ? "Produkt ansehen"
                : lang === "fr"
                  ? "Voir le produit"
              : "View product";
        actionLines.push(`[${label}](${productUrl})`);
      }
      if (addToCartUrl && !hasAddUrl) {
        const label =
          lang === "it"
            ? "Aggiungi al carrello"
            : lang === "es"
              ? "Agregar al carrito"
              : lang === "de"
                ? "In den Warenkorb"
                : lang === "fr"
                  ? "Ajouter au panier"
              : "Add to cart";
        actionLines.push(`[${label}](${addToCartUrl})`);
      }
      if (actionLines.length > 0) {
        appended = `${appended}\n\n${actionLines.join("\n")}`;
      }
    }

    persistPendingFollowUpFromReply(appended);
    return { reply: appended, suggestion: offer.suggestion };
  };
  const bookingReplyPolicyBypass = {
    skipKnowledgeGroundingChecks: true
  } as const;

  if (knowledgeEarlyReply) {
    return await finalizeReply(knowledgeEarlyReply);
  }

  if (shopifyEnabled && botConfig.botId && shopifyShop?.shopDomain && shoppingState && routerResult) {
    const clerkDecision = evaluateClerkEligibility(routerResult, shoppingState);
    console.log("[shopify_router] clerk_eligible", {
      botId: botConfig.botId,
      route: routerResult.route,
      intent: routerResult.intent,
      should_fetch_catalog: routerResult.should_fetch_catalog,
      useClerk: clerkDecision.useClerk,
      reason: clerkDecision.reason
    });

    if (!clerkDecision.useClerk) {
      const shouldConverse =
        routerResult.route === "CONVERSE" ||
        (!routerResult.should_fetch_catalog &&
          routerResult.route !== "TOOLS" &&
          routerResult.route !== "SUPPORT" &&
          routerResult.route !== "ORDER_STATUS");
      if (shouldConverse) {
        const shopContext =
          shopifyShop?.shopDomain && botConfig.botId
            ? await getShopCatalogContext({
                botId: botConfig.botId,
                shopDomain: shopifyShop.shopDomain
              })
            : null;
        const selectedContext =
          shopContext && botConfig.botId
            ? await selectShopCatalogContextForMessage({
                botId: botConfig.botId,
                context: shopContext,
                message
              })
            : null;

        const reply = await generateConversationalSellerReply({
          botId: botConfig.botId,
          message,
          state: shoppingState,
          router: routerResult,
          catalogSummary: selectedContext
            ? {
                summary: selectedContext.summary,
                categories: selectedContext.categories
              }
            : null
        });

        console.log("[shopify_converse] reply_context", {
          botId: botConfig.botId,
          intent: routerResult.intent,
          route: routerResult.route,
          shortlistIds: shoppingState.shortlist.map((item) => item.productId),
          shortlistTitles: shoppingState.shortlist.map((item) => item.title),
          hasCatalogSummary: Boolean(selectedContext)
        });

        await saveShoppingState(shoppingState);
        const finalized = await finalizeReply(reply);
        return finalized;
      }
    } else {
      try {
        const prevActiveProductType = shoppingState.activeProductType;
        const clerkResult = await handleClerkFlow({
          botId: botConfig.botId,
          shopDomain: shopifyShop.shopDomain,
          message,
          sessionId: options.sessionId || null,
          conversationId: options.conversationId || null
        });
        if (clerkResult && clerkResult.handled) {
          const prevMode = shoppingState.mode;
          shoppingState = updateStateFromClerkPayload(
            shoppingState,
            clerkResult.payload
          );
          shoppingState = await syncStateWithClerkState({
            state: shoppingState,
            botId: botConfig.botId,
            conversationId: options.conversationId ?? null,
            sessionId: options.sessionId ?? null
          });
          const nextActiveProductType = shoppingState.activeProductType;
          const activeTypeChanged =
            normalizeText(prevActiveProductType) !==
            normalizeText(nextActiveProductType);
          if (activeTypeChanged && shoppingState.shortlist.length > 0) {
            shoppingState = {
              ...shoppingState,
              shortlist: [],
              shortlistHash: null,
              lastShortlistAt: null,
              detailsProductId: null,
              lastDetailsAt: null,
              loopCount: 0,
              mode: "DISCOVERY"
            };
            console.log("[shopify_state] reset_for_product_type_switch", {
              botId: botConfig.botId,
              from: prevActiveProductType,
              to: nextActiveProductType
            });
          }
          if (prevMode !== shoppingState.mode) {
            console.log("[shopify_state] mode_transition", {
              botId: botConfig.botId,
              from: prevMode,
              to: shoppingState.mode
            });
          }
          await saveShoppingState(shoppingState);
          const finalized = await finalizeReply(clerkResult.reply, {
            hasShopifyActionsInReply: Boolean(clerkResult.payload)
          });
          return {
            ...finalized,
            clerk: clerkResult.payload
          };
        }
      } catch (err) {
        console.warn("[clerk] flow failed, falling back", {
          botId: botConfig.botId,
          error: (err as Error)?.message || err
        });
      }
    }
  }

  // 3b) Inject booking draft snapshot, if any
  let bookingDraft: BookingDraft | null = null;
  if (bookingEnabledForTurn && !!botBookingCfg && options.conversationId) {
    bookingDraft = await loadBookingDraft(options.conversationId);
    if (botBookingCfg) {
      const lastAssistantMessage = getLastAssistantContent(historyMessages);
      const captureDebug =
        String(process.env.BOOKING_CAPTURE_DEBUG || "").toLowerCase() === "true";

      const detectedUpdates = detectBookingFieldUpdates({
        message,
        bookingCfg: botBookingCfg,
        existingDraft: bookingDraft,
        context: {
          bookingFlowActive: bookingFlowActiveForKnowledge,
          assistantAskedForName: assistantAskedForName(lastAssistantMessage)
        },
        debug: captureDebug,
        debugContext: {
          slug,
          conversationId: options.conversationId
        }
      });

      if (Object.keys(detectedUpdates).length > 0) {
        await updateBookingDraft(
          options.conversationId,
          detectedUpdates,
          botBookingCfg.customFields
        );

        bookingDraft = await loadBookingDraft(options.conversationId);
      }
    }
    if (hasAnyBookingDraftData(bookingDraft)) {
      const snapshotText = formatBookingDraftSystemMessage(bookingDraft!);
      if (snapshotText) {
        messages.push({
          role: "system",
          content: snapshotText
        });
      }
    }
  }

  const tools: ChatTool[] = [];
  let bookingTool: ChatTool | null = null;

  if (bookingEnabledForTurn && botBookingCfg) {
    bookingTool = buildBookingTool(botBookingCfg);
    tools.push(bookingTool);
    tools.push(buildUpdateBookingTool(botBookingCfg));
    tools.push(buildCancelBookingTool());

    // Only expose the draft tool when we have a conversationId to attach it to
    if (options.conversationId) {
      tools.push(buildBookingDraftTool(botBookingCfg));
    }

    messages.push({
      role: "system",
      content:
        getBookingInstructions(botBookingCfg) +
        "\n\n" +
        "You can also reschedule or cancel existing bookings using the tools `update_appointment` and `cancel_appointment`. Ask the user for their email and the original booking date/time to identify the booking. Call these tools only when the user clearly wants a change or cancellation and you have enough information."
    });
  } else if (bookingEnabledForTurn && restaurantChatToolCfg) {
    tools.push(buildRestaurantCreateReservationTool(restaurantChatToolCfg));
    tools.push(buildRestaurantCancelReservationTool());
    messages.push({
      role: "system",
      content: getRestaurantBookingInstructions(
        restaurantChatToolCfg,
        new Date().toISOString()
      )
    });
  }

  if (shopifyEnabled) {
    tools.push(buildShopifySearchTool());
    tools.push(buildShopifyProductDetailsTool());
    tools.push(buildShopifyAddToCartTool());
    tools.push(buildShopifyCheckoutLinkTool());
    tools.push(buildShopifyOrderStatusTool());

    const policyKeywordHit =
      /refund|return|exchange|cancel|cancell|privacy|policy|policies|shipping|delivery|spedizione|reso|rimborso|cambio|privacy/i.test(
        message
      );
    const shouldIncludePolicies =
      policyKeywordHit ||
      intentResult.intent === "SUPPORT" ||
      intentResult.intent === "SHIPPING_INFO";

    if (shouldIncludePolicies) {
      const policies = botConfig.botId
        ? await getPoliciesForBot(botConfig.botId)
        : null;
      if (policies && policies.length > 0) {
        const policyLines = policies.map((policy) => {
          const typeLabel = policy.type
            ? policy.type.replace(/_/g, " ").toLowerCase()
            : "policy";
          const title = policy.title ? policy.title.trim() : typeLabel;
          const body = policy.body ? stripHtml(policy.body) : "";
          const url = policy.url ? policy.url.trim() : "";
          const parts = [];
          if (title) parts.push(title);
          if (body) parts.push(body);
          if (url) parts.push("URL: " + url);
          return parts.join(" - ");
        });

        messages.push({
          role: "system",
          content:
            "Shopify policies (shop-specific). Use when the user asks about refunds/returns/shipping/privacy or store policies:\n" +
            policyLines.join("\n")
        });
        if (tokenDebug) {
          console.log("[TokenDebug] shopifyPolicies", {
            botId: botConfig.botId,
            policyCount: policies.length,
            chars: countChars(policyLines.join("\n")),
            reason: policyKeywordHit ? "keyword" : intentResult.intent
          });
        }
      }
    } else if (tokenDebug) {
      console.log("[TokenDebug] shopifyPolicies", {
        botId: botConfig.botId,
        policyCount: 0,
        chars: 0,
        reason: "skipped_not_needed"
      });
    }

    const shopContext =
      botConfig.botId && shopifyShop?.shopDomain
        ? await getShopCatalogContext({
            botId: botConfig.botId,
            shopDomain: shopifyShop.shopDomain
          })
        : null;
    const selectedContext =
      shopContext && botConfig.botId
        ? await selectShopCatalogContextForMessage({
            botId: botConfig.botId,
            context: shopContext,
            message
          })
        : null;
    if (selectedContext) {
      const contextText = formatShopCatalogContext(selectedContext);
      if (contextText.trim()) {
        messages.push({
          role: "system",
          content:
            "Shop catalog context (derived from the shop's catalog data). Use this to understand what the shop sells, typical use cases, and audiences. Do not contradict it:\n" +
            contextText
        });
        if (tokenDebug) {
          console.log("[TokenDebug] shopifyCatalogContext", {
            botId: botConfig.botId,
            chars: countChars(contextText)
          });
        }
      }
    } else if (tokenDebug) {
      console.log("[TokenDebug] shopifyCatalogContext", {
        botId: botConfig.botId,
        chars: 0,
        reason: "missing"
      });
    }


    messages.push({
      role: "system",
      content: getShopifyInstructions()
    });
    if (tokenDebug) {
      console.log("[TokenDebug] shopifyInstructions", {
        botId: botConfig.botId,
        chars: countChars(getShopifyInstructions())
      });
    }
  }

  // 4) Attach recent history
  if (historyMessages.length > 0) {
    messages.push({
      role: "system",
      content:
        "Recent conversation history with this user (use it to understand context, references, and follow-ups):"
    });
    messages.push(...historyMessages);
    if (tokenDebug) {
      const summary = summarizeMessages(historyMessages as any);
      console.log("[TokenDebug] history", {
        botId: botConfig.botId,
        count: summary.count,
        totalChars: summary.totalChars
      });
    }
  }

  if (shortAffirmativeFollowUp) {
    const followUpHint = buildShortAffirmativeFollowUpSystemHint(
      shortAffirmativeFollowUp
    );
    messages.push({
      role: "system",
      content: followUpHint
    });
    if (tokenDebug) {
      console.log("[TokenDebug] shortAffirmativeFollowUpHint", {
        botId: botConfig.botId,
        chars: countChars(followUpHint),
        previousQuestion: shortAffirmativeFollowUp.previousQuestion
      });
    }
  }

  // 5) Current user turn
  messages.push({
    role: "user",
    content: message
  });
  if (tokenDebug) {
    console.log("[TokenDebug] userMessage", {
      botId: botConfig.botId,
      chars: countChars(message)
    });
    const baseSummary = summarizeMessages(messages);
    console.log("[TokenDebug] preToolPrompt", {
      botId: botConfig.botId,
      messageCount: baseSummary.count,
      totalChars: baseSummary.totalChars
    });
  }

  // 6) If no tools, simple path
  const chatBasicMaxTokens = resolveAssistantMaxTokens({
    message: knowledgeInputMessage,
    useKnowledge,
    knowledgeIntent: knowledgeIntentForBudget,
    knowledgePolicyMode: knowledgePolicyModeForBudget,
    knowledgeResponseStrategy: knowledgeResponseStrategyForBudget
  });

  if (tools.length === 0) {
    const reply = await getChatCompletion({
      messages,
      maxTokens: chatBasicMaxTokens,
      usageContext: {
        ...usageBase,
        operation: "chat_basic"
      }
    });

    if (botConfig.botId) {
      void maybeSendUsageAlertsForBot(botConfig.botId);
    }

    return await finalizeReply(reply);
  }

  // 7) Tool-enabled path
  const firstResponse = await createChatCompletionWithUsage({
    model: "gpt-4.1-mini",
    messages,
    maxTokens: 200,
    tools,
    toolChoice: "auto",
    usageContext: {
      ...usageBase,
      operation: bookingEnabledForTurn ? "chat_booking_first" : "chat_tools_first"
    }
  });

  const firstChoice = firstResponse.choices[0];
  const firstMessage = firstChoice.message;
  const toolCalls = firstMessage.tool_calls;

  // Process any booking draft updates first
  if (toolCalls && toolCalls.length > 0 && options.conversationId && botBookingCfg) {
    const draftCalls = toolCalls.filter(
      (tc) => tc.function?.name === "update_booking_draft"
    );

    for (const draftCall of draftCalls) {
      executedToolNamesThisTurn.add(draftCall.function?.name || "update_booking_draft");
      try {
        const rawArgs = draftCall.function?.arguments || "{}";
        const parsed = JSON.parse(rawArgs);
        await updateBookingDraft(
          options.conversationId,
          parsed,
          botBookingCfg.customFields
        );
      } catch (err) {
        console.error("Failed to process update_booking_draft tool:", err);
      }
    }
  }

  // If no tool call, just return the model's message content.
  if (!toolCalls || toolCalls.length === 0) {
    const content = firstMessage.content;
    if (!content) {
      throw new Error("OpenAI returned no content in booking-enabled path");
    }

    if (botConfig.botId) {
      void maybeSendUsageAlertsForBot(botConfig.botId);
    }

    return await finalizeReply(content);
  }

  // Find a booking-related tool call (book/update/cancel)
  const bookingCall = toolCalls.find((tc) => {
    const name = tc.function?.name;
    return (
      name === "book_appointment" ||
      name === "update_appointment" ||
      name === "cancel_appointment" ||
      name === "create_restaurant_reservation" ||
      name === "cancel_restaurant_reservation"
    );
  });

  // If there was no booking tool call (only update_booking_draft, etc.),
  // we must NOT send an assistant message with tool_calls again without tool messages.
  if (!bookingCall) {
    const shopifyCall = toolCalls.find((tc) =>
      SHOPIFY_TOOL_NAMES.has(tc.function?.name || "")
    );

    if (shopifyCall) {
      executedToolNamesThisTurn.add(shopifyCall.function?.name || "shopify_tool");
      if (!botConfig.botId) {
        throw new Error("Shopify tools unavailable for this bot.");
      }

      let toolResult: any = null;
      try {
        const rawArgs = shopifyCall.function?.arguments || "{}";
        const parsed = JSON.parse(rawArgs);
        const sessionId =
          parsed.sessionId || options.conversationId || `web:${slug}`;

        switch (shopifyCall.function?.name) {
          case "search_shopify_products": {
            const args = shopifySearchSchema.parse(parsed);
            const cappedLimit = Math.min(args.limit ?? 3, 3);
            toolResult = await toolSearchProducts({
              botId: botConfig.botId,
              query: args.query,
              priceMin: args.minPrice,
              priceMax: args.maxPrice,
              limit: cappedLimit,
              cursor: args.cursor
            });
            break;
          }
          case "get_shopify_product_details": {
            const args = shopifyProductDetailsSchema.parse(parsed);
            toolResult = await toolGetProductDetails({
              botId: botConfig.botId,
              productId: args.productId
            });
            break;
          }
          case "shopify_add_to_cart": {
            const args = shopifyAddToCartSchema.parse(parsed);
            toolResult = await toolAddToCart({
              botId: botConfig.botId,
              sessionId,
              variantId: args.variantId,
              quantity: args.quantity
            });
            break;
          }
          case "shopify_get_checkout_link": {
            shopifyCheckoutSchema.parse(parsed);
            toolResult = await toolGetCheckoutLink({
              botId: botConfig.botId
            });
            break;
          }
          case "shopify_get_order_status": {
            const args = shopifyOrderStatusSchema.parse(parsed);
            toolResult = await toolGetOrderStatus({
              botId: botConfig.botId,
              email: args.email,
              orderNumber: args.orderNumber
            });
            break;
          }
          default:
            toolResult = { error: "Unsupported Shopify tool call" };
        }
      } catch (err: any) {
        toolResult = {
          error: err?.message || "Failed to process Shopify tool call"
        };
      }

      const assistantForToolStep: ChatMessage = {
        role: "assistant",
        content: firstMessage.content || "",
        tool_calls: [shopifyCall]
      };

      const toolMessages: ChatMessage[] = [
        ...messages,
        assistantForToolStep,
        {
          role: "tool",
          tool_call_id: shopifyCall.id,
          content: JSON.stringify(toolResult)
        }
      ];
      if (tokenDebug) {
        console.log("[TokenDebug] toolResult", {
          botId: botConfig.botId,
          toolName: shopifyCall.function?.name,
          chars: countChars(JSON.stringify(toolResult))
        });
        const toolSummary = summarizeMessages(toolMessages);
        console.log("[TokenDebug] postToolPrompt", {
          botId: botConfig.botId,
          messageCount: toolSummary.count,
          totalChars: toolSummary.totalChars
        });
      }

      let secondContent = await getChatCompletion({
        model: "gpt-4.1-mini",
        messages: toolMessages,
        maxTokens: 300,
        usageContext: {
          ...usageBase,
          operation: "chat_shopify_tool"
        }
      });
      if (!secondContent) {
        secondContent = "Ho aggiornato le informazioni richieste.";
      }

      if (
        shopifyCall.function?.name === "search_shopify_products" &&
        toolResult &&
        Array.isArray((toolResult as any).items)
      ) {
        const items = (toolResult as any).items as Array<{
          title?: string | null;
          imageUrl?: string | null;
          productUrl?: string | null;
          addToCartUrl?: string | null;
          priceMin?: any;
        }>;
        const lang = (shoppingState?.language ?? "en") as
          | "en"
          | "it"
          | "es"
          | "de"
          | "fr";
        const cleanedText = buildShopifySummary({ lang, items });

        const targetItems = items.filter((item) => item.imageUrl).slice(0, 3);
        const imageBlocks = targetItems
          .map((item) => {
            const lines: string[] = [];
            if (item.productUrl) {
              lines.push(`[View product](${item.productUrl})`);
            }
            if (item.addToCartUrl) {
              lines.push(`[Add to cart](${item.addToCartUrl})`);
            }
            lines.push(`![${item.title || "Product"}](${item.imageUrl})`);
            return lines.join("\n");
          })
          .join("\n\n");

        if (imageBlocks) {
          secondContent = cleanedText
            ? `${cleanedText}\n\n${imageBlocks}`
            : imageBlocks;
        } else {
          secondContent = cleanedText || secondContent;
        }
      }

      if (
        shopifyCall.function?.name === "shopify_add_to_cart" &&
        toolResult &&
        (toolResult as any).addToCartUrl
      ) {
        const addUrl = (toolResult as any).addToCartUrl as string;
        const cartUrl = (toolResult as any).cartUrl as string | undefined;
        const hasAdd = /\/cart\/add/i.test(secondContent);
        const hasCart = /\/cart\b/i.test(secondContent);
        if (!hasAdd || (!hasCart && cartUrl)) {
          const lines = [
            !hasAdd ? `[Add to cart](${addUrl})` : null,
            !hasCart && cartUrl ? `[View cart](${cartUrl})` : null
          ].filter(Boolean);
          if (lines.length > 0) {
            secondContent = `${secondContent}\n\n${lines.join("\n")}`;
          }
        }
      }

      if (
        shopifyCall.function?.name === "shopify_get_checkout_link" &&
        toolResult &&
        (toolResult as any).cartUrl
      ) {
        const cartUrl = (toolResult as any).cartUrl as string;
        const hasCart = /\/cart\b/i.test(secondContent);
        if (!hasCart) {
          secondContent = `${secondContent}\n\n[View cart](${cartUrl})`;
        }
      }

      if (botConfig.botId) {
        void maybeSendUsageAlertsForBot(botConfig.botId);
      }

      const transactionalShopifyTools = new Set([
        "shopify_add_to_cart",
        "shopify_get_checkout_link",
        "shopify_get_order_status"
      ]);
      const hasTransactionalShopifyAction = transactionalShopifyTools.has(
        shopifyCall.function?.name || ""
      );

      return await finalizeReply(secondContent, {
        hasShopifyActionsInReply: hasTransactionalShopifyAction
      });
    }

    // Auto-book if a draft is now complete
    if (bookingEnabledForTurn && options.conversationId && botBookingCfg) {
      try {
        const latestDraft = await loadBookingDraft(options.conversationId);

        if (hasAllRequiredBookingFields(latestDraft, botBookingCfg)) {
          const draftAny: any = latestDraft;
          const replyLang = resolveReplyLanguage(shoppingState, routerResult);
          const bookingTimeZone =
            botConfig.booking && "timeZone" in botConfig.booking
              ? botConfig.booking.timeZone
              : "UTC";

          const draftArgs: BookAppointmentArgs = {
            name: String(draftAny.name ?? ""),
            email: String(draftAny.email ?? ""),
            phone: String(draftAny.phone ?? ""),
            service: String(draftAny.service ?? ""),
            datetime: String(draftAny.datetime ?? "")
          };

          if (latestDraft?.customFields) {
            for (const [key, value] of Object.entries(latestDraft.customFields)) {
              if (
                typeof value === "string" &&
                value.trim().length > 0 &&
                !(key in draftArgs)
              ) {
                (draftArgs as any)[key] = value;
              }
            }
          }

          console.log("[Booking] Auto-booking from completed draft", {
            slug,
            conversationId: options.conversationId,
            draftArgs
          });

          const weekdayHint = extractWeekdayFromMessage(message);
          if (weekdayHint && draftArgs.datetime) {
            const dt = DateTime.fromISO(draftArgs.datetime, {
              zone: bookingTimeZone
            });
            if (dt.isValid) {
              const actualKey = getWeekdayKeyForDate(dt);
              if (actualKey !== weekdayHint) {
                return await finalizeReply(
                  buildWeekdayMismatchReply({
                    lang: replyLang,
                    requested: weekdayHint,
                    actualIso: draftArgs.datetime,
                    timeZone: bookingTimeZone
                  }),
                  bookingReplyPolicyBypass
                );
              }
            }
          }

          const autoResult = await handleBookAppointment(slug, draftArgs);

          if (botConfig.botId) {
            void maybeSendUsageAlertsForBot(botConfig.botId);
          }

          if (autoResult.success) {
            const whenLabel = formatDateTimeLabel({
              iso: draftArgs.datetime,
              timeZone: bookingTimeZone,
              lang: replyLang
            });
          const emailNotice =
            autoResult.confirmationEmailSent === false
              ? replyLang === "it"
                ? " Tuttavia c'e' stato un problema con l'email di conferma: ti consiglio di segnarti data e ora."
                : replyLang === "es"
                ? " Sin embargo hubo un problema con el correo de confirmacion, asi que guarda la fecha y la hora."
                : replyLang === "de"
                ? " Es gab jedoch ein Problem mit der Bestatigungs-E-Mail. Bitte notiere dir Datum und Uhrzeit."
                : replyLang === "fr"
                ? " Il y a eu un probleme avec l'e-mail de confirmation. Merci de noter la date et l'heure."
                : " However, there was a problem sending the confirmation email, so please note the date and time."
              : replyLang === "it"
              ? " Riceverai a breve un'email di conferma."
              : replyLang === "es"
              ? " Recibiras un correo de confirmacion en breve."
              : replyLang === "de"
              ? " Du erhaltst in Kurze eine Bestatigungs-E-Mail."
              : replyLang === "fr"
              ? " Tu recevras bientot un e-mail de confirmation."
              : " You will receive a confirmation email shortly.";

          const successText =
            replyLang === "it"
              ? `La tua prenotazione per ${draftArgs.service} e' stata creata per ${whenLabel} a nome di ${draftArgs.name}.`
              : replyLang === "es"
              ? `Tu reserva de ${draftArgs.service} se ha creado para ${whenLabel} a nombre de ${draftArgs.name}.`
              : replyLang === "de"
              ? `Deine Buchung fuer ${draftArgs.service} wurde fuer ${whenLabel} unter dem Namen ${draftArgs.name} erstellt.`
              : replyLang === "fr"
              ? `Ta reservation pour ${draftArgs.service} a ete creee pour ${whenLabel} au nom de ${draftArgs.name}.`
              : `Your booking for ${draftArgs.service} has been created for ${whenLabel} under the name ${draftArgs.name}.`;

            return await finalizeReply(
              `${successText}${emailNotice}`,
              bookingReplyPolicyBypass
            );
          }

          const localizedError =
            localizeBookingError(autoResult, replyLang) ||
            autoResult.errorMessage;
          if (localizedError) {
            return await finalizeReply(localizedError, bookingReplyPolicyBypass);
          }

          return await finalizeReply(
            autoResult.errorMessage ||
              (replyLang === "it"
                ? "Mi dispiace, non sono riuscito a completare la prenotazione. Prova con un altro orario o controlla i dettagli."
                : replyLang === "es"
                ? "Lo siento, no pude completar la reserva. Prueba con otro horario o revisa los datos."
                : replyLang === "de"
                ? "Es tut mir leid, ich konnte die Buchung nicht abschliessen. Bitte versuche eine andere Zeit oder pruefe die Details."
                : replyLang === "fr"
                ? "Desole, je n'ai pas pu terminer la reservation. Essaie un autre horaire ou verifie les informations."
                : "Sorry, I couldn't process your booking. Please try another time or check your details."),
            bookingReplyPolicyBypass
          );
        }
      } catch (err) {
        console.error(
          "[Booking] Error while attempting auto-book from draft",
          { slug, error: err }
        );
      }
    }

// â¬‡ï¸ FALLBACK: behaviour when we're NOT ready to book (draft incomplete)

    const primaryContent = firstMessage.content;

    // If the model already replied in natural language, just use that.
    if (primaryContent && primaryContent.trim().length > 0) {
      if (botConfig.botId) {
        void maybeSendUsageAlertsForBot(botConfig.botId);
      }
      return await finalizeReply(primaryContent);
    }

    // Otherwise, do a second completion WITHOUT tools,
    // and IMPORTANT: do NOT include the assistant message with tool_calls.
    const secondMessages: ChatMessage[] = [...messages];

    const replyLang = resolveReplyLanguage(shoppingState, routerResult);

    const secondContent =
      (await getChatCompletion({
        model: "gpt-4.1-mini",
        messages: secondMessages,
        maxTokens: 200,
        usageContext: {
          ...usageBase,
          operation: "chat_after_draft"
        }
        // no tools here -> pure chat response
      })) ||
      (replyLang === "it"
        ? "Ho registrato le informazioni per la prenotazione. Vuoi dirmi il prossimo dettaglio mancante?"
        : replyLang === "es"
        ? "He registrado la informacion de la reserva. Que detalle falta?"
        : replyLang === "de"
        ? "Ich habe die Buchungsinformationen gespeichert. Was fehlt noch?"
        : replyLang === "fr"
        ? "J'ai enregistre les informations de reservation. Quel detail manque-t-il ?"
        : "I saved the booking info. What detail is missing?");

    if (botConfig.botId) {
      void maybeSendUsageAlertsForBot(botConfig.botId);
    }

    return await finalizeReply(secondContent);
  }

const functionName = bookingCall.function?.name || "unknown";
executedToolNamesThisTurn.add(functionName);

// Parse booking tool arguments and execute
let bookingResult: any;

  const bookingTimeZone = restaurantChatToolCfg
    ? restaurantChatToolCfg.timeZone
    : botConfig.booking && "timeZone" in botConfig.booking
    ? botConfig.booking.timeZone
    : "UTC";

  const replyLang = resolveReplyLanguage(shoppingState, routerResult);

try {
  const rawArgs = bookingCall.function?.arguments || "{}";
  const parsed = JSON.parse(rawArgs);

  if (options.conversationId) {
    if (functionName === "book_appointment" && botBookingCfg) {
      try {
        await updateBookingDraft(
          options.conversationId,
          parsed,
          botBookingCfg.customFields
        );
      } catch (err) {
        console.error("Failed to sync booking draft from booking tool:", err);
      }
    }

  }

  console.log("ðŸ”§ [Booking Tool] call", {
    slug,
    tool: functionName,
    args: parsed
  });

  if (functionName === "book_appointment") {
    // --- NEW: merge bookingDraft into the tool args so we don't "forget" fields ---
    let finalArgs = parsed as BookAppointmentArgs;

    if (bookingDraft) {
      const fromDraft: Record<string, any> = {};

      // Core fields: use draft as default, tool args win if present
      if (!finalArgs.name && bookingDraft.name) {
        fromDraft.name = bookingDraft.name;
      }
      if (!finalArgs.email && bookingDraft.email) {
        fromDraft.email = bookingDraft.email;
      }
      if (!finalArgs.phone && bookingDraft.phone) {
        fromDraft.phone = bookingDraft.phone;
      }
      if (!finalArgs.service && bookingDraft.service) {
        fromDraft.service = bookingDraft.service;
      }
      if (!finalArgs.datetime && bookingDraft.datetime) {
        fromDraft.datetime = bookingDraft.datetime;
      }

      // Custom fields from the draft
      if (bookingDraft.customFields) {
        for (const [key, value] of Object.entries(bookingDraft.customFields)) {
          if (
            typeof value === "string" &&
            value.trim().length > 0 &&
            (finalArgs as any)[key] == null
          ) {
            (fromDraft as any)[key] = value;
          }
        }
      }

      // Draft values = defaults, explicit tool args from this turn always win.
      finalArgs = { ...fromDraft, ...finalArgs };
    }
    // ---------------------------------------------------------------------------

    const weekdayHint = extractWeekdayFromMessage(message);
    if (weekdayHint && finalArgs.datetime) {
      const dt = DateTime.fromISO(finalArgs.datetime, { zone: bookingTimeZone });
      if (dt.isValid) {
        const actualKey = getWeekdayKeyForDate(dt);
        if (actualKey !== weekdayHint) {
          return await finalizeReply(
            buildWeekdayMismatchReply({
              lang: replyLang,
              requested: weekdayHint,
              actualIso: finalArgs.datetime,
              timeZone: bookingTimeZone
            }),
            bookingReplyPolicyBypass
          );
        }
      }
    }


    bookingResult = await handleBookAppointment(slug, finalArgs);
  } else if (functionName === "update_appointment") {
    const updateArgs = parsed as UpdateAppointmentArgs;
    const weekdayHint = extractWeekdayFromMessage(message);
    if (weekdayHint && updateArgs.newDatetime) {
      const dt = DateTime.fromISO(updateArgs.newDatetime, { zone: bookingTimeZone });
      if (dt.isValid) {
        const actualKey = getWeekdayKeyForDate(dt);
        if (actualKey !== weekdayHint) {
          return await finalizeReply(
            buildWeekdayMismatchReply({
              lang: replyLang,
              requested: weekdayHint,
              actualIso: updateArgs.newDatetime,
              timeZone: bookingTimeZone
            }),
            bookingReplyPolicyBypass
          );
        }
      }
    }

    bookingResult = await handleUpdateAppointment(slug, updateArgs);
  } else if (functionName === "cancel_appointment") {
    bookingResult = await handleCancelAppointment(
      slug,
      parsed as CancelAppointmentArgs
    );
  } else if (functionName === "create_restaurant_reservation") {
    bookingResult = await handleRestaurantCreateFromChat(slug, {
      name: String((parsed as any).name || ""),
      email: String((parsed as any).email || ""),
      phone: String((parsed as any).phone || ""),
      partySize: Number((parsed as any).partySize || 0),
      datetime: String((parsed as any).datetime || ""),
      smokingPreference: (parsed as any).smokingPreference,
      notes: (parsed as any).notes
    });
  } else if (functionName === "cancel_restaurant_reservation") {
    bookingResult = await handleRestaurantCancelFromChat(slug, {
      email: String((parsed as any).email || ""),
      datetime: String((parsed as any).datetime || ""),
      reason: (parsed as any).reason
    });
  } else {
    bookingResult = {
      success: false,
      errorMessage:
        "Unknown booking operation. Please try again or contact support.",
      errorCode: "unknown_booking_operation"
    };
  }
} catch (err) {
  console.error("Failed to parse booking tool arguments:", err);
  const fallbackResult: BookingResult = {
    success: false,
    errorMessage:
      "Invalid booking data. Please provide your name, email, phone, service and desired date/time (or the booking you want to change) clearly.",
    errorCode: "invalid_booking_data"
  };
  const localizedFallback = localizeBookingError(fallbackResult, replyLang);
  if (localizedFallback) {
    fallbackResult.errorMessage = localizedFallback;
  }

    // IMPORTANT: sanitize assistant message so it only contains the booking tool_call,
    // not the update_booking_draft tool calls that we already handled.
    const assistantForToolStep: ChatMessage = {
      role: "assistant",
      content: firstMessage.content || "",
      tool_calls: [bookingCall]
    };

    const toolMessages: ChatMessage[] = [
      ...messages,
      assistantForToolStep,
      {
        role: "tool",
        tool_call_id: bookingCall.id,
        content: JSON.stringify(fallbackResult)
      } as any
    ];

    const secondContent =
      (await getChatCompletion({
        model: "gpt-4.1-mini",
        messages: toolMessages,
        maxTokens: 200,
        usageContext: {
          ...usageBase,
          operation: "chat_booking_second"
        }
      })) || null;


    if (botConfig.botId) {
      void maybeSendUsageAlertsForBot(botConfig.botId);
    }

    return await finalizeReply(
      secondContent ||
        (replyLang === "it"
          ? "Mi dispiace, non sono riuscito a completare la prenotazione."
          : replyLang === "es"
          ? "Lo siento, no pude completar la reserva."
          : replyLang === "de"
          ? "Es tut mir leid, ich konnte die Buchung nicht abschliessen."
          : replyLang === "fr"
          ? "Desole, je n'ai pas pu terminer la reservation."
          : "Sorry, I couldn't process your booking."),
      bookingReplyPolicyBypass
    );
  }

  // 8) Second call: feed tool result back to model, no tools this time
  // Again, sanitize assistant message to include only the booking tool_call.
  const assistantForToolStep: ChatMessage = {
    role: "assistant",
    content: firstMessage.content || "",
    tool_calls: [bookingCall]
  };

  // ðŸ”’ Sanitize bookingResult so the model never sees addToCalendarUrl
  const bookingResultForModel: any = {
    ...bookingResult,
    addToCalendarUrl: undefined
  };

  if (!bookingResultForModel.success) {
    const localized = localizeBookingError(bookingResultForModel, replyLang);
    if (localized) {
      bookingResultForModel.errorMessage = localized;
    }
  }

  if (
    bookingResultForModel &&
    Array.isArray(bookingResultForModel.suggestedSlots) &&
    bookingResultForModel.suggestedSlots.length > 0
  ) {
    const lang = (shoppingState?.language ?? "en") as
      | "en"
      | "it"
      | "es"
      | "de"
      | "fr";
    const timeZone =
      botConfig.booking && "timeZone" in botConfig.booking
        ? botConfig.booking.timeZone
        : "UTC";
    const display = bookingResultForModel.suggestedSlots
      .map((iso: string) =>
        formatSuggestedSlot({ iso, timeZone, lang })
      )
      .filter(Boolean);

    if (display.length > 0) {
      bookingResultForModel.suggestedSlotsDisplay = display;
    }
  }

  const toolMessages: ChatMessage[] = [
    ...messages,
    assistantForToolStep,
    {
      role: "tool",
      tool_call_id: bookingCall.id,
      content: JSON.stringify(bookingResultForModel)
    } as any
  ];

  const finalContent =
    (await getChatCompletion({
      model: "gpt-4.1-mini",
      messages: toolMessages,
      maxTokens: 200,
      usageContext: {
        ...usageBase,
        operation: "chat_booking_second"
      }
    })) ||
    (bookingResult.success
      ? bookingResult.action === "updated"
        ? replyLang === "it"
          ? "La tua prenotazione Ã¨ stata aggiornata."
          : replyLang === "es"
          ? "Tu reserva ha sido actualizada."
          : replyLang === "de"
          ? "Deine Buchung wurde aktualisiert."
          : replyLang === "fr"
          ? "Ta reservation a ete mise a jour."
          : "Your booking has been updated."
        : bookingResult.action === "cancelled"
        ? replyLang === "it"
          ? "La tua prenotazione Ã¨ stata annullata."
          : replyLang === "es"
          ? "Tu reserva ha sido cancelada."
          : replyLang === "de"
          ? "Deine Buchung wurde storniert."
          : replyLang === "fr"
          ? "Ta reservation a ete annulee."
          : "Your booking has been cancelled."
        : replyLang === "it"
        ? "La tua prenotazione Ã¨ stata elaborata."
        : replyLang === "es"
        ? "Tu reserva ha sido procesada."
        : replyLang === "de"
        ? "Deine Buchung wurde bearbeitet."
        : replyLang === "fr"
        ? "Ta reservation a ete traitee."
        : "Your booking has been processed."
      : localizeBookingError(bookingResult, replyLang) ||
        bookingResult.errorMessage ||
        (replyLang === "it"
          ? "Mi dispiace, non sono riuscito a completare la prenotazione."
          : replyLang === "es"
          ? "Lo siento, no pude completar la reserva."
          : replyLang === "de"
          ? "Es tut mir leid, ich konnte die Buchung nicht abschliessen."
          : replyLang === "fr"
          ? "Desole, je n'ai pas pu terminer la reservation."
          : "Sorry, I couldn't process your booking."));

  if (botConfig.botId) {
    void maybeSendUsageAlertsForBot(botConfig.botId);
  }

  return await finalizeReply(finalContent, bookingReplyPolicyBypass);
}

/**
 * Summarize/analyze an entire conversation.
 */
export async function summarizeConversation(
  slug: string,
  conversationId: string
): Promise<string> {
  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) {
    throw new ChatServiceError(`Bot not found for slug '${slug}'`, 404);
  }

  const historyMessages = await getConversationHistoryAsChatMessages(
    conversationId
  );

  if (!historyMessages || historyMessages.length === 0) {
    return "This conversation is empty, so there is nothing to summarize yet.";
  }

  const usageBase = {
    userId: botConfig.ownerUserId ?? null,
    botId: botConfig.botId ?? null
  };

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You summarize conversations between a user and a business's AI assistant.\n" +
        "Return two sections: 'Summary' (what the user wanted and key assistant actions) and 'Analysis' (short insights useful for the business).\n" +
        "Keep everything under about 300 words."
    },
    ...historyMessages,
    {
      role: "user",
      content:
        "Please provide the 'Summary' and 'Analysis' for this entire conversation as described."
    }
  ];

  return await getChatCompletion({
    messages,
    model: "gpt-4.1-mini",
    maxTokens: 256,
    usageContext: {
      ...usageBase,
      operation: "conversation_summary_ui"
    }
  });
}
