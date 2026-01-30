// services/usageAggregationService.ts

import { prisma } from "../prisma/prisma";
import { Bot, User } from "@prisma/client";
import {
  fetchKnowledgeUsageForClient,
  KnowledgeUsageSummary
} from "./knowledgeUsageService";

export type BotUsageBreakdown = {
  botId: string;
  slug: string;
  name: string;

  userId: string;
  userEmail: string | null;

  // High-level totals (used for plan limits / billing)
  trainingTokens: number; // crawler ingestion
  inputTokens: number;    // chat prompt + crawler search + analytics
  outputTokens: number;   // chat completion + analytics
  totalTokens: number;

  // More detailed breakdown
  chat: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  crawler: {
    trainingTokens: number; // embeddings_ingest totalTokens
    searchTokens: number;   // embeddings_search totalTokens
    totalTokens: number;
  };

  // Background analytics (summaries, evals, etc.) – counted in totals but broken out
  analysis?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

// Operations we consider "analytics" (summaries, evals, UI summaries, etc.)
const BACKGROUND_OPERATIONS = [
  "conversation_memory_summary",
  "conversation_eval_auto",
  "conversation_eval_manual",
  "conversation_summary_ui"
];

/**
 * Given a knowledge usage summary, compute crawler training + search tokens.
 * We use totalTokens here because that's what you pay on.
 */
function computeCrawlerTokens(
  knowledge: KnowledgeUsageSummary | null
): { trainingTokens: number; searchTokens: number; totalTokens: number } {
  if (!knowledge) {
    return { trainingTokens: 0, searchTokens: 0, totalTokens: 0 };
  }

  let trainingTokens = 0;
  let searchTokens = 0;

  for (const op of knowledge.byOperation || []) {
    if (op.operation === "embeddings_ingest") {
      trainingTokens += op.totalTokens;
    } else if (op.operation === "embeddings_search") {
      searchTokens += op.totalTokens;
    }
  }

  const totalTokens = trainingTokens + searchTokens;

  return { trainingTokens, searchTokens, totalTokens };
}

/**
 * Compute usage for a single bot (chat + crawler + analytics).
 *
 * IMPORTANT:
 *  - High-level totals (inputTokens/outputTokens/totalTokens) now INCLUDE
 *    analytics operations (summaries, evals, etc.) so they count against
 *    the same plan token budget as normal chat.
 *  - The `analysis` block is just a breakdown for the UI.
 */
export async function getUsageForBot(params: {
  bot: Bot & { user: User };
  from?: Date | null;
  to?: Date | null;
}): Promise<BotUsageBreakdown> {
  const { bot, from, to } = params;

  // 1) Primary chat usage from OpenAIUsage (per bot), excluding analytics ops
  const primaryChatWhere: any = { botId: bot.id };
  if (from || to) {
    primaryChatWhere.createdAt = {};
    if (from) primaryChatWhere.createdAt.gte = from;
    if (to) primaryChatWhere.createdAt.lte = to;
  }
  primaryChatWhere.operation = {
    notIn: BACKGROUND_OPERATIONS
  };

  const chatAgg = await prisma.openAIUsage.aggregate({
    where: primaryChatWhere,
    _sum: {
      promptTokens: true,
      completionTokens: true,
      totalTokens: true
    }
  });

  const chatPromptTokens = chatAgg._sum.promptTokens ?? 0;
  const chatCompletionTokens = chatAgg._sum.completionTokens ?? 0;
  const chatTotalTokens = chatAgg._sum.totalTokens ?? 0;

  // 1b) Background analytics (summaries, evals, etc.) – we track separately
  // but they WILL be included in the high-level totals below.
  const backgroundWhere: any = {
    botId: bot.id,
    operation: { in: BACKGROUND_OPERATIONS }
  };
  if (from || to) {
    backgroundWhere.createdAt = {};
    if (from) backgroundWhere.createdAt.gte = from;
    if (to) backgroundWhere.createdAt.lte = to;
  }

  const backgroundAgg = await prisma.openAIUsage.aggregate({
    where: backgroundWhere,
    _sum: {
      promptTokens: true,
      completionTokens: true,
      totalTokens: true
    }
  });

  const analysisPromptTokens = backgroundAgg._sum.promptTokens ?? 0;
  const analysisCompletionTokens = backgroundAgg._sum.completionTokens ?? 0;
  const analysisTotalTokens = backgroundAgg._sum.totalTokens ?? 0;

  // 2) Crawler usage from Knowledge backend (per knowledgeClientId)
  let knowledgeSummary: KnowledgeUsageSummary | null = null;
  if ((bot as any).knowledgeSource !== "SHOPIFY" && bot.knowledgeClientId) {
    knowledgeSummary = await fetchKnowledgeUsageForClient({
      clientId: bot.knowledgeClientId,
      from: from ?? null,
      to: to ?? null
    });
  }

  const crawler = computeCrawlerTokens(knowledgeSummary);

  // 3) High-level classification:
  //
  // Training  = crawler ingestion embeddings
  // Input     = chat prompts + analytics prompts + crawler search embeddings
  // Output    = chat completions + analytics completions
  //
  const trainingTokens = crawler.trainingTokens;
  const inputTokens =
    chatPromptTokens + analysisPromptTokens + crawler.searchTokens;
  const outputTokens = chatCompletionTokens + analysisCompletionTokens;
  const totalTokens = trainingTokens + inputTokens + outputTokens;

  return {
    botId: bot.id,
    slug: bot.slug,
    name: bot.name,
    userId: bot.userId,
    userEmail: bot.user?.email ?? null,

    trainingTokens,
    inputTokens,
    outputTokens,
    totalTokens,

    chat: {
      promptTokens: chatPromptTokens,
      completionTokens: chatCompletionTokens,
      totalTokens: chatTotalTokens
    },
    crawler: {
      trainingTokens: crawler.trainingTokens,
      searchTokens: crawler.searchTokens,
      totalTokens: crawler.totalTokens
    },
    analysis: {
      promptTokens: analysisPromptTokens,
      completionTokens: analysisCompletionTokens,
      totalTokens: analysisTotalTokens
    }
  };
}
