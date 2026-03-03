import { describe, expect, it } from "vitest";
import {
  CandidateProduct,
  filterAvailableCandidates,
  filterExcludedCandidates,
  computeCandidateScore,
  rankCandidates
} from "./revenueAIRecommender";

const baseProduct = {
  productType: "Shoes",
  vendor: "Acme",
  tags: ["running", "lightweight"],
  price: 100
};

function buildCandidate(id: string, overrides?: Partial<CandidateProduct>): CandidateProduct {
  return {
    id,
    productId: `gid://shopify/Product/${id}`,
    handle: `product-${id}`,
    title: `Product ${id}`,
    productType: "Shoes",
    vendor: "Acme",
    tags: ["running"],
    priceMin: 120,
    variant: {
      variantId: `gid://shopify/ProductVariant/${id}`,
      price: 120,
      compareAtPrice: null,
      availableForSale: true,
      inventoryQuantity: 5,
      imageUrl: null
    },
    ...overrides
  };
}

describe("Revenue AI recommender filters", () => {
  it("excludes out-of-stock candidates", () => {
    const candidates = [
      buildCandidate("1", { variant: { ...buildCandidate("1").variant, inventoryQuantity: 0 } }),
      buildCandidate("2")
    ];
    const filtered = filterAvailableCandidates(candidates);
    expect(filtered.map((c) => c.id)).toEqual(["2"]);
  });

  it("excludes already offered candidates", () => {
    const candidates = [buildCandidate("1"), buildCandidate("2")];
    const filtered = filterExcludedCandidates({
      candidates,
      excludeProductIds: new Set([candidates[0].productId])
    });
    expect(filtered.map((c) => c.id)).toEqual(["2"]);
  });
});

describe("Revenue AI scoring", () => {
  it("respects upsell delta band", () => {
    const candidate = buildCandidate("1", { variant: { ...buildCandidate("1").variant, price: 200 } });
    const scored = computeCandidateScore({
      candidate,
      base: baseProduct,
      performance: { impressions: 10, clicks: 2, addToCart: 1 },
      config: {
        upsellDeltaMinPct: 10,
        upsellDeltaMaxPct: 35,
        aggressiveness: 0.5,
        maxRecommendations: 3,
        complementMap: null
      },
      forUpsell: true
    });
    expect(scored.breakdown.price).toBe(0);
  });

  it("ranks higher score candidates deterministically", () => {
    const low = buildCandidate("1", {
      tags: ["casual"],
      variant: { ...buildCandidate("1").variant, inventoryQuantity: 1 }
    });
    const high = buildCandidate("2", {
      tags: ["running", "lightweight"],
      variant: { ...buildCandidate("2").variant, inventoryQuantity: 40 }
    });

    const ranked = rankCandidates({
      candidates: [low, high],
      base: baseProduct,
      performanceMap: new Map([
        [high.productId, { impressions: 100, clicks: 20, addToCart: 10 }],
        [low.productId, { impressions: 100, clicks: 1, addToCart: 0 }]
      ]),
      config: {
        upsellDeltaMinPct: 10,
        upsellDeltaMaxPct: 35,
        aggressiveness: 0.5,
        maxRecommendations: 3,
        complementMap: null
      },
      forUpsell: true
    });

    expect(ranked[0].id).toBe("2");
  });
});
