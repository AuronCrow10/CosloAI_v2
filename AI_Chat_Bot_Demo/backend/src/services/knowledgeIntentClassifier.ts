import { createChatCompletionWithUsage } from "../openai/client";

export type KnowledgeIntent = "overview" | "specific" | "ambiguous";
export type KnowledgeIntentConfidence = "high" | "medium" | "low";

export interface KnowledgeIntentResult {
  intent: KnowledgeIntent;
  confidence: KnowledgeIntentConfidence;
  reason?: string;
  isFallback?: boolean;
}

const DEFAULT_FALLBACK: KnowledgeIntentResult = {
  intent: "specific",
  confidence: "low",
  reason: "fallback_default",
  isFallback: true
};

const CLASSIFIER_MODEL = "gpt-4o-mini";
const CLASSIFIER_MAX_TOKENS = 120;
const CLASSIFIER_TIMEOUT_MS = 3000;
const CLASSIFIER_MAX_RETRIES = 1;
const CLASSIFIER_RETRY_BACKOFF_MS = 200;
const OVERVIEW_META_RE =
  /\b(cosa\s+(sap|fai|potete?|puoi)|in\s+generale|panoramica|overview|what\s+can\s+you\s+do|what\s+do\s+you\s+know|how\s+can\s+you\s+help|que\s+puedes?\s+hacer|que\s+sabes?|en\s+general|was\s+kannst\s+du|was\s+wissen\s+sie|im\s+allgemeinen|que\s+peux[-\s]?tu\s+faire|que\s+savez[-\s]?vous|en\s+general)\b/i;

function buildClassifierSystemPrompt(): string {
  return (
    "You are a message intent classifier. Classify the user's message into one of:\n" +
    "- overview: asking what the bot knows, can help with, or what is in the knowledge base\n" +
    "- specific: a factual/task-specific question that should be answered from the knowledge base\n" +
    "- ambiguous: short, unclear, or follow-up questions without enough context\n" +
    "\n" +
    "Rules:\n" +
    "- Do not answer the question.\n" +
    "- Work across English, Italian, Spanish, German, French (IT/EN/ES/DE/FR).\n" +
    "- Do not rely on fixed phrase lists.\n" +
    "- Return ONLY valid JSON with this schema:\n" +
    '{ "intent": "overview|specific|ambiguous", "confidence": "high|medium|low", "reason": "short optional" }\n'
  );
}

function normalizeConfidence(input: unknown): KnowledgeIntentConfidence | null {
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "high" || normalized === "medium" || normalized === "low") {
      return normalized;
    }
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    if (input >= 0.7) return "high";
    if (input >= 0.4) return "medium";
    return "low";
  }
  return null;
}

function isValidIntent(input: unknown): input is KnowledgeIntent {
  return input === "overview" || input === "specific" || input === "ambiguous";
}

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

function extractJsonObject(raw: string): string | null {
  const text = stripCodeFences(raw);
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return null;
}

type KnowledgeIntentClassifierMetrics = {
  totalRequests: number;
  timeoutCount: number;
  parseFailureCount: number;
  fallbackUsedCount: number;
  intentCounts: Record<KnowledgeIntent, number>;
  lastLatencyMs?: number;
};

const classifierMetrics: KnowledgeIntentClassifierMetrics = {
  totalRequests: 0,
  timeoutCount: 0,
  parseFailureCount: 0,
  fallbackUsedCount: 0,
  intentCounts: {
    overview: 0,
    specific: 0,
    ambiguous: 0
  }
};

export function getKnowledgeIntentClassifierMetrics(): KnowledgeIntentClassifierMetrics {
  return { ...classifierMetrics, intentCounts: { ...classifierMetrics.intentCounts } };
}

