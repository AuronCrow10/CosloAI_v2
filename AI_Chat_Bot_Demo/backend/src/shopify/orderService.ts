import { shopifyAdminGraphql } from "./client";
import { decryptAccessToken, getShopByDomain } from "./shopService";
import { ShopifyOrderLookupResult } from "./types";

const ORDER_LOOKUP_QUERY = `
  query OrderLookup($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        id
        name
        processedAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet {
          shopMoney { amount currencyCode }
        }
        lineItems(first: 50) {
          nodes {
            title
            quantity
            variant {
              id
              sku
            }
          }
        }
        fulfillments(first: 10) {
          nodes {
            status
            trackingInfo {
              company
              number
              url
            }
          }
        }
      }
    }
  }
`;

function buildOrderQueries(email: string, orderNumber: string): string[] {
  const cleanEmail = email.trim();
  const trimmed = orderNumber.trim();
  const rawNumber = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  const hashNumber = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;

  const queries: string[] = [];
  if (cleanEmail && hashNumber) {
    queries.push(`email:${cleanEmail} name:${hashNumber}`);
  }
  if (cleanEmail && rawNumber) {
    queries.push(`email:${cleanEmail} name:${rawNumber}`);
    queries.push(`email:${cleanEmail} order_number:${rawNumber}`);
  }

  return Array.from(new Set(queries));
}

export async function lookupOrderByEmailAndNumber(params: {
  shopDomain: string;
  email: string;
  orderNumber: string;
}): Promise<ShopifyOrderLookupResult | null> {
  const shop = await getShopByDomain(params.shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const accessToken = decryptAccessToken(shop);
  const queries = buildOrderQueries(params.email, params.orderNumber);
  let lastError: unknown = null;
  let order: any = null;

  for (const query of queries) {
    try {
      const data = await shopifyAdminGraphql<{
        orders: {
          nodes: Array<any>;
        };
      }>(params.shopDomain, accessToken, ORDER_LOOKUP_QUERY, { query });

      order = data.orders.nodes[0];
      if (order) break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!order) {
    if (lastError) throw lastError;
    return null;
  }

  return {
    orderId: order.id,
    orderName: order.name,
    status: order.displayFulfillmentStatus || "UNKNOWN",
    financialStatus: order.displayFinancialStatus || null,
    fulfillmentStatus: order.displayFulfillmentStatus || null,
    processedAt: order.processedAt || null,
    totalAmount: order.totalPriceSet?.shopMoney?.amount || null,
    currencyCode: order.totalPriceSet?.shopMoney?.currencyCode || null,
    fulfillments:
      order.fulfillments?.nodes?.map((f: any) => ({
        status: f.status || null,
        trackingCompany: f.trackingInfo?.[0]?.company || null,
        trackingNumber: f.trackingInfo?.[0]?.number || null,
        trackingUrl: f.trackingInfo?.[0]?.url || null
      })) || [],
    items:
      order.lineItems?.nodes?.map((item: any) => ({
        title: item.title,
        quantity: item.quantity,
        variantId: item.variant?.id || null,
        sku: item.variant?.sku || null
      })) || []
  };
}
