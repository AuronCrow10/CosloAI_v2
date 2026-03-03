import { describe, expect, it } from "vitest";
import {
  buildProductFunnels,
  buildSessionImpactFromRows,
  computeSessionImpactMetrics,
  computeSessionImpactUplift
} from "./revenueAIMetrics";

describe("revenueAIMetrics", () => {
  it("computes session rates and uplift deltas", () => {
    const withOffer = computeSessionImpactMetrics({
      sessions: 10,
      addToCartSessions: 4,
      checkoutSessions: 3,
      purchaseSessions: 2,
      revenueCents: 12000,
      purchaseCount: 2
    });

    const withoutOffer = computeSessionImpactMetrics({
      sessions: 20,
      addToCartSessions: 2,
      checkoutSessions: 1,
      purchaseSessions: 1,
      revenueCents: 5000,
      purchaseCount: 1
    });

    expect(withOffer.addToCartRate).toBeCloseTo(40, 3);
    expect(withOffer.checkoutRate).toBeCloseTo(30, 3);
    expect(withOffer.purchaseRate).toBeCloseTo(20, 3);
    expect(withOffer.aovCents).toBe(6000);

    const uplift = computeSessionImpactUplift(withOffer, withoutOffer);
    expect(uplift.addToCartRate).toBeCloseTo(30, 3);
    expect(uplift.checkoutRate).toBeCloseTo(25, 3);
    expect(uplift.purchaseRate).toBeCloseTo(15, 3);
    expect(uplift.aovCents).toBe(1000);
  });

  it("builds product funnels and ranks by business impact", () => {
    const funnels = buildProductFunnels([
      {
        product_id: "p1",
        title: "Alpha",
        image_url: null,
        impressions: 10,
        clicks: 5,
        add_to_cart: 2,
        checkout: 1,
        purchases: 1,
        revenue_cents: 1000
      },
      {
        product_id: "p2",
        title: "Beta",
        image_url: null,
        impressions: 8,
        clicks: 4,
        add_to_cart: 3,
        checkout: 2,
        purchases: 1,
        revenue_cents: 2000
      }
    ]);

    expect(funnels[0].productId).toBe("p2");
    expect(funnels[0].rates.ctr).toBeCloseTo(50, 2);
    expect(funnels[0].rates.atcRate).toBeCloseTo(37.5, 2);
  });

  it("computes session impact from grouped rows", () => {
    const impact = buildSessionImpactFromRows([
      {
        group_key: "with_offer",
        sessions: 2,
        add_to_cart_sessions: 1,
        checkout_sessions: 1,
        purchase_sessions: 1,
        revenue_cents: 4000,
        purchase_count: 1
      },
      {
        group_key: "without_offer",
        sessions: 2,
        add_to_cart_sessions: 0,
        checkout_sessions: 0,
        purchase_sessions: 0,
        revenue_cents: 0,
        purchase_count: 0
      }
    ]);

    expect(impact.withOffer.sessions).toBe(2);
    expect(impact.withOffer.addToCartRate).toBeCloseTo(50, 2);
    expect(impact.withOffer.aovCents).toBe(4000);
    expect(impact.withoutOffer.sessions).toBe(2);
  });
});
