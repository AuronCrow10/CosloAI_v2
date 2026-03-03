import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/prisma", () => ({
  prisma: {
    $executeRaw: vi.fn()
  }
}));

import { prisma } from "../prisma/prisma";
import { trackRevenueAIAction } from "./revenueAIService";

describe("trackRevenueAIAction idempotency", () => {
  it("returns deduped=true when insert is skipped", async () => {
    (prisma.$executeRaw as any)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    const base = {
      eventId: "e1",
      botId: "b1",
      conversationId: "c1",
      action: "CLICK" as const,
      idempotencyKey: "key1"
    };

    const first = await trackRevenueAIAction(base);
    const second = await trackRevenueAIAction(base);

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
  });
});
