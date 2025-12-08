// openai/client.ts

import OpenAI from "openai";
import { config } from "../config";
import { recordOpenAIUsage } from "../services/usageService";

export const openai = new OpenAI({
  apiKey: config.openaiApiKey
});

export type ChatMessage =
  OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool =
  OpenAI.Chat.Completions.ChatCompletionTool;

export type UsageContextInput = {
  userId?: string | null;
  botId?: string | null;
  operation?: string; // if omitted, default to "chat_basic"
};

type NormalizedUsageContext = {
  userId: string | null;
  botId: string | null;
  operation: string;
};

function normalizeUsageContext(
  ctx?: UsageContextInput
): NormalizedUsageContext | null {
  if (!ctx) return null;
  return {
    userId: ctx.userId ?? null,
    botId: ctx.botId ?? null,
    operation: ctx.operation ?? "chat_basic"
  };
}

/**
 * Low-level helper: calls OpenAI and records usage if usageContext is provided.
 * Returns the full ChatCompletion.
 */
export async function createChatCompletionWithUsage(params: {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  tools?: ChatTool[];
  toolChoice?: any;
  usageContext?: UsageContextInput;
}): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const {
    messages,
    model = "gpt-4.1-mini",
    maxTokens = 250,
    tools,
    toolChoice,
    usageContext
  } = params;

  const completion = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    tools,
    tool_choice: toolChoice
  } as any);

  const usage = (completion as any).usage;
  const normCtx = normalizeUsageContext(usageContext);

  if (usage && normCtx) {
    await recordOpenAIUsage({
      userId: normCtx.userId,
      botId: normCtx.botId,
      model,
      operation: normCtx.operation,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0
    });
  }

  return completion;
}

/**
 * Convenience wrapper: returns only the assistant content.
 * Still records token usage if usageContext is provided.
 */
export async function getChatCompletion(params: {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  usageContext?: UsageContextInput;
}): Promise<string> {
  const {
    messages,
    model = "gpt-4.1-mini",
    maxTokens = 250,
    usageContext
  } = params;

  const completion = await createChatCompletionWithUsage({
    messages,
    model,
    maxTokens,
    usageContext
  });

  const choice = completion.choices[0];
  const content = choice?.message?.content;

  if (!content) {
    throw new Error("No content returned from OpenAI");
  }

  return content;
}
