import { describe, expect, it } from "vitest";
import { getOverviewCoverageQueries } from "./overviewCoverageQueries";

describe("overview coverage queries", () => {
  it("returns Italian helper queries", () => {
    const queries = getOverviewCoverageQueries("it");
    expect(queries).toContain("chi siamo");
    expect(queries).toContain("servizi");
  });

  it("returns English helper queries", () => {
    const queries = getOverviewCoverageQueries("en");
    expect(queries).toContain("about us");
    expect(queries).toContain("services");
  });

  it("returns Spanish helper queries", () => {
    const queries = getOverviewCoverageQueries("es");
    expect(queries).toContain("quienes somos");
    expect(queries).toContain("servicios");
  });

  it("falls back to English for unknown language", () => {
    const queries = getOverviewCoverageQueries("unknown");
    expect(queries).toContain("about us");
  });
});
