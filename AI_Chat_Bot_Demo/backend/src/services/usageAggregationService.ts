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

  // High-level totals
  trainingTokens: number; // crawler ingestion
  inputTokens: number;    // chat prompt + crawler search
  outputTokens: number;   // chat completion
  totalTokens: number;

  // More detailed breakdown, if you need it
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
};

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
 * Compute usage for a single bot (chat + crawler).
 */
export async function getUsageForBot(params: {
  bot: Bot & { user: User };
  from?: Date | null;
  to?: Date | null;
}): Promise<BotUsageBreakdown> {
  const { bot, from, to } = params;

  // 1) Chat usage from OpenAIUsage (per bot)
  const chatWhere: any = { botId: bot.id };
  if (from || to) {
    chatWhere.createdAt = {};
    if (from) chatWhere.createdAt.gte = from;
    if (to) chatWhere.createdAt.lte = to;
  }

  const chatAgg = await prisma.openAIUsage.aggregate({
    where: chatWhere,
    _sum: {
      promptTokens: true,
      completionTokens: true,
      totalTokens: true
    }
  });

  const chatPromptTokens = chatAgg._sum.promptTokens ?? 0;
  const chatCompletionTokens = chatAgg._sum.completionTokens ?? 0;
  const chatTotalTokens = chatAgg._sum.totalTokens ?? 0;

  // 2) Crawler usage from Knowledge backend (per knowledgeClientId)
  let knowledgeSummary: KnowledgeUsageSummary | null = null;
  if (bot.knowledgeClientId) {
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
  // Input     = chat prompts  + crawler search embeddings
  // Output    = chat completions
  //
  const trainingTokens = crawler.trainingTokens;
  const inputTokens = chatPromptTokens + crawler.searchTokens;
  const outputTokens = chatCompletionTokens;
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
    }
  };
}
