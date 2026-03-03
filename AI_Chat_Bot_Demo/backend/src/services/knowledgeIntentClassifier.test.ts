import { describe, expect, it, vi } from "vitest";
import { classifyKnowledgeIntent, parseKnowledgeIntentOutput } from "./knowledgeIntentClassifier";

vi.mock("../openai/client", () => ({
  createChatCompletionWithUsage: vi.fn()
}));

import { createChatCompletionWithUsage } from "../openai/client";

describe("knowledge intent classifier", () => {
  it("parses valid JSON output", () => {
    const parsed = parseKnowledgeIntentOutput(
      '{"intent":"overview","confidence":"high","reason":"asks scope"}'
    );
    expect(parsed.intent).toBe("overview");
    expect(parsed.confidence).toBe("high");
    expect(parsed.isFallback).toBeUndefined();
  });

  it("maps numeric confidence", () => {
    const parsed = parseKnowledgeIntentOutput(
      '{"intent":"specific","confidence":0.8}'
    );
    expect(parsed.intent).toBe("specific");
    expect(parsed.confidence).toBe("high");
  });

  it("falls back on invalid output", () => {
    const parsed = parseKnowledgeIntentOutput("not json");
    expect(parsed.intent).toBe("specific");
    expect(parsed.isFallback).toBe(true);
  });

  it("returns signal-based fallback when model output is invalid", async () => {
    const mock = createChatCompletionWithUsage as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      choices: [{ message: { content: "n/a" } }]
    });

    const result = await classifyKnowledgeIntent({ message: "Quali temi copri di solito?" });
    expect(result.intent).toBe("overview");
    expect(result.isFallback).toBe(true);
  });

  it("falls back to overview for very short meta questions (IT/EN/ES)", async () => {
    const mock = createChatCompletionWithUsage as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      choices: [{ message: { content: "n/a" } }]
    });

    const itResult = await classifyKnowledgeIntent({ message: "Cosa sai?" });
    const enResult = await classifyKnowledgeIntent({ message: "What can you do?" });
    const esResult = await classifyKnowledgeIntent({ message: "Qué sabes?" });

    expect(itResult.intent).toBe("overview");
    expect(enResult.intent).toBe("overview");
    expect(esResult.intent).toBe("overview");
  });

  it("falls back to ambiguous for short follow-ups", async () => {
    const mock = createChatCompletionWithUsage as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      choices: [{ message: { content: "n/a" } }]
    });

    const result = await classifyKnowledgeIntent({ message: "E questo?" });
    expect(result.intent).toBe("ambiguous");
    expect(result.isFallback).toBe(true);
  });

  it("keeps follow-up cues ambiguous even when short", async () => {
    const mock = createChatCompletionWithUsage as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      choices: [{ message: { content: "n/a" } }]
    });

    const result = await classifyKnowledgeIntent({ message: "And that?" });
    expect(result.intent).toBe("ambiguous");
  });

  it("falls back to specific when concrete signals are present", async () => {
    const mock = createChatCompletionWithUsage as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      choices: [{ message: { content: "n/a" } }]
    });

    const result = await classifyKnowledgeIntent({ message: "Prezzi 2024?" });
    expect(result.intent).toBe("specific");
    expect(result.isFallback).toBe(true);
  });
});
