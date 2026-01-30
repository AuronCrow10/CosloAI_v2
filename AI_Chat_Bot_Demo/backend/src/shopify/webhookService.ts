import { shopifyAdminGraphql } from "./client";
import { config } from "../config";
import { decryptAccessToken, getShopByDomain } from "./shopService";

type WebhookRegistration = {
  topic: string;
  address: string;
  graphqlTopic: WebhookGraphqlTopic;
};

type WebhookGraphqlTopic =
  | "APP_UNINSTALLED"
  | "PRODUCTS_UPDATE"
  | "PRODUCTS_DELETE"
  | "INVENTORY_LEVELS_UPDATE"
  | "ORDERS_CREATE"
  | "CUSTOMERS_DATA_REQUEST"
  | "CUSTOMERS_REDACT"
  | "SHOP_REDACT";

const COMPLIANCE_WEBHOOKS: WebhookRegistration[] = [
  {
    topic: "customers/data_request",
    address: "/api/shopify/webhooks/customers/data_request",
    graphqlTopic: "CUSTOMERS_DATA_REQUEST"
  },
  {
    topic: "customers/redact",
    address: "/api/shopify/webhooks/customers/redact",
    graphqlTopic: "CUSTOMERS_REDACT"
  },
  {
    topic: "shop/redact",
    address: "/api/shopify/webhooks/shop/redact",
    graphqlTopic: "SHOP_REDACT"
  }
];

const WEBHOOK_TOPICS: WebhookRegistration[] = [
  {
    topic: "app/uninstalled",
    address: "/api/shopify/webhooks/app-uninstalled",
    graphqlTopic: "APP_UNINSTALLED"
  },
  {
    topic: "products/update",
    address: "/api/shopify/webhooks/products-update",
    graphqlTopic: "PRODUCTS_UPDATE"
  },
  {
    topic: "products/delete",
    address: "/api/shopify/webhooks/products-delete",
    graphqlTopic: "PRODUCTS_DELETE"
  },
  {
    topic: "inventory_levels/update",
    address: "/api/shopify/webhooks/inventory-update",
    graphqlTopic: "INVENTORY_LEVELS_UPDATE"
  },
  {
    topic: "orders/create",
    address: "/api/shopify/webhooks/orders-create",
    graphqlTopic: "ORDERS_CREATE"
  }
];

const TOPIC_SCOPE_REQUIREMENTS: Record<string, string | null> = {
  "app/uninstalled": null,
  "products/update": "read_products",
  "products/delete": "read_products",
  "inventory_levels/update": "read_inventory",
  "orders/create": "read_orders",
  "customers/data_request": null,
  "customers/redact": null,
  "shop/redact": null
};

const WEBHOOKS_LOOKUP_QUERY = `
  query WebhookSubscriptionsByTopic($topics: [WebhookSubscriptionTopic!]) {
    webhookSubscriptions(first: 250, topics: $topics) {
      nodes {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
      }
    }
  }
`;

const WEBHOOK_CREATE_MUTATION = `
  mutation WebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function registerShopifyWebhooks(shopDomain: string) {
  if (!config.shopifyAppUrl) {
    throw new Error("SHOPIFY_APP_URL not configured");
  }
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");

  const accessToken = decryptAccessToken(shop);
  const scopeSet = new Set(
    (shop.scopes || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const registrations = [...WEBHOOK_TOPICS];
  if (config.shopifyRegisterComplianceWebhooks) {
    registrations.push(...COMPLIANCE_WEBHOOKS);
  } else {
    if (COMPLIANCE_WEBHOOKS.length > 0) {
      console.warn(
        "Skipping compliance webhooks registration; configure customers/data_request, customers/redact, and shop/redact via Shopify app settings or CLI (set SHOPIFY_REGISTER_COMPLIANCE_WEBHOOKS=true to attempt API registration)."
      );
    }
  }

  const topicList = Array.from(
    new Set(registrations.map((w) => w.graphqlTopic))
  );
  const existing = await shopifyAdminGraphql<{
    webhookSubscriptions: {
      nodes: Array<{
        id: string;
        topic: string;
        endpoint:
          | { __typename: "WebhookHttpEndpoint"; callbackUrl: string }
          | { __typename: string }
          | null;
      }>;
    };
  }>(shopDomain, accessToken, WEBHOOKS_LOOKUP_QUERY, {
    topics: topicList
  });

  for (const webhook of registrations) {
    const requiredScope = TOPIC_SCOPE_REQUIREMENTS[webhook.topic] || null;
    if (requiredScope && !scopeSet.has(requiredScope)) {
      continue;
    }
    const address = `${config.shopifyAppUrl}${webhook.address}`;
    const already = existing.webhookSubscriptions.nodes.find(
      (w) =>
        w.topic === webhook.graphqlTopic &&
        w.endpoint?.__typename === "WebhookHttpEndpoint" &&
        (w.endpoint as { callbackUrl: string }).callbackUrl === address
    );
    if (already) continue;

    try {
      const created = await shopifyAdminGraphql<{
        webhookSubscriptionCreate: {
          webhookSubscription: { id: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(shopDomain, accessToken, WEBHOOK_CREATE_MUTATION, {
        topic: webhook.graphqlTopic,
        webhookSubscription: {
          callbackUrl: address,
          format: "JSON"
        }
      });

      const errors = created.webhookSubscriptionCreate.userErrors || [];
      if (errors.length > 0) {
        throw new Error(errors.map((e) => e.message).join("; "));
      }
    } catch (err: any) {
      const errData = err?.response?.data || err?.message || err;
      console.warn("Failed to register Shopify webhook", {
        shopDomain,
        topic: webhook.topic,
        error: errData
      });
    }
  }
}
