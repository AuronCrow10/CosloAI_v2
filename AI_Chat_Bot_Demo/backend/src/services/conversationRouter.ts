import { z } from "zod";
import { getChatCompletion } from "../openai/client";
import { ShoppingState } from "./shoppingStateService";

export type RouterResult = z.infer<typeof routerSchema>;

export const routerSchema = z.object({
  route: z.enum(["CONVERSE", "CLERK", "SUPPORT", "ORDER_STATUS", "TOOLS"]),
  language: z.enum(["en", "it", "es", "de", "fr", "unknown"]).default("unknown"),
  intent: z.enum([
    "BROWSE",
    "QUALIFY",
    "SELECT",
    "DETAILS",
    "COMPARE",
    "HESITATE",
    "FEEDBACK",
    "CHITCHAT",
    "SUPPORT",
    "OTHER"
  ]),
  confidence: z.number().min(0).max(1),
  should_fetch_catalog: z.boolean(),
  switch_product_type: z.boolean().default(false),
  selection: z
    .object({
      ordinal: z.number().int().min(1).max(10).nullable(),
      productId: z.string().nullable()
    })
    .default({ ordinal: null, productId: null }),
  notes: z.string().default("")
});

const FALLBACK: RouterResult = {
  route: "CONVERSE",
  language: "unknown",
  intent: "OTHER",
  confidence: 0,
  should_fetch_catalog: false,
  switch_product_type: false,
  selection: { ordinal: null, productId: null },
  notes: "fallback"
};

function buildRouterPayload(params: {
  message: string;
  state: ShoppingState;
  shopifyEnabled: boolean;
}) {
  const shortlist = params.state.shortlist.map((item) => ({
    productId: item.productId,
    title: item.title,
    priceMin: item.priceMin,
    priceMax: item.priceMax,
    currency: item.currency,
    attrSummary: item.attrSummary
  }));

  return {
    message: params.message,
    shopifyEnabled: params.shopifyEnabled,
    state: {
      language: params.state.language,
      mode: params.state.mode,
      activeProductType: params.state.activeProductType,
      lastIntent: params.state.lastIntent,
      lastRoute: params.state.lastRoute,
      hasShortlist: shortlist.length > 0,
      shortlist,
      detailsProductId: params.state.detailsProductId
    }
  };
}

function buildRouterSystemPrompt(): string {
  return [
    "You are a routing component for a Shopify sales assistant.",
    "Decide how to handle the user's message given the current shopping state.",
    "Return ONLY strict JSON that matches this schema:",
    "{\"route\":\"CONVERSE|CLERK|SUPPORT|ORDER_STATUS|TOOLS\",",
    "\"language\":\"en|it|es|de|fr|unknown\",",
    "\"intent\":\"BROWSE|QUALIFY|SELECT|DETAILS|COMPARE|HESITATE|FEEDBACK|CHITCHAT|SUPPORT|OTHER\",",
    "\"confidence\":0-1,",
    "\"should_fetch_catalog\":true|false,",
    "\"switch_product_type\":true|false,",
    "\"selection\":{\"ordinal\":1|2|3|null,\"productId\":string|null},",
    "\"notes\":\"short reason\"}",
    "Rules:",
    "- Always set language based on the user's message; if unclear, use 'unknown'.",
    "- If the user is indecisive, comparing, or giving feedback while a shortlist exists, route CONVERSE and should_fetch_catalog=false.",
    "- If the user selects an item from a shortlist, set intent=SELECT and include selection.ordinal or selection.productId; route CLERK.",
    "- If the user asks what the shop sells or general catalog info, set intent=BROWSE, route CONVERSE, should_fetch_catalog=false.",
    "- If the user explicitly requests a specific type of product (e.g., shoes) and Shopify is enabled, set intent=QUALIFY and route CLERK with should_fetch_catalog=true to show options.",
    "- If the user asks for recommendations without constraints and there is no shortlist, set intent=QUALIFY, route CONVERSE, should_fetch_catalog=false (ask a soft question).",
    "- If a shortlist already exists and the user provides an occasion/use-case (e.g., where/when they will use it), keep route CONVERSE and should_fetch_catalog=false (recommend among the existing shortlist).",
    "- If the user switches to a DIFFERENT product type than state.activeProductType, set switch_product_type=true, route CLERK, intent=QUALIFY, should_fetch_catalog=true.",
    "- If state.activeProductType is set and the user provides a short preference value (likely an attribute/option), set intent=QUALIFY and route CLERK with should_fetch_catalog=true.",
    "- If the user provides a constraint/attribute or occasion related to a product request, do NOT mark it as CHITCHAT.",
    "- If the user asks about support/order tracking/refunds, route SUPPORT or ORDER_STATUS.",
    "- If the user requests new options or provides new constraints, route CLERK and should_fetch_catalog=true.",
    "- Keep routing conservative and avoid unnecessary catalog fetches."
  ].join(" ");
}

function safeParse(raw: string): RouterResult | null {
  try {
    return routerSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function fallbackRoute(params: {
  shopifyEnabled: boolean;
  state: ShoppingState;
}): RouterResult {
  const language = params.state.language ?? "unknown";
  if (params.shopifyEnabled && params.state.shortlist.length === 0) {
    return {
      ...FALLBACK,
      language,
      route: "CLERK",
      intent: "BROWSE",
      should_fetch_catalog: true,
      notes: "fallback_no_shortlist"
    };
  }
  if (params.state.shortlist.length > 0) {
    return {
      ...FALLBACK,
      language,
      route: "CONVERSE",
      intent: "HESITATE",
      should_fetch_catalog: false,
      notes: "fallback_shortlist"
    };
  }
  return {
    ...FALLBACK,
    language
  };
}

export async function routeConversation(params: {
  botId: string;
  message: string;
  state: ShoppingState;
  shopifyEnabled: boolean;
}): Promise<RouterResult> {
  if (!params.shopifyEnabled) return FALLBACK;

  const payload = buildRouterPayload(params);
  const system = buildRouterSystemPrompt();

  const raw = await getChatCompletion({
    model: "gpt-4.1-mini",
    maxTokens: 140,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) }
    ],
    usageContext: {
      botId: params.botId,
      operation: "shopify_router"
    }
  });

  const parsed = safeParse(raw);
  if (parsed) return parsed;

  // Retry once with a stricter instruction if parse fails
  const retry = await getChatCompletion({
    model: "gpt-4.1-mini",
    maxTokens: 120,
    messages: [
      {
        role: "system",
        content:
          system +
          " STRICT MODE: Output ONLY JSON. No prose, no markdown, no trailing characters."
      },
      { role: "user", content: JSON.stringify(payload) }
    ],
    usageContext: {
      botId: params.botId,
      operation: "shopify_router_retry"
    }
  });

  const parsedRetry = safeParse(retry);
  return parsedRetry || fallbackRoute(params);
}
