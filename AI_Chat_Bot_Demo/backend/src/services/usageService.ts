// services/usageService.ts

import { prisma } from "../prisma/prisma";

export type UsageOperation =
  | "chat_basic"
  | "chat_booking_first"
  | "chat_booking_second"
  | string; // allow future custom ops

export async function recordOpenAIUsage(params: {
  userId?: string | null;
  botId?: string | null;
  model: string;
  operation: UsageOperation;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}): Promise<void> {
  const promptTokens = params.promptTokens ?? 0;
  const completionTokens = params.completionTokens ?? 0;
  const totalTokens =
    params.totalTokens ?? promptTokens + completionTokens;

  if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) {
    return;
  }

  try {
    await prisma.openAIUsage.create({
      data: {
        userId: params.userId ?? null,
        botId: params.botId ?? null,
        model: params.model,
        operation: params.operation,
        promptTokens,
        completionTokens,
        totalTokens
      }
    });
  } catch (err) {
    // Never break chat flow because of logging issues
    console.error("Failed to record OpenAI usage", err);
  }
}
