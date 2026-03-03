import { describe, expect, it } from "vitest";
import { extractContacts } from "./contactExtraction";

describe("extractContacts", () => {
  it("extracts and dedupes emails and phones", () => {
    const result = extractContacts({
      texts: [
        "Contattaci a info@example.com o support@example.com.",
        "Telefono +39 333 123 4567, email INFO@example.com"
      ],
      urls: ["https://example.com/contatti"]
    });

    expect(result.emails).toContain("info@example.com");
    expect(result.emails).toContain("support@example.com");
    expect(result.phones.length).toBeGreaterThan(0);
    expect(result.contactUrls[0]).toBe("https://example.com/contatti");
    expect(result.hasVerifiedContact).toBe(true);
  });

  it("filters non-contact urls and ignores junk numbers", () => {
    const result = extractContacts({
      texts: ["Codice cliente 1234567890", "Partita IVA 12345678901"],
      urls: ["https://example.com/portfolio"]
    });

    expect(result.emails.length).toBe(0);
    expect(result.phones.length).toBe(0);
    expect(result.contactUrls.length).toBe(0);
    expect(result.hasVerifiedContact).toBe(false);
  });

  it("keeps valid phone when source is contact-like even without label", () => {
    const result = extractContacts({
      sources: [
        { text: "Per assistenza: +39 333 123 4567", url: "https://example.com/contatti" }
      ]
    });
    expect(result.phones.length).toBe(1);
  });
});
