// services/conversationService.ts

import { prisma } from "../prisma/prisma";
import { ChannelType, MessageRole, ConversationMode } from "@prisma/client";
import { ChatMessage } from "../openai/client";

type FindOrCreateConversationArgs = {
  botId: string;
  channel: ChannelType;
  externalUserId: string;
};

type LogMessageArgs = {
  conversationId: string;
  role: MessageRole | "USER" | "ASSISTANT" | "SYSTEM" | "HUMAN";
  content: string;
  channelMessageId?: string;
};

const MAX_HISTORY_MESSAGES = 10;   // max number of messages to look back
const MAX_HISTORY_CHARS = 3000;    // char-based budget (~750 tokens)

/**
 * Find or create a Conversation row based on (botId, channel, externalUserId).
 * This matches the unique index in schema.prisma:
 *   @@unique([botId, channel, externalUserId], name: "botId_channel_externalUserId")
 */
export async function findOrCreateConversation({
  botId,
  channel,
  externalUserId
}: FindOrCreateConversationArgs) {
  const conversation = await prisma.conversation.upsert({
    where: {
      botId_channel_externalUserId: {
        botId,
        channel,
        externalUserId
      }
    },
    update: {
      lastMessageAt: new Date()
    },
    create: {
      botId,
      channel,
      externalUserId
    }
  });

  return conversation;
}

function normalizeRole(role: LogMessageArgs["role"]): MessageRole {
  // Confrontiamo solo con le stringhe, poi mappiamo all'enum Prisma.
  if (role === "USER") return MessageRole.USER;
  if (role === "ASSISTANT") return MessageRole.ASSISTANT;
  if (role === "SYSTEM") return MessageRole.SYSTEM;
  if (role === "HUMAN") return MessageRole.HUMAN;
  // default fallback
  return MessageRole.USER;
}

/**
 * Log a single message into the Message table and update conversation.lastMessageAt.
 */
export async function logMessage({
  conversationId,
  role,
  content,
  channelMessageId
}: LogMessageArgs) {
  const normalizedRole = normalizeRole(role);

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        role: normalizedRole,
        content,
        channelMessageId: channelMessageId ?? null
      }
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date()
      }
    })
  ]);

  return message;
}

/**
 * Return a token-efficient, ordered list of past messages for a conversation.
 * - Only last MAX_HISTORY_MESSAGES messages
 * - Hard cap on total characters (MAX_HISTORY_CHARS)
 * - Oldest â†’ newest (as expected by OpenAI)
 */
export async function getConversationHistoryAsChatMessages(
  conversationId: string
): Promise<ChatMessage[]> {
  // Get the latest messages, newest first
  const dbMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY_MESSAGES
  });

  if (dbMessages.length === 0) return [];

  let totalChars = 0;
  const selected: ChatMessage[] = [];

  for (const m of dbMessages) {
    const content = m.content || "";
    const length = content.length;

    if (!content.trim()) continue;

    let role: ChatMessage["role"];
    if (m.role === MessageRole.USER) {
      role = "user";
    } else if (m.role === MessageRole.ASSISTANT || m.role === MessageRole.HUMAN) {
      role = "assistant";
    } else {
      // SYSTEM messages from DB are usually not needed as history turns.
      // You can include them by mapping to "system" if you want.
      role = "system";
    }

    // If adding this message would exceed the char budget and we already have some,
    // stop to keep tokens under control.
    if (totalChars + length > MAX_HISTORY_CHARS && selected.length > 0) {
      break;
    }

    totalChars += length;
    selected.push({ role, content });
  }

  // We collected from newest â†’ oldest; reverse to oldest â†’ newest.
  return selected.reverse();
}


const HUMAN_HANDOFF_MESSAGES = {
  it: "Un operatore sara da te a breve.",
  en: "A human agent will be with you shortly.",
  es: "Un agente humano estara contigo en breve.",
  de: "Ein menschlicher Mitarbeiter ist gleich fuer dich da.",
  fr: "Un agent humain sera avec vous sous peu."
} as const;
const HUMAN_KEYWORDS = [
  // English
  "human",
  "real human",
  "real person",
  "live agent",
  "talk to a human",
  "talk with a human",
  "talk to an agent",
  "talk to a real human",
  "human please",
  "operator",

  // Italian
  "operatore",
  "parlare con un operatore",
  "voglio parlare con un operatore",
  "parlare con operatore",
  "voglio un operatore",
  "assistente umano",
  "operatore umano",
  "persona reale",
  "parlare con una persona",

  // Spanish
  "humano",
  "persona real",
  "agente",
  "agente humano",
  "hablar con un humano",
  "hablar con una persona",
  "hablar con un agente",
  "operador",

  // German
  "mensch",
  "echter mensch",
  "echte person",
  "mit einem menschen sprechen",
  "mit einer person sprechen",
  "mit einem mitarbeiter sprechen",
  "mit einem agenten sprechen",
  "operator",
  "mitarbeiter",

  // French
  "humain",
  "vraie personne",
  "agent",
  "agent humain",
  "parler a un humain",
  "parler a une personne",
  "parler a un agent",
  "operateur"
];

function normalizeText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function shouldSwitchToHumanMode(raw: string): boolean {
  const text = normalizeText(raw);
  if (!text) return false;

  // any keyword appearing anywhere is enough
  return HUMAN_KEYWORDS.some((kw) => text.includes(kw));
}
function detectHumanLanguage(message: string): keyof typeof HUMAN_HANDOFF_MESSAGES {
  const text = normalizeText(message);
  if (!text) return "en";

  const itSignals = ["operatore", "persona reale", "parlare con"];
  const esSignals = ["humano", "persona real", "agente", "operador", "hablar con"];
  const deSignals = ["mensch", "mitarbeiter", "agent", "mit einem", "mit einer"];
  const frSignals = ["humain", "agent", "operateur", "parler a", "parler avec", "vraie personne"];

  if (itSignals.some((s) => text.includes(s))) return "it";
  if (esSignals.some((s) => text.includes(s))) return "es";
  if (deSignals.some((s) => text.includes(s))) return "de";
  if (frSignals.some((s) => text.includes(s))) return "fr";
  return "en";
}

export function getHumanHandoffMessage(message: string): string {
  const lang = detectHumanLanguage(message);
  return HUMAN_HANDOFF_MESSAGES[lang] || HUMAN_HANDOFF_MESSAGES.en;
}





