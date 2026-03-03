import { describe, expect, it } from "vitest";
import { buildSchemaFromProducts } from "./catalogIntelligenceService";

describe("catalog intelligence schema builder", () => {
  it("extracts option attributes and computes coverage", () => {
    const schema = buildSchemaFromProducts({
      shopDomain: "example.myshopify.com",
      products: [
        { id: "p1", productType: "Shoes", tags: ["Leather"], bodyHtml: null },
        { id: "p2", productType: "Shoes", tags: ["Leather"], bodyHtml: null }
      ],
      variants: [
        {
          productDbId: "p1",
          selectedOptions: [
            { name: "Size", value: "10" },
            { name: "Color", value: "Red" }
          ]
        },
        {
          productDbId: "p2",
          selectedOptions: [{ name: "Size", value: "12" }]
        }
      ]
    });

    const sizeAttr = schema.attributes.find((a) => a.name.toLowerCase() === "size");
    const colorAttr = schema.attributes.find((a) => a.name.toLowerCase() === "color");

    expect(sizeAttr).toBeTruthy();
    expect(sizeAttr?.coverage).toBe(1);
    expect(sizeAttr?.cardinality).toBe(2);

    expect(colorAttr).toBeTruthy();
    expect(colorAttr?.coverage).toBe(0.5);

    const typeKey = "shoes";
    expect(schema.typeAttributeValues[typeKey]).toBeTruthy();
    expect(schema.typeAttributeValues[typeKey]["Size"]).toContain("10");
  });
});
