"use strict";
// services/conversationService.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.findOrCreateConversation = findOrCreateConversation;
exports.logMessage = logMessage;
exports.getConversationHistoryAsChatMessages = getConversationHistoryAsChatMessages;
const prisma_1 = require("../prisma/prisma");
const client_1 = require("@prisma/client");
const MAX_HISTORY_MESSAGES = 20; // max number of messages to look back
const MAX_HISTORY_CHARS = 6000; // char-based budget (~1500 tokens)
/**
 * Find or create a Conversation row based on (botId, channel, externalUserId).
 * This matches the unique index in schema.prisma:
 *   @@unique([botId, channel, externalUserId], name: "botId_channel_externalUserId")
 */
async function findOrCreateConversation({ botId, channel, externalUserId }) {
    const conversation = await prisma_1.prisma.conversation.upsert({
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
function normalizeRole(role) {
    // Confrontiamo solo con le stringhe, poi mappiamo all'enum Prisma.
    if (role === "USER")
        return client_1.MessageRole.USER;
    if (role === "ASSISTANT")
        return client_1.MessageRole.ASSISTANT;
    if (role === "SYSTEM")
        return client_1.MessageRole.SYSTEM;
    // default fallback
    return client_1.MessageRole.USER;
}
/**
 * Log a single message into the Message table and update conversation.lastMessageAt.
 */
async function logMessage({ conversationId, role, content, channelMessageId }) {
    const normalizedRole = normalizeRole(role);
    const [message] = await prisma_1.prisma.$transaction([
        prisma_1.prisma.message.create({
            data: {
                conversationId,
                role: normalizedRole,
                content,
                channelMessageId: channelMessageId ?? null
            }
        }),
        prisma_1.prisma.conversation.update({
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
 * - Oldest → newest (as expected by OpenAI)
 */
async function getConversationHistoryAsChatMessages(conversationId) {
    // Get the latest messages, newest first
    const dbMessages = await prisma_1.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: "desc" },
        take: MAX_HISTORY_MESSAGES
    });
    if (dbMessages.length === 0)
        return [];
    let totalChars = 0;
    const selected = [];
    for (const m of dbMessages) {
        const content = m.content || "";
        const length = content.length;
        if (!content.trim())
            continue;
        let role;
        if (m.role === client_1.MessageRole.USER) {
            role = "user";
        }
        else if (m.role === client_1.MessageRole.ASSISTANT) {
            role = "assistant";
        }
        else {
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
    // We collected from newest → oldest; reverse to oldest → newest.
    return selected.reverse();
}
