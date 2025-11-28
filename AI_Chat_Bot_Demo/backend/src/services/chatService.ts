// services/chatService.ts

import { getBotConfigBySlug } from "../bots/config";
import { searchKnowledge } from "../knowledge/client";
import { ChatMessage, ChatTool, getChatCompletion, openai } from "../openai/client";
import { handleBookAppointment, BookAppointmentArgs } from "./bookingService";

// NEW: conversation history for per-conversation memory
import { getConversationHistoryAsChatMessages } from "./conversationService";

const MAX_MESSAGE_LENGTH = 2000;

export class ChatServiceError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Tool schema for booking
const bookingTool: ChatTool = {
  type: "function",
  function: {
    name: "book_appointment",
    description: "Create an appointment for the user in the business calendar.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "User's full name"
        },
        phone: {
          type: "string",
          description: "User's phone number including country code if possible"
        },
        service: {
          type: "string",
          description: "Requested service or treatment (e.g. haircut, dinner for 2, etc.)"
        },
        datetime: {
          type: "string",
          description:
            "Requested appointment date and time in ISO 8601 (e.g. 2025-11-23T15:00:00). Treat as local time in the business's time zone."
        }
      },
      required: ["name", "phone", "service", "datetime"]
    }
  }
};

// Generic booking instructions injected as extra system message
function getBookingInstructions(): string {
  return (
    "You can create appointments by calling the tool `book_appointment`.\n" +
    "Use conversation to collect the user's full name, phone number, service, and desired date/time.\n" +
    "Only call `book_appointment` once you have all of these fields clearly.\n" +
    "If information is missing or ambiguous (especially date/time), ask the user follow-up questions.\n" +
    "Treat the `datetime` as local time in the business's time zone.\n" +
    "If the requested time is in the past or clearly unreasonable, ask the user to choose another time.\n" +
    "If you ask follow-up questions, do NOT call the tool yet; only call the tool when the user provides all required information in a single clear message.\n" +
    "After the tool is called and the booking result is returned, confirm the booking details to the user. If booking fails, apologize and suggest they contact the business directly or choose another time."
  );
}

type GenerateReplyOptions = {
  /**
   * DB conversation id (from Conversation.id), used to load past messages.
   * If omitted, the reply is stateless (only RAG + current message).
   */
  conversationId?: string;
};

/**
 * Generate a reply for a given bot slug and user message.
 * Reuses RAG logic and adds optional booking via tools.
 * NOW: supports per-conversation memory when conversationId is provided.
 */
export async function generateBotReplyForSlug(
  slug: string,
  rawMessage: string,
  options: GenerateReplyOptions = {}
): Promise<string> {
  const botConfig = await getBotConfigBySlug(slug);
  if (!botConfig) {
    throw new ChatServiceError(`Bot not found for slug '${slug}'`, 404);
  }
  if (!botConfig.knowledgeClientId) {
    throw new ChatServiceError(
      "This bot has no knowledge base configured yet. Ask the owner to set up content & crawl the site.",
      400
    );
  }

  const message = (rawMessage || "").trim();
  if (!message) {
    throw new ChatServiceError("Message cannot be empty", 400);
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ChatServiceError(`Message is too long (max ${MAX_MESSAGE_LENGTH} chars)`, 400);
  }

  // 1) Call Knowledge Backend
  const results = await searchKnowledge({
    clientId: botConfig.knowledgeClientId,
    domain: botConfig.domain,
    query: message,
    limit: 5
  });

  // 2) Build context string
  const contextChunks = results.map((r, index) => {
    const safeUrl = r.url || botConfig.domain;
    return `Chunk ${index + 1} (from ${safeUrl}):\n${r.text}`;
  });

  console.log(contextChunks);

  const contextText =
    contextChunks.length > 0
      ? contextChunks.join("\n\n")
      : "No relevant context was found for this query in the website content.";

  // 3) Base messages for OpenAI
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: botConfig.systemPrompt
    },
    {
      role: "system",
      content:
        "You are given CONTEXT extracted from the business website.\n" +
        "Use ONLY this context to answer factual questions about the business (services, prices, opening hours, address, etc.).\n" +
        "If the answer is not present in the context, say you don't know.\n\n" +
        "CONTEXT:\n" +
        contextText
    }
  ];

  const bookingEnabled = botConfig.booking && botConfig.booking.enabled;

  if (bookingEnabled) {
    messages.push({
      role: "system",
      content: getBookingInstructions()
    });
  }

  // --- NEW: Per-conversation memory (recent history) ---
  if (options.conversationId) {
    const historyMessages = await getConversationHistoryAsChatMessages(
      options.conversationId
    );

    if (historyMessages.length > 0) {
      messages.push({
        role: "system",
        content:
          "Below is the recent conversation history with this user. Use it to understand context, references and follow-ups."
      });
      messages.push(...historyMessages);
    }
  }

  // Current user turn
  messages.push({
    role: "user",
    content: message
  });

  // 4) If booking is disabled, simple path: one OpenAI call, no tools.
  if (!bookingEnabled) {
    return await getChatCompletion({ messages, maxTokens: 400 });
  }

  // 5) Booking-enabled path: use tools
  const firstResponse = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages,
    max_tokens: 400,
    tools: [bookingTool],
    tool_choice: "auto"
  });

  const firstChoice = firstResponse.choices[0];
  const firstMessage = firstChoice.message;

  // If no tool call, just return the model's message content as normal reply.
  const toolCalls = firstMessage.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    const content = firstMessage.content;
    if (!content) {
      throw new Error("OpenAI returned no content in booking-enabled path");
    }
    return content;
  }

  // Find the book_appointment tool call
  const bookingCall = toolCalls.find((tc) => tc.function?.name === "book_appointment");
  if (!bookingCall) {
    // Some other tool (unexpected) – just return content
    const content = firstMessage.content || "Sorry, I couldn't process your booking request.";
    return content;
  }

  // Parse tool arguments
  let args: BookAppointmentArgs;
  try {
    const rawArgs = bookingCall.function.arguments || "{}";
    args = JSON.parse(rawArgs);

    // NEW: log tool call
    console.log("🔧 [Booking Tool] book_appointment called", {
      slug,
      args
    });
  } catch (err) {
    console.error("Failed to parse book_appointment arguments:", err);
    const bookingResult = {
      success: false,
      errorMessage:
        "Invalid booking data. Please provide your name, phone, service and desired date/time clearly."
    };

    // Second call to let model explain the issue
    const toolMessages: ChatMessage[] = [
      ...messages,
      firstMessage as ChatMessage,
      {
        role: "tool",
        tool_call_id: bookingCall.id,
        content: JSON.stringify(bookingResult)
      }
    ];

    const secondResponse = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: toolMessages,
      max_tokens: 400
    });

    const secondChoice = secondResponse.choices[0];
    return secondChoice.message.content || "Sorry, I couldn't process your booking.";
  }

  // Actually perform booking
  const bookingResult = await handleBookAppointment(slug, args);

  // 6) Second call: feed tool result back to model, no tools this time
  const toolMessages: ChatMessage[] = [
    ...messages,
    firstMessage as ChatMessage,
    {
      role: "tool",
      tool_call_id: bookingCall.id,
      content: JSON.stringify(bookingResult)
    }
  ];

  const secondResponse = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: toolMessages,
    max_tokens: 400
  });

  const secondChoice = secondResponse.choices[0];
  const finalContent =
    secondChoice.message.content ||
    (bookingResult.success
      ? "Your booking has been processed."
      : bookingResult.errorMessage || "Sorry, I couldn't process your booking.");

  return finalContent;
}
