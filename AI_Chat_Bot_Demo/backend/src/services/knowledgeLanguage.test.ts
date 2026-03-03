import { describe, expect, it } from "vitest";
import { detectKnowledgeLanguage } from "./knowledgeLanguage";

describe("detectKnowledgeLanguage", () => {
  it("prefers locked language when present", async () => {
    const lang = await detectKnowledgeLanguage({
      message: "Hola",
      lockedLanguage: "it",
      routedLanguage: "es",
      allowLLM: false
    });
    expect(lang).toBe("it");
  });

  it("uses routed language when locked is missing", async () => {
    const lang = await detectKnowledgeLanguage({
      message: "Hello",
      lockedLanguage: null,
      routedLanguage: "es",
      allowLLM: false
    });
    expect(lang).toBe("es");
  });

  it("detects language from message when no hints", async () => {
    const lang = await detectKnowledgeLanguage({
      message: "Ciao, vorrei info",
      lockedLanguage: null,
      routedLanguage: null,
      allowLLM: false
    });
    expect(lang).toBe("it");
  });

  it("detects Italian question words", async () => {
    const lang = await detectKnowledgeLanguage({
      message: "Cosa sai?",
      lockedLanguage: null,
      routedLanguage: null,
      allowLLM: false
    });
    expect(lang).toBe("it");
  });
});
