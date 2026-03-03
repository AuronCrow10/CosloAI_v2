import { describe, expect, it, vi } from "vitest";

vi.mock("./revenueAIService", () => ({
  maybeBuildRevenueAIOffer: vi.fn().mockRejectedValue(new Error("boom"))
}));

import { safeMaybeBuildRevenueAIOffer } from "./revenueAISafe";

describe("revenueAISafe", () => {
  it("fails open when offer building throws", async () => {
    const result = await safeMaybeBuildRevenueAIOffer({
      botConfig: { botId: "b1", revenueAIEnabled: true } as any,
      conversationId: "c1",
      sessionId: "s1",
      userMessage: "hi",
      assistantReply: "reply"
    });
    expect(result).toBeNull();
  });
});
