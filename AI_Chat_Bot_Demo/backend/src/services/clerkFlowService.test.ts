import { describe, expect, it } from "vitest";
import {
  chooseQualificationQuestions,
  detectLanguage,
  extractProvidedAttributes,
  parseSelectionIndex,
  resolveSelectionByAttributes
} from "./clerkFlowService";

const baseSchema = {
  shopDomain: "example.myshopify.com",
  updatedAt: new Date().toISOString(),
  productTypes: [{ name: "Shoes", count: 10 }],
  attributes: [
    {
      name: "Size",
      source: "option",
      coverage: 0.9,
      cardinality: 5,
      topValues: ["40", "41", "42"],
      filterable: true
    },
    {
      name: "Color",
      source: "option",
      coverage: 0.8,
      cardinality: 4,
      topValues: ["Black", "Brown"],
      filterable: true
    },
    {
      name: "Tag",
      source: "tag",
      coverage: 0.7,
      cardinality: 40,
      topValues: ["Leather"],
      filterable: true
    }
  ],
  typeToAttributes: {
    shoes: ["Size", "Color"]
  }
};

describe("clerk flow helpers", () => {
  it("detects language once", () => {
    expect(detectLanguage("Ciao, vorrei scarpe", "en")).toBe("it");
    expect(detectLanguage("quiero zapatos", "it")).toBe("es");
  });

  it("extracts only schema-known values", () => {
    const extracted = extractProvidedAttributes(
      "I want size 41 in black",
      baseSchema as any
    );
    expect(extracted.Size).toBe("41");
    expect(extracted.Color).toBe("Black");
    expect(extracted.Tag).toBeUndefined();
  });

  it("chooses up to two qualification questions", () => {
    const questions = chooseQualificationQuestions(
      baseSchema as any,
      "Shoes",
      {},
      "en"
    );
    expect(questions.length).toBeLessThanOrEqual(2);
  });

  it("resolves ordinal selection", () => {
    expect(parseSelectionIndex("the first one", "en", 3)).toBe(0);
    expect(parseSelectionIndex("la seconda", "it", 3)).toBe(1);
  });

  it("resolves selection by attribute values", () => {
    const shortlist = [
      {
        productId: "p1",
        title: "Shoe A",
        priceMin: null,
        priceMax: null,
        currency: null,
        imageUrl: null,
        productUrl: null,
        addToCartUrl: null,
        variantId: null,
        attrSummary: [{ label: "Color", value: "Black" }]
      },
      {
        productId: "p2",
        title: "Shoe B",
        priceMin: null,
        priceMax: null,
        currency: null,
        imageUrl: null,
        productUrl: null,
        addToCartUrl: null,
        variantId: null,
        attrSummary: [{ label: "Color", value: "Brown" }]
      }
    ];

    const matches = resolveSelectionByAttributes(
      "I prefer brown",
      shortlist as any
    );
    expect(matches.length).toBe(1);
    expect(matches[0].productId).toBe("p2");
  });
});
