import { describe, expect, it } from "vitest";
import { detectContactQuery } from "./contactQueryDetection";

describe("detectContactQuery", () => {
  it("detects generic contact requests (IT/EN/ES)", () => {
    expect(detectContactQuery("Come posso contattarvi?").isContactQuery).toBe(true);
    expect(detectContactQuery("How can I contact you?").isContactQuery).toBe(true);
    expect(detectContactQuery("¿Cómo puedo contactar?").isContactQuery).toBe(true);
  });

  it("detects email/phone requests", () => {
    const result = detectContactQuery("Avete un numero di telefono o email?");
    expect(result.isContactQuery).toBe(true);
    expect(result.requestedFields.phone).toBe(true);
    expect(result.requestedFields.email).toBe(true);
  });

  it("flags partner contact intent", () => {
    const result = detectContactQuery("Contatti per partner?");
    expect(result.isContactQuery).toBe(true);
    expect(result.requestedFields.partner).toBe(true);
  });

  it("does not trigger on non-contact queries", () => {
    expect(detectContactQuery("Quali servizi offrite?").isContactQuery).toBe(false);
  });

  it("does not treat 'numero' alone as contact", () => {
    expect(detectContactQuery("numero di follower").isContactQuery).toBe(false);
  });

  it("treats 'numero di telefono' as contact", () => {
    expect(detectContactQuery("numero di telefono").isContactQuery).toBe(true);
  });

  it("does not trigger contact mode for email providers in addresses", () => {
    expect(
      detectContactQuery("Cosmin, acosmin.marica@gmail.com, 3342355347").isContactQuery
    ).toBe(false);
  });

  it("still detects standalone 'mail' requests", () => {
    expect(detectContactQuery("Mi dai la mail di contatto?").isContactQuery).toBe(
      true
    );
  });
});
