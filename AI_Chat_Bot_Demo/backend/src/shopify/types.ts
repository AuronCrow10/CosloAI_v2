export type ShopifyShopStatus = "installed" | "uninstalled";

export type ShopifyProductSummary = {
  id: string;
  productId: string;
  title: string;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  tags: string[];
  imageUrl: string | null;
  priceMin: string | null;
  priceMax: string | null;
};

export type ShopifyVariantSummary = {
  id: string;
  variantId: string;
  title: string | null;
  sku: string | null;
  price: string | null;
  compareAtPrice: string | null;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  imageUrl: string | null;
  selectedOptions: Record<string, string>[];
};

export type ShopifyCartLineInput = {
  variantId: string;
  quantity: number;
  action?: "add" | "set" | "remove";
};

export type ShopifyOrderLookupResult = {
  orderId: string;
  orderName: string;
  status: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  processedAt: string | null;
  totalAmount: string | null;
  currencyCode: string | null;
  fulfillments: Array<{
    status: string | null;
    trackingCompany: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
  }>;
  items: Array<{
    title: string;
    quantity: number;
    variantId: string | null;
    sku: string | null;
  }>;
};
