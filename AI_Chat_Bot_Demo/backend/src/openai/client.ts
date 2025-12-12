// openai/client.ts

import OpenAI from "openai";
import { config } from "../config";
import { recordOpenAIUsage } from "../services/usageService";

export const openai = new OpenAI({
  apiKey: config.openaiApiKey
});

// Keep the same types the rest of your code expects
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
 * Always uses the Chat Completions API (no Responses API).
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
    model = "gpt-4o-mini",
    maxTokens = 200,
    tools,
    toolChoice,
    usageContext
  } = params;

  const normCtx = normalizeUsageContext(usageContext);

  const completion = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    tools,
    tool_choice: toolChoice
  } as any);

  const usage = (completion as any).usage;

  if (usage) {
    const info = {
      model,
      operation: normCtx?.operation ?? "chat_basic",
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      messageCount: messages.length
    };
    console.log("[OpenAI usage]", info);

    if (normCtx) {
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
  }

  return completion as OpenAI.Chat.Completions.ChatCompletion;
}

/**
 * Convenience wrapper: returns only the assistant content as a string.
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
    model = "gpt-4o-mini",
    maxTokens = 200,
    usageContext
  } = params;

  const completion = await createChatCompletionWithUsage({
    messages,
    model,
    maxTokens,
    usageContext
  });

  const choice = completion.choices[0];
  const content = (choice as any)?.message?.content;

  // Extra debug log for tricky cases
  console.log(
    "[getChatCompletion] model=",
    model,
    " rawChoiceContent=",
    JSON.stringify(content)?.slice(0, 500)
  );

  if (content == null) {
    throw new Error("No content returned from OpenAI");
  }

  // If some model ever returns array-of-parts style content
  if (Array.isArray(content)) {
    const joined = content
      .map((part: any) =>
        typeof part === "string"
          ? part
          : part?.text?.value ?? part?.text ?? ""
      )
      .join("");
    return joined;
  }

  return content as string;
}
