// services/rateLimitService.ts

import { prisma } from "../prisma/prisma";

export type RateLimitResult = {
  isLimited: boolean;
  retryAfterSeconds: number;
};

// --------- Config (env with sane defaults) ---------

const DEFAULT_WINDOW_SECONDS = 60; // how far back we count messages
const DEFAULT_MAX_USER_MESSAGES = 15; // messages per window

// base block length when they first hit the limit
const DEFAULT_BASE_BLOCK_SECONDS = 120; // 2 minutes

// how much to multiply block length per additional strike (2 = 2min, 4min, 8min, ...)
const DEFAULT_ESCALATION_FACTOR = 2;

// hard cap on block length (e.g. 1 hour)
const DEFAULT_MAX_BLOCK_SECONDS = 3600;

// after this many hours since last strike, reset the strike counter
const DEFAULT_STRIKE_RESET_HOURS = 24;

const WINDOW_SECONDS =
  Number(process.env.RATE_LIMIT_WINDOW_SECONDS) > 0
    ? Number(process.env.RATE_LIMIT_WINDOW_SECONDS)
    : DEFAULT_WINDOW_SECONDS;

const MAX_USER_MESSAGES =
  Number(process.env.RATE_LIMIT_MAX_USER_MESSAGES) > 0
    ? Number(process.env.RATE_LIMIT_MAX_USER_MESSAGES)
    : DEFAULT_MAX_USER_MESSAGES;

const BASE_BLOCK_SECONDS =
  Number(process.env.RATE_LIMIT_BASE_BLOCK_SECONDS) > 0
    ? Number(process.env.RATE_LIMIT_BASE_BLOCK_SECONDS)
    : DEFAULT_BASE_BLOCK_SECONDS;

const ESCALATION_FACTOR_RAW =
  Number(process.env.RATE_LIMIT_ESCALATION_FACTOR) > 0
    ? Number(process.env.RATE_LIMIT_ESCALATION_FACTOR)
    : DEFAULT_ESCALATION_FACTOR;

// safety: min 1x (no escalation) if misconfigured
const ESCALATION_FACTOR = ESCALATION_FACTOR_RAW < 1 ? 1 : ESCALATION_FACTOR_RAW;

const MAX_BLOCK_SECONDS =
  Number(process.env.RATE_LIMIT_MAX_BLOCK_SECONDS) > 0
    ? Number(process.env.RATE_LIMIT_MAX_BLOCK_SECONDS)
    : DEFAULT_MAX_BLOCK_SECONDS;

const STRIKE_RESET_HOURS =
  Number(process.env.RATE_LIMIT_STRIKE_RESET_HOURS) > 0
    ? Number(process.env.RATE_LIMIT_STRIKE_RESET_HOURS)
    : DEFAULT_STRIKE_RESET_HOURS;

const STRIKE_RESET_MS = STRIKE_RESET_HOURS * 60 * 60 * 1000;

// --------- Core logic ---------

export async function checkConversationRateLimit(
  conversationId: string
): Promise<RateLimitResult> {
  if (!conversationId) {
    return { isLimited: false, retryAfterSeconds: 0 };
  }

  // Load the conversation's rate-limit state
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      rateLimitBlockedUntil: true,
      rateLimitStrikeCount: true,
      rateLimitLastStrikeAt: true
    }
  });

  if (!convo) {
    // If conversation vanished, just allow and let caller decide what to do
    return { isLimited: false, retryAfterSeconds: 0 };
  }

  const now = new Date();

  // 1) If currently blocked, respect that
  if (convo.rateLimitBlockedUntil && convo.rateLimitBlockedUntil > now) {
    const retryAfterMs =
      convo.rateLimitBlockedUntil.getTime() - now.getTime();
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(retryAfterMs / 1000)
    );
    return { isLimited: true, retryAfterSeconds };
  }

  // 2) Strike decay / reset (e.g. reset after 24h)
  let strikeCount = convo.rateLimitStrikeCount ?? 0;
  const lastStrikeAt = convo.rateLimitLastStrikeAt;

  if (lastStrikeAt) {
    const ageMs = now.getTime() - lastStrikeAt.getTime();
    if (ageMs > STRIKE_RESET_MS) {
      strikeCount = 0;
    }
  } else {
    // if never had a strike, ensure 0
    strikeCount = 0;
  }

  // 3) Count recent USER messages in the sliding window
  const windowMs = WINDOW_SECONDS * 1000;
  const windowStart = new Date(now.getTime() - windowMs);

  const recentUserMessageCount = await prisma.message.count({
    where: {
      conversationId: convo.id,
      role: "USER",
      createdAt: {
        gte: windowStart
      }
    }
  });

  // If under limit → update strike count if it changed (e.g. got reset) and allow
  if (recentUserMessageCount < MAX_USER_MESSAGES) {
    if (strikeCount !== (convo.rateLimitStrikeCount ?? 0)) {
      await prisma.conversation.update({
        where: { id: convo.id },
        data: {
          rateLimitStrikeCount: strikeCount,
          rateLimitLastStrikeAt:
            strikeCount === 0 ? null : convo.rateLimitLastStrikeAt
        }
      });
    }

    return { isLimited: false, retryAfterSeconds: 0 };
  }

  // 4) They exceeded the window → create a new "strike" and block them

  const newStrikeCount = strikeCount + 1;

  // Exponential backoff: base * factor^(strike-1), capped at MAX_BLOCK_SECONDS
  const blockSecondsRaw =
    BASE_BLOCK_SECONDS * Math.pow(ESCALATION_FACTOR, newStrikeCount - 1);
  const blockSeconds = Math.min(blockSecondsRaw, MAX_BLOCK_SECONDS);

  const blockedUntil = new Date(now.getTime() + blockSeconds * 1000);

  await prisma.conversation.update({
    where: { id: convo.id },
    data: {
      rateLimitStrikeCount: newStrikeCount,
      rateLimitLastStrikeAt: now,
      rateLimitBlockedUntil: blockedUntil
    }
  });

  return {
    isLimited: true,
    retryAfterSeconds: Math.max(1, Math.round(blockSeconds))
  };
}

// --------- Shared message builder ---------

export function buildRateLimitMessage(
  retryAfterSeconds: number
): string {
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return "You have reached the message limit for this assistant. Please try again in a little while.";
  }

  const minutes = Math.ceil(retryAfterSeconds / 60);

  if (minutes <= 1) {
    return "You have reached the message limit for this assistant. Please wait about a minute before sending more messages.";
  }

  return `You have reached the message limit for this assistant. Please wait about ${minutes} minute${
    minutes === 1 ? "" : "s"
  } before sending more messages.`;
}
