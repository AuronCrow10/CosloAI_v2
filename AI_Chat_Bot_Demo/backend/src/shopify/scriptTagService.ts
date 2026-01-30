import { shopifyAdminGraphql } from "./client";
import { decryptAccessToken, getShopByDomain } from "./shopService";

const SCRIPT_TAG_LOOKUP_QUERY = `
  query ScriptTagsBySrc($src: URL!) {
    scriptTags(first: 1, src: $src) {
      nodes {
        id
        src
      }
    }
  }
`;

const SCRIPT_TAG_CREATE_MUTATION = `
  mutation ScriptTagCreate($input: ScriptTagInput!) {
    scriptTagCreate(input: $input) {
      scriptTag {
        id
        src
        displayScope
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function ensureWidgetScriptTag(shopDomain: string, scriptSrc: string) {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const accessToken = decryptAccessToken(shop);

  const existing = await shopifyAdminGraphql<{
    scriptTags: { nodes: Array<{ id: string; src: string }> };
  }>(shopDomain, accessToken, SCRIPT_TAG_LOOKUP_QUERY, {
    src: scriptSrc
  });

  if (existing.scriptTags.nodes.length > 0) {
    return existing.scriptTags.nodes[0];
  }

  const created = await shopifyAdminGraphql<{
    scriptTagCreate: {
      scriptTag: { id: string; src: string; displayScope: string } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(shopDomain, accessToken, SCRIPT_TAG_CREATE_MUTATION, {
    input: {
      src: scriptSrc,
      displayScope: "ONLINE_STORE"
    }
  });

  const errors = created.scriptTagCreate.userErrors || [];
  if (errors.length > 0) {
    throw new Error(
      `Shopify scriptTagCreate error: ${errors
        .map((e) => e.message)
        .join("; ")}`
    );
  }

  if (!created.scriptTagCreate.scriptTag) {
    throw new Error("Shopify scriptTagCreate returned no scriptTag");
  }

  return created.scriptTagCreate.scriptTag;
}