function foldDiacritics(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function analyzeFallbackSignals(message: string) {
  const trimmed = message.trim();
  const rawTokens = Array.from(
    trimmed.matchAll(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu)
  );
  const tokens = rawTokens.map((match) => match[0]);
  const wordCount = tokens.length;

  const normalizedTokens = tokens.map((t) => foldDiacritics(t).toLowerCase());
  const pronounSignals = new Set([
    "it",
    "that",
    "this",
    "lo",
    "la",
    "eso",
    "esa",
    "esto",
    "quello",
    "quella",
    "questo",
    "questa"
  ]);
  const pronounCount = normalizedTokens.filter((t) => pronounSignals.has(t)).length;

  const hasQuestion = /[?¿]/.test(trimmed);
  const hasDigits = /\d/.test(trimmed);
  const hasUrl = /https?:\/\//i.test(trimmed) || /\bwww\./i.test(trimmed);
  const hasEmailOrHandle = /@/.test(trimmed);

  const hasProperNoun = rawTokens.some((match, index) => {
    const token = match[0];
    if (index === 0) return false;
    return /^[A-Z][a-zÀ-ÿ]+/.test(token);
  });

  const longTokenCount = normalizedTokens.filter(
    (token) => token.length >= 6 && !pronounSignals.has(token)
  ).length;

  const hasConcreteSignal =
    hasDigits || hasUrl || hasEmailOrHandle || hasProperNoun || longTokenCount > 0;

  return {
    wordCount,
    hasQuestion,
    hasConcreteSignal,
    pronounCount,
    isVeryShort: wordCount <= 2 || trimmed.length <= 12
  };
}

function buildFallbackFromSignals(message: string, reason: string): KnowledgeIntentResult {
  const signals = analyzeFallbackSignals(message);

  let overviewScore = 0;
  let ambiguousScore = 0;

  if (signals.hasQuestion && !signals.hasConcreteSignal && signals.wordCount >= 2) {
    overviewScore += 3;
  }
  if (signals.wordCount >= 4 && signals.wordCount <= 16) {
    overviewScore += 1;
  }
  // Edge-case: very short, question-like, generic prompts without follow-up cues
  // should lean toward overview rather than ambiguous.
  if (
    signals.hasQuestion &&
    !signals.hasConcreteSignal &&
    signals.pronounCount === 0 &&
    signals.wordCount > 0 &&
    signals.wordCount <= 4
  ) {
    overviewScore += 2;
    ambiguousScore -= 1;
  }

  if (signals.isVeryShort) ambiguousScore += 2;
  if (signals.wordCount <= 4) ambiguousScore += 1;
  if (signals.pronounCount > 0) ambiguousScore += 2;
  if (!signals.hasQuestion) ambiguousScore += 1;
  if (signals.hasConcreteSignal) ambiguousScore -= 1;

  let intent: KnowledgeIntent = "specific";
  let reasonCode = "fallback_signal_specific";

  if (overviewScore >= 3 && overviewScore >= ambiguousScore + 1) {
    intent = "overview";
    reasonCode = "fallback_signal_overview";
  } else if (ambiguousScore >= 3) {
    intent = "ambiguous";
    reasonCode = "fallback_signal_ambiguous";
  }

  return {
    intent,
    confidence: "low",
    reason: reason ? `${reasonCode}:${reason}` : reasonCode,
    isFallback: true
  };
}

function buildDeterministicIntentPrecheck(
  message: string
): KnowledgeIntentResult | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const normalized = foldDiacritics(trimmed).toLowerCase();
  const signals = analyzeFallbackSignals(trimmed);
  const hasQuestion = /[?¿]/.test(trimmed);

  // High-precision only: classify as overview deterministically only when
  // the user explicitly asks meta-capability/overview questions.
  if (OVERVIEW_META_RE.test(normalized)) {
    return {
      intent: "overview",
      confidence: "medium",
      reason: "precheck_overview",
      isFallback: true
    };
  }

  if (
    signals.isVeryShort &&
    signals.pronounCount > 0 &&
    !signals.hasConcreteSignal
  ) {
    return {
      intent: "ambiguous",
      confidence: "low",
      reason: "precheck_ambiguous_short_followup",
      isFallback: true
    };
  }

  // High-precision specific precheck:
  // require concrete signals to avoid forcing specific/overview on vague
  // short prompts that should be decided by classifier call.
  if (signals.hasConcreteSignal && (hasQuestion || signals.wordCount >= 2)) {
    return {
      intent: "specific",
      confidence: "medium",
      reason: "precheck_specific",
      isFallback: true
    };
  }

  return null;
}

