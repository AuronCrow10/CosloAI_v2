// services/knowledgeUsageService.ts

import { config } from "../config";

export type KnowledgeUsageByModel = {
  model: string;
  promptTokens: number;
  totalTokens: number;
};

export type KnowledgeUsageByOperation = {
  operation: string;
  promptTokens: number;
  totalTokens: number;
};

export type KnowledgeUsageSummary = {
  clientId: string;
  totalPromptTokens: number;
  totalTokens: number;
  byModel: KnowledgeUsageByModel[];
  byOperation: KnowledgeUsageByOperation[];
};

/**
 * Fetch usage from the Knowledge (crawler) backend for a given clientId.
 * - from / to are optional Date filters
 * - if both are null and period === "month", backend will return current month
 */
export async function fetchKnowledgeUsageForClient(params: {
  clientId: string;
  from?: Date | null;
  to?: Date | null;
  period?: "month";
}): Promise<KnowledgeUsageSummary | null> {
  const { clientId, from, to, period } = params;

  const baseUrl = config.knowledgeBaseUrl.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/usage`);

  url.searchParams.set("clientId", clientId);

  if (from) {
    url.searchParams.set("from", from.toISOString());
  }
  if (to) {
    url.searchParams.set("to", to.toISOString());
  }
  if (!from && !to && period === "month") {
    url.searchParams.set("period", "month");
  }

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": config.knowledgeInternalToken
      }
    });

    if (!res.ok) {
      console.error(
        "Failed to fetch knowledge usage",
        res.status,
        await res.text()
      );
      return null;
    }

    const data = (await res.json()) as KnowledgeUsageSummary;
    return data;
  } catch (err) {
    console.error("Error calling knowledge usage endpoint:", err);
    return null;
  }
}
