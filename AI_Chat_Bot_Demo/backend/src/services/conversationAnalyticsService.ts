// services/conversationAnalyticsService.ts

import { prisma } from "../prisma/prisma";
import { MessageRole } from "@prisma/client";
import { ChatMessage, getChatCompletion } from "../openai/client";
import { getBotConfigBySlug } from "../bots/config";

const MIN_MESSAGES_FOR_MEMORY_SUMMARY = 6; // ~3 user+assistant turns
const MIN_MESSAGES_FOR_EVAL = 4; // at least a bit of back-and-forth

export async function getConversationMemorySummary(
  conversationId: string
): Promise<string | null> {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { memorySummary: true }
  });

  return convo?.memorySummary ?? null;
}

export async function maybeUpdateConversationMemorySummary(
  slug: string,
  conversationId: string
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" }
      }
    }
  });

  if (!conversation) return;

  // Short conversations don't need memory summary
  if (conversation.messages.length < MIN_MESSAGES_FOR_MEMORY_SUMMARY) {
    return;
  }

  // For now: only create the memory summary once per conversation.
  if (conversation.memorySummary) {
    return;
  }

  console.log(
    `[Summary] Starting memory summary for conversation ${conversationId} with ${conversation.messages.length} messages`
  );

  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) return;

  const usageBase = {
    userId: botConfig.ownerUserId ?? null,
    botId: botConfig.botId ?? null
  };

  const historyMessages: ChatMessage[] = [];

  for (const m of conversation.messages) {
    const content = m.content?.trim();
    if (!content) continue;

    let role: ChatMessage["role"];

    if (m.role === MessageRole.USER) {
      role = "user";
    } else if (m.role === MessageRole.ASSISTANT) {
      role = "assistant";
    } else {
      role = "system";
    }

    historyMessages.push({ role, content });
  }

  if (historyMessages.length === 0) return;

  const systemPrompt =
    "You are an assistant that maintains a compact long-term memory of a conversation between a user and a business's AI assistant.\n" +
    "Summarize ONLY the stable, reusable information: the user's goals, preferences, constraints, and key facts the assistant learned.\n" +
    "Ignore greetings, small talk, apologies, and purely UI/formatting details.\n" +
    "Keep the summary under about 200 words.";

  const messagesForSummary: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    {
      role: "user",
      content:
        "Write a single concise paragraph with the long-term memory for this conversation."
    }
  ];

  const summary = await getChatCompletion({
    messages: messagesForSummary,
    model: "gpt-4.1-mini",
    maxTokens: 256,
    usageContext: {
      ...usageBase,
      operation: "conversation_memory_summary"
    }
  });

  console.log(
    `[Summary] Raw model output for conversation ${conversationId}:`,
    summary.slice(0, 600)
  );

  if (!summary || !summary.trim()) {
    console.warn(
      `⚠️ Summary generation returned empty content for conversation ${conversationId}`
    );
    return;
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      memorySummary: summary,
      memorySummaryModel: "gpt-4.1-mini",
      memorySummaryUpdatedAt: new Date()
    }
  });

  console.log(
    `[Summary] Saved memory summary for conversation ${conversationId}`
  );
}

export type ConversationEvalResult = {
  score: number;
  label: string | null;
  details: string | null;
  isAuto: boolean;
  createdAt: string;
};

export async function evaluateConversation(
  slug: string,
  conversationId: string,
  isAuto = false
): Promise<ConversationEvalResult> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" }
      }
    }
  });

  if (!conversation) {
    throw new Error("Conversation not found");
  }

  if (conversation.messages.length < MIN_MESSAGES_FOR_EVAL) {
    throw new Error("Not enough messages to evaluate this conversation yet");
  }

  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) {
    throw new Error("Bot config not found for evaluation");
  }

  const usageBase = {
    userId: botConfig.ownerUserId ?? null,
    botId: botConfig.botId ?? null
  };

  const historyMessages: ChatMessage[] = [];

  for (const m of conversation.messages) {
    const content = m.content?.trim();
    if (!content) continue;

    let role: ChatMessage["role"];
    if (m.role === MessageRole.USER) {
      role = "user";
    } else if (m.role === MessageRole.ASSISTANT) {
      role = "assistant";
    } else {
      role = "system";
    }

    historyMessages.push({ role, content });
  }

  if (historyMessages.length === 0) {
    throw new Error("Conversation is empty");
  }

  const systemPrompt =
    "You are evaluating the quality of an AI assistant that chats with users on behalf of a business.\n" +
    "Consider: understanding of the user's needs, factual correctness, use of the provided business context, clarity, and usefulness.\n" +
    "Score from 1 (very poor) to 10 (excellent).";

  const evalInstruction =
    "Evaluate the assistant's performance in this full conversation.\n" +
    "Return ONLY strict JSON in this format (no extra text):\n" +
    '{ "score": 0-10, "label": "short title", "details": "1–3 short sentences explaining the score" }';

  const messagesForEval: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: evalInstruction }
  ];

  const raw = await getChatCompletion({
    messages: messagesForEval,
    model: "gpt-4.1-mini",
    maxTokens: 256,
    usageContext: {
      ...usageBase,
      operation: isAuto ? "conversation_eval_auto" : "conversation_eval_manual"
    }
  });

  console.log(
    `[Eval] Raw model output for conversation ${conversationId}:`,
    raw.slice(0, 800)
  );

  let parsed: { score?: number; label?: string; details?: string } = {};

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try {
      // Try to find the first {...} JSON block inside the output
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        console.warn(
          `[Eval] No JSON object found in eval output for conversation ${conversationId}`,
          trimmed
        );
      }
    } catch (err) {
      console.error(
        `[Eval] JSON.parse failed for conversation ${conversationId}, raw=`,
        trimmed,
        err
      );
    }
  } else {
    console.warn(
      `[Eval] Non-string eval output for conversation ${conversationId}:`,
      raw
    );
  }

  const score =
    typeof parsed.score === "number"
      ? Math.max(1, Math.min(10, Math.round(parsed.score)))
      : 5;

  const label = parsed.label ?? null;
  const details = parsed.details ?? null;

  const evalRow = await prisma.conversationEval.create({
    data: {
      conversationId,
      score,
      label,
      details,
      model: "gpt-4.1-mini",
      isAuto
    }
  });

  console.log(
    `[Eval] Stored evaluation for conversation ${conversationId}: score=${evalRow.score}`
  );

  return {
    score: evalRow.score,
    label: evalRow.label,
    details: evalRow.details,
    isAuto: evalRow.isAuto,
    createdAt: evalRow.createdAt.toISOString()
  };
}