export function parseKnowledgeIntentOutput(raw: string): KnowledgeIntentResult {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return { ...DEFAULT_FALLBACK, reason: "fallback_no_json" };

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const intent = parsed.intent;
    const confidence = normalizeConfidence(parsed.confidence);
    const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;

    if (!isValidIntent(intent) || !confidence) {
      return { ...DEFAULT_FALLBACK, reason: "fallback_invalid_fields" };
    }

    return {
      intent,
      confidence,
      reason
    };
  } catch {
    return { ...DEFAULT_FALLBACK, reason: "fallback_parse_error" };
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error("classifier_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function classifyKnowledgeIntent(params: {
  message: string;
  usageContext?: { userId?: string | null; botId?: string | null };
  timeoutMs?: number;
}): Promise<KnowledgeIntentResult> {
  const { message, usageContext } = params;
  const timeoutMs = params.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
  const startedAt = Date.now();
  classifierMetrics.totalRequests += 1;

  const system = buildClassifierSystemPrompt();
  const user = `Message:\n${message}`;
  const logDebug =
    String(process.env.KNOWLEDGE_DEBUG || "").toLowerCase() === "true";
  const precheck = buildDeterministicIntentPrecheck(message);
  if (precheck) {
    classifierMetrics.fallbackUsedCount += precheck.isFallback ? 1 : 0;
    classifierMetrics.intentCounts[precheck.intent] += 1;
    classifierMetrics.lastLatencyMs = Date.now() - startedAt;
    if (logDebug) {
      console.log("[KnowledgeIntent] classifier_precheck", {
        intent: precheck.intent,
        confidence: precheck.confidence,
        reason: precheck.reason,
        latencyMs: classifierMetrics.lastLatencyMs,
        metrics: getKnowledgeIntentClassifierMetrics()
      });
    }
    return precheck;
  }

  for (let attempt = 0; attempt <= CLASSIFIER_MAX_RETRIES; attempt += 1) {
    try {
      const completionPromise = createChatCompletionWithUsage({
        model: CLASSIFIER_MODEL,
        maxTokens: CLASSIFIER_MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        usageContext: {
          userId: usageContext?.userId ?? null,
          botId: usageContext?.botId ?? null,
          operation: "knowledge_intent"
        }
      });

      const completion = await withTimeout(completionPromise, timeoutMs);
      const raw = (completion as any)?.choices?.[0]?.message?.content;
      if (typeof raw !== "string") {
        throw new Error("classifier_no_content");
      }

      const parsed = parseKnowledgeIntentOutput(raw);
      if (parsed.isFallback) {
        classifierMetrics.parseFailureCount += 1;
        throw new Error(parsed.reason || "classifier_invalid_output");
      }
      classifierMetrics.intentCounts[parsed.intent] += 1;
      classifierMetrics.lastLatencyMs = Date.now() - startedAt;
      if (logDebug) {
        console.log("[KnowledgeIntent] classifier_success", {
          intent: parsed.intent,
          confidence: parsed.confidence,
          reason: parsed.reason,
          latencyMs: classifierMetrics.lastLatencyMs,
          metrics: getKnowledgeIntentClassifierMetrics()
        });
      }
      return parsed;
    } catch (err) {
      const messageText = (err as Error)?.message || "classifier_error";
      if (messageText === "classifier_timeout") {
        classifierMetrics.timeoutCount += 1;
      }
      if (attempt >= CLASSIFIER_MAX_RETRIES) {
        classifierMetrics.fallbackUsedCount += 1;
        const fallback = buildFallbackFromSignals(
          message,
          (err as Error)?.message || "fallback_error"
        );
        classifierMetrics.intentCounts[fallback.intent] += 1;
        classifierMetrics.lastLatencyMs = Date.now() - startedAt;
        if (logDebug) {
          console.log("[KnowledgeIntent] classifier_fallback", {
            intent: fallback.intent,
            confidence: fallback.confidence,
            reason: fallback.reason,
            latencyMs: classifierMetrics.lastLatencyMs,
            metrics: getKnowledgeIntentClassifierMetrics()
          });
        }
        return fallback;
      }
      await sleep(CLASSIFIER_RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  classifierMetrics.fallbackUsedCount += 1;
  const fallback = buildFallbackFromSignals(message, "fallback_error");
  classifierMetrics.intentCounts[fallback.intent] += 1;
  classifierMetrics.lastLatencyMs = Date.now() - startedAt;
  if (logDebug) {
    console.log("[KnowledgeIntent] classifier_fallback", {
      intent: fallback.intent,
      confidence: fallback.confidence,
      reason: fallback.reason,
      latencyMs: classifierMetrics.lastLatencyMs,
      metrics: getKnowledgeIntentClassifierMetrics()
    });
  }
  return fallback;
}
