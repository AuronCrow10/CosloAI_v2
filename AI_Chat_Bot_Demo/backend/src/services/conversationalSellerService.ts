import { getChatCompletion } from "../openai/client";
import { RouterResult } from "./conversationRouter";
import { ShoppingState } from "./shoppingStateService";

type ConversationalSellerParams = {
  botId: string;
  message: string;
  state: ShoppingState;
  router: RouterResult | null;
  catalogSummary?: {
    summary: string;
    categories: string[];
  } | null;
};

function buildSystemPrompt(params: {
  language: string | null;
  hasShortlist: boolean;
  hasCatalogSummary: boolean;
}): string {
  const languageNote =
    params.language === "it"
      ? "Rispondi in italiano."
      : params.language === "es"
        ? "Responde en espanol."
        : params.language === "de"
          ? "Antworte auf Deutsch."
          : params.language === "fr"
            ? "Reponds en francais."
            : "Respond in English.";

  return [
    "You are a helpful, human sales assistant for an ecommerce shop.",
    languageNote,
    "Follow these rules:",
    "- Use ONLY the provided shortlist data for product comparisons or recommendations.",
    "- Do NOT invent product attributes, prices, or availability.",
    "- If the user is hesitant or comparing, recommend one option and explain why using the provided data.",
    "- Ask at most ONE soft question (occasion, style, fit, budget) if it helps, but avoid interrogating.",
    "- Do not re-list the full shortlist unless the user asks for it.",
    "- If the user sounds frustrated or says you misunderstood, apologize briefly and refocus on their latest request.",
    "- If the user changes what they want (a different product type), acknowledge the switch and ask a concise follow-up.",
    params.hasCatalogSummary
      ? "- If the user asks what the shop sells, summarize the catalog from the provided summary/categories."
      : "- If catalog context is missing, ask what they are looking for in a friendly way.",
    params.hasShortlist
      ? "- Keep the response concise and focused on helping them choose among current options."
      : "- Keep the response concise and help discover what they want."
  ].join(" ");
}

export async function generateConversationalSellerReply(
  params: ConversationalSellerParams
): Promise<string> {
  const shortlist = params.state.shortlist || [];
  const catalogSummary = params.catalogSummary;

  const system = buildSystemPrompt({
    language: params.state.language,
    hasShortlist: shortlist.length > 0,
    hasCatalogSummary: !!catalogSummary
  });

  const payload = {
    message: params.message,
    intent: params.router?.intent ?? null,
    shortlist: shortlist.map((item) => ({
      productId: item.productId,
      title: item.title,
      priceMin: item.priceMin,
      priceMax: item.priceMax,
      currency: item.currency,
      attrSummary: item.attrSummary
    })),
    catalogSummary: catalogSummary
      ? {
          summary: catalogSummary.summary,
          categories: catalogSummary.categories
        }
      : null,
    activeProductType: params.state.activeProductType
  };

  try {
    const reply = await getChatCompletion({
      model: "gpt-4.1-mini",
      maxTokens: 220,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) }
      ],
      usageContext: {
        botId: params.botId,
        operation: "shopify_conversational_seller"
      }
    });

    return reply.trim() || fallbackReply(params);
  } catch {
    return fallbackReply(params);
  }
}

function fallbackReply(params: ConversationalSellerParams): string {
  const lang = params.state.language || "en";
  const hasShortlist = params.state.shortlist.length > 0;

  if (hasShortlist) {
    if (lang === "it") {
      return "Posso aiutarti a scegliere tra queste opzioni. Cosa conta di piu per te: stile, occasione o comfort?";
    }
    if (lang === "es") {
      return "Puedo ayudarte a elegir entre estas opciones. ¿Qué te importa más: estilo, ocasión o comodidad?";
    }
    if (lang === "de") {
      return "Ich kann dir helfen, zwischen diesen Optionen zu wählen. Was ist dir wichtiger: Stil, Anlass oder Komfort?";
    }
    if (lang === "fr") {
      return "Je peux t'aider a choisir parmi ces options. Qu'est-ce qui compte le plus pour toi : style, occasion ou confort ?";
    }
    return "I can help you choose among these options. What matters most to you: style, occasion, or comfort?";
  }

  if (lang === "it") {
    return "Certo. Che tipo di prodotto stai cercando o per quale occasione?";
  }
  if (lang === "es") {
    return "Claro. ¿Qué tipo de producto buscas o para qué ocasión?";
  }
  if (lang === "de") {
    return "Klar. Nach welchem Produkttyp suchst du oder für welchen Anlass?";
  }
  if (lang === "fr") {
    return "Bien sûr. Quel type de produit cherches-tu ou pour quelle occasion ?";
  }
  return "Sure. What kind of product are you looking for or what occasion is it for?";
}
