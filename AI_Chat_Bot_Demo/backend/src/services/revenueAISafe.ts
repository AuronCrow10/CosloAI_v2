import { maybeBuildRevenueAIOffer } from "./revenueAIService";

export async function safeMaybeBuildRevenueAIOffer(
  params: Parameters<typeof maybeBuildRevenueAIOffer>[0]
): Promise<Awaited<ReturnType<typeof maybeBuildRevenueAIOffer>> | null> {
  try {
    return await maybeBuildRevenueAIOffer(params);
  } catch (err) {
    console.error("Revenue AI offer failed (fail-open)", {
      botId: params.botConfig?.botId,
      conversationId: params.conversationId,
      error: err
    });
    return null;
  }
}
