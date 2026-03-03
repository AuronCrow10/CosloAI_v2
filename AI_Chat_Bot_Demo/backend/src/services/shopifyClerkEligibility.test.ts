import { describe, expect, it } from "vitest";
import { evaluateClerkEligibility } from "./shopifyClerkEligibility";
import { RouterResult } from "./conversationRouter";
import { ShoppingState } from "./shoppingStateService";

const shortlistItem = {
  productId: "p1",
  title: "Item 1",
  priceMin: "100",
  priceMax: null,
  currency: "USD",
  imageUrl: null,
  productUrl: null,
  addToCartUrl: null,
  variantId: null,
  attrSummary: []
};

const baseState: ShoppingState = {
  id: "state-1",
  botId: "bot-1",
  conversationId: "conv-1",
  sessionId: "web:1",
  language: "it",
  mode: "SHORTLIST_SHOWN",
  activeProductType: null,
  filters: {},
  shortlist: [shortlistItem],
  shortlistHash: "hash",
  lastShortlistAt: new Date().toISOString(),
  detailsProductId: null,
  lastDetailsAt: null,
  loopCount: 0,
  lastRoute: null,
  lastIntent: null,
  prevRoute: null,
  prevIntent: null,
  lastUpdatedAt: null
};

describe("clerk eligibility", () => {
  it("blocks clerk on hesitation with shortlist", () => {
    const router: RouterResult = {
      route: "CONVERSE",
      language: "it",
      intent: "HESITATE",
      confidence: 0.8,
      should_fetch_catalog: false,
      switch_product_type: false,
      selection: { ordinal: null, productId: null },
      notes: "hesitate"
    };

    const decision = evaluateClerkEligibility(router, baseState);
    expect(decision.useClerk).toBe(false);
  });

  it("allows clerk for selection with shortlist", () => {
    const router: RouterResult = {
      route: "CLERK",
      language: "it",
      intent: "SELECT",
      confidence: 0.8,
      should_fetch_catalog: false,
      switch_product_type: false,
      selection: { ordinal: 1, productId: null },
      notes: "select"
    };

    const decision = evaluateClerkEligibility(router, baseState);
    expect(decision.useClerk).toBe(true);
  });

  it("allows clerk after repeated qualify without shortlist", () => {
    const stateNoShortlist: ShoppingState = {
      ...baseState,
      shortlist: [],
      shortlistHash: null,
      mode: "DISCOVERY",
      prevIntent: "QUALIFY",
      lastIntent: "QUALIFY"
    };
    const router: RouterResult = {
      route: "CONVERSE",
      language: "it",
      intent: "QUALIFY",
      confidence: 0.8,
      should_fetch_catalog: false,
      switch_product_type: false,
      selection: { ordinal: null, productId: null },
      notes: "qualify_repeat"
    };

    const decision = evaluateClerkEligibility(router, stateNoShortlist);
    expect(decision.useClerk).toBe(true);
  });
});
