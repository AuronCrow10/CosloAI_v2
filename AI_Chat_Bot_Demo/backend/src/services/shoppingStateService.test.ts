import { describe, expect, it } from "vitest";
import { updateStateFromClerkPayload, ShoppingState } from "./shoppingStateService";

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

describe("shopping state transitions", () => {
  it("updates mode and shortlist when clerk returns shortlist", () => {
    const next = updateStateFromClerkPayload(baseState, {
      type: "shortlist",
      items: [
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
    });

    expect(next.mode).toBe("SHORTLIST_SHOWN");
    expect(next.shortlist.length).toBe(1);
    expect(next.shortlistHash).toBeTruthy();
  });

  it("updates details when clerk returns details payload", () => {
    const next = updateStateFromClerkPayload(baseState, {
      type: "details",
      item: {
        productId: "p2",
        title: "Item 2",
        priceMin: "20",
        priceMax: null,
        currency: "USD",
        imageUrl: null,
        productUrl: null,
        addToCartUrl: null,
        variantId: null,
        attrSummary: []
      }
    });

    expect(next.mode).toBe("DETAILS_SHOWN");
    expect(next.detailsProductId).toBe("p2");
  });
});
