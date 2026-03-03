import { describe, expect, it, vi } from "vitest";

vi.mock("../openai/client", () => ({
  getChatCompletion: vi.fn()
}));

import { getChatCompletion } from "../openai/client";
import { routeConversation } from "./conversationRouter";
import { ShoppingState } from "./shoppingStateService";

const baseState: ShoppingState = {
  id: "state-1",
  botId: "bot-1",
  conversationId: "conv-1",
  sessionId: "web:1",
  language: "it",
  mode: "DISCOVERY",
  activeProductType: null,
  filters: {},
  shortlist: [],
  shortlistHash: null,
  lastShortlistAt: null,
  detailsProductId: null,
  lastDetailsAt: null,
  loopCount: 0,
  lastRoute: null,
  lastIntent: null,
  prevRoute: null,
  prevIntent: null,
  lastUpdatedAt: null
};

describe("conversation router", () => {
  it("parses valid router JSON", async () => {
    (getChatCompletion as any).mockResolvedValueOnce(
      JSON.stringify({
        route: "CLERK",
        language: "it",
        intent: "BROWSE",
        confidence: 0.8,
        should_fetch_catalog: true,
        selection: { ordinal: null, productId: null },
        notes: "browse"
      })
    );

    const result = await routeConversation({
      botId: "bot-1",
      message: "Vorrei vedere cosa avete",
      state: baseState,
      shopifyEnabled: true
    });

    expect(result.route).toBe("CLERK");
    expect(result.should_fetch_catalog).toBe(true);
  });

  it("falls back when router output is invalid", async () => {
    (getChatCompletion as any)
      .mockResolvedValueOnce("not-json")
      .mockResolvedValueOnce("still-not-json");

    const stateWithShortlist: ShoppingState = {
      ...baseState,
      shortlist: [
        {
          productId: "p1",
          title: "Item",
          priceMin: "10",
          priceMax: null,
          currency: "USD",
          imageUrl: null,
          productUrl: null,
          addToCartUrl: null,
          variantId: null,
          attrSummary: []
        }
      ]
    };

    const result = await routeConversation({
      botId: "bot-1",
      message: "non so quale scegliere",
      state: stateWithShortlist,
      shopifyEnabled: true
    });

    expect(result.route).toBe("CONVERSE");
  });
});
