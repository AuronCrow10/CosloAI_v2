import OpenAI from "openai";
import { config } from "../config";

export const openai = new OpenAI({
  apiKey: config.openaiApiKey
});

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

export async function getChatCompletion(params: {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
}): Promise<string> {
  const { messages, model = "gpt-4.1-mini", maxTokens = 400 } = params;

  const completion = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens
  });

  const choice = completion.choices[0];
  const content = choice?.message?.content;

  if (!content) {
    throw new Error("No content returned from OpenAI");
  }

  return content;
}
