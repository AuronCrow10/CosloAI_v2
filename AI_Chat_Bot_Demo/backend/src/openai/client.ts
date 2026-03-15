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

function extractTextContent(content: any): string {
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === "string"
          ? part
          : part?.text?.value ?? part?.text ?? ""
      )
      .join("");
  }
  return String(content);
}

function buildContinuationPrompt(params: {
  combined: string;
  duplicateRetry: boolean;
}): string {
  const tailAnchor = params.combined.slice(-220);
  return (
    "Continue the assistant reply EXACTLY from where it stopped.\n" +
    "Rules:\n" +
    "- Continue with only NEW text that has not already been written.\n" +
    "- Do not repeat or paraphrase previously generated lines.\n" +
    "- Preserve the same language, format, and list structure.\n" +
    "- Return only the continuation text.\n" +
    (params.duplicateRetry
      ? "- Your previous continuation repeated existing text; produce only the missing remainder.\n"
      : "") +
    `Already generated tail (for anchor):\n<<<${tailAnchor}>>>`
  );
}

function mergeContinuationText(combined: string, chunk: string): string {
  if (!chunk) return combined;
  if (!combined) return chunk;

  const next = chunk.replace(/^\s+/, "");
  if (!next) return combined;

  const tailWindow = combined.slice(-1400);
  if (tailWindow.includes(next)) {
    return combined;
  }

  const maxOverlap = Math.min(700, combined.length, next.length);
  const minOverlap = Math.min(40, maxOverlap);
  for (let k = maxOverlap; k >= minOverlap; k -= 1) {
    if (combined.slice(-k) === next.slice(0, k)) {
      return combined + next.slice(k);
    }
  }

  if (!/[ \n\t]$/.test(combined) && !/^[ \n\t.,;:!?)]/.test(next)) {
    return `${combined}\n${next}`;
  }
  return combined + next;
}

/**
 * Low-level helper: calls OpenAI and records usage if usageContext is provided.
 * Always uses the Chat Completions API (no Responses API).
 */
export async function createChatCompletionWithUsage(params: {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ChatTool[];
  toolChoice?: any;
  usageContext?: UsageContextInput;
}): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const {
    messages,
    model = "gpt-4.1-mini",
    maxTokens = 200,
    temperature,
    tools,
    toolChoice,
    usageContext
  } = params;

  const normCtx = normalizeUsageContext(usageContext);

  const completion = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    ...(typeof temperature === "number" ? { temperature } : {}),
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
    if (normCtx?.operation === "shop_catalog_context") {
      console.log("[ShopCatalogContext usage]", {
        model,
        promptTokens: info.promptTokens,
        completionTokens: info.completionTokens,
        totalTokens: info.totalTokens
      });
    }

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
  temperature?: number;
  usageContext?: UsageContextInput;
  maxContinuations?: number;
}): Promise<string> {
  const {
    messages,
    model = "gpt-4.1-mini",
    maxTokens = 200,
    temperature,
    usageContext,
    maxContinuations = 3
  } = params;

  let combined = "";
  let continuations = 0;
  let duplicateRetries = 0;
  let currentMessages = messages.slice();

  while (true) {
    const completion = await createChatCompletionWithUsage({
      messages: currentMessages,
      model,
      maxTokens,
      temperature,
      usageContext
    });

    const choice = completion.choices[0];
    const content = (choice as any)?.message?.content;
    const finishReason = (choice as any)?.finish_reason;

    // Extra debug log for tricky cases
    console.log(
      "[getChatCompletion] model=",
      model,
      " finish_reason=",
      finishReason,
      " rawChoiceContent=",
      JSON.stringify(content)?.slice(0, 500)
    );

    if (content == null) {
      throw new Error("No content returned from OpenAI");
    }

    const text = extractTextContent(content);
    const merged = mergeContinuationText(combined, text);
    const mergedChanged = merged !== combined;
    combined = merged;

    if (finishReason !== "length") {
      break;
    }

    if (!mergedChanged && duplicateRetries < 1) {
      duplicateRetries += 1;
    } else {
      duplicateRetries = 0;
    }

    if (continuations >= maxContinuations) {
      console.warn(
        "[getChatCompletion] hit maxContinuations",
        { model, maxContinuations }
      );
      break;
    }

    continuations += 1;
    currentMessages = [
      ...messages,
      { role: "assistant", content: combined },
      {
        role: "user",
        content: buildContinuationPrompt({
          combined,
          duplicateRetry: duplicateRetries > 0
        })
      }
    ];
  }

  return combined;
}
