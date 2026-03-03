import { describe, expect, it } from "vitest";
import {
  classifyIntent,
  shouldAskClarifyingQuestion,
  shouldAllowOfferAfterAnswer
} from "./revenueAIIntent";

describe("Revenue AI intent classifier", () => {
  it("blocks offers for support intent with high confidence", () => {
    const intent = classifyIntent("Where is my order? Tracking says delayed.");
    const allowed = shouldAllowOfferAfterAnswer({
      intent,
      assistantReply: "I can help with your order status."
    });
    expect(intent.intent).toBe("SUPPORT");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.6);
    expect(allowed).toBe(false);
  });

  it("price-only question does not allow offer before answering", () => {
    const intent = classifyIntent("Quanto costa?");
    const allowed = shouldAllowOfferAfterAnswer({
      intent,
      assistantReply: "Quale prodotto intendi?"
    });
    expect(intent.intent).toBe("PRICE_ONLY");
    expect(allowed).toBe(false);
  });

  it("indecisive question triggers one clarifier", () => {
    const shouldAsk = shouldAskClarifyingQuestion({
      message: "Which one should I choose?",
      history: []
    });
    expect(shouldAsk).toBe(true);

    const shouldAskAfter = shouldAskClarifyingQuestion({
      message: "Which one should I choose?",
      history: [
        {
          role: "assistant",
          content: "What is your budget?"
        }
      ]
    });
    expect(shouldAskAfter).toBe(false);
  });

  it("shopping intent allows offer when answer is complete", () => {
    const intent = classifyIntent("I want to buy this.");
    const allowed = shouldAllowOfferAfterAnswer({
      intent,
      assistantReply: "Great choice. Here are the details."
    });
    expect(intent.intent).toBe("SHOPPING");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.6);
    expect(allowed).toBe(true);
  });
});
