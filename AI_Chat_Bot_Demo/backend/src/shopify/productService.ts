import { Prisma } from "@prisma/client";
import { prisma } from "../prisma/prisma";
import { shopifyAdminGraphql } from "./client";
import { decryptAccessToken, getShopByDomain } from "./shopService";
import { ShopifyProductSummary } from "./types";

type ShopifyVariantNode = {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  createdAt: string;
  updatedAt: string;
  image: { url: string } | null;
  selectedOptions: Array<{ name: string; value: string }>;
};

type ShopifyProductNode = {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  status: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  featuredImage: { url: string } | null;
  priceRangeV2: {
    minVariantPrice: { amount: string };
    maxVariantPrice: { amount: string };
  };
};

const PRODUCTS_QUERY = `
  query Products($cursor: String) {
    shop {
      currencyCode
    }
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        descriptionHtml
        vendor
        productType
        status
        tags
        createdAt
        updatedAt
        publishedAt
        featuredImage { url }
        priceRangeV2 {
          minVariantPrice { amount }
          maxVariantPrice { amount }
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `
  query ProductVariants($id: ID!, $cursor: String) {
    product(id: $id) {
      variants(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          sku
          price
          compareAtPrice
          availableForSale
          inventoryQuantity
          createdAt
          updatedAt
          image { url }
          selectedOptions { name value }
        }
      }
    }
  }
`;

async function fetchAllVariants(
  shopDomain: string,
  accessToken: string,
  productId: string
): Promise<ShopifyVariantNode[]> {
  let cursor: string | null = null;
  let hasNext = true;
  const variants: ShopifyVariantNode[] = [];

  while (hasNext) {
    const data: {
      product: {
        variants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ShopifyVariantNode[];
        };
      } | null;
    } = await shopifyAdminGraphql<{
      product: {
        variants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ShopifyVariantNode[];
        };
      } | null;
    }>(shopDomain, accessToken, PRODUCT_VARIANTS_QUERY, {
      id: productId,
      cursor
    });

    const page: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ShopifyVariantNode[];
    } | undefined = data.product?.variants;
    if (!page) break;
    variants.push(...page.nodes);
    hasNext = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return variants;
}

export async function syncShopifyProducts(shopDomain: string) {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const accessToken = decryptAccessToken(shop);

  let cursor: string | null = null;
  let hasNext = true;
  let shopCurrency: string | null = null;
  let syncedCount = 0;

  while (hasNext) {
    const data: {
      shop: { currencyCode: string };
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyProductNode[];
      };
    } = await shopifyAdminGraphql<{
      shop: { currencyCode: string };
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyProductNode[];
      };
    }>(shopDomain, accessToken, PRODUCTS_QUERY, { cursor });

    if (!shopCurrency) {
      shopCurrency = data.shop.currencyCode || null;
    }

    for (const product of data.products.nodes) {
      const productRecord = await prisma.shopifyProduct.upsert({
        where: {
          shopId_productId: {
            shopId: shop.id,
            productId: product.id
          }
        },
        update: {
          title: product.title,
          handle: product.handle,
          bodyHtml: product.descriptionHtml,
          vendor: product.vendor,
          productType: product.productType,
          status: product.status,
          tags: product.tags,
          publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
          shopifyCreatedAt: new Date(product.createdAt),
          shopifyUpdatedAt: new Date(product.updatedAt),
          imageUrl: product.featuredImage?.url || null,
          priceMin: new Prisma.Decimal(product.priceRangeV2.minVariantPrice.amount),
          priceMax: new Prisma.Decimal(product.priceRangeV2.maxVariantPrice.amount),
          updatedAt: new Date()
        },
        create: {
          shopId: shop.id,
          productId: product.id,
          title: product.title,
          handle: product.handle,
          bodyHtml: product.descriptionHtml,
          vendor: product.vendor,
          productType: product.productType,
          status: product.status,
          tags: product.tags,
          publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
          shopifyCreatedAt: new Date(product.createdAt),
          shopifyUpdatedAt: new Date(product.updatedAt),
          imageUrl: product.featuredImage?.url || null,
          priceMin: new Prisma.Decimal(product.priceRangeV2.minVariantPrice.amount),
          priceMax: new Prisma.Decimal(product.priceRangeV2.maxVariantPrice.amount)
        }
      });

      const variants = await fetchAllVariants(shopDomain, accessToken, product.id);
      const variantIds = variants.map((variant) => variant.id);

      for (const variant of variants) {
        await prisma.shopifyVariant.upsert({
          where: {
            shopId_variantId: {
              shopId: shop.id,
              variantId: variant.id
            }
          },
          update: {
            productDbId: productRecord.id,
            title: variant.title,
            sku: variant.sku,
            price: new Prisma.Decimal(variant.price),
            compareAtPrice: variant.compareAtPrice
              ? new Prisma.Decimal(variant.compareAtPrice)
              : null,
            availableForSale: variant.availableForSale,
            inventoryQuantity: variant.inventoryQuantity,
            imageUrl: variant.image?.url || null,
            selectedOptions: variant.selectedOptions,
            shopifyCreatedAt: new Date(variant.createdAt),
            shopifyUpdatedAt: new Date(variant.updatedAt),
            updatedAt: new Date()
          },
          create: {
            shopId: shop.id,
            productDbId: productRecord.id,
            variantId: variant.id,
            title: variant.title,
            sku: variant.sku,
            price: new Prisma.Decimal(variant.price),
            compareAtPrice: variant.compareAtPrice
              ? new Prisma.Decimal(variant.compareAtPrice)
              : null,
            availableForSale: variant.availableForSale,
            inventoryQuantity: variant.inventoryQuantity,
            imageUrl: variant.image?.url || null,
            selectedOptions: variant.selectedOptions,
            shopifyCreatedAt: new Date(variant.createdAt),
            shopifyUpdatedAt: new Date(variant.updatedAt)
          }
        });
      }

      if (variantIds.length > 0) {
        await prisma.shopifyVariant.deleteMany({
          where: {
            shopId: shop.id,
            productDbId: productRecord.id,
            variantId: { notIn: variantIds }
          }
        });
      }

      syncedCount += 1;
    }

    hasNext = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  await prisma.shopifyShop.update({
    where: { id: shop.id },
    data: {
      lastProductsSyncAt: new Date(),
      shopCurrency: shopCurrency ?? shop.shopCurrency
    }
  });

  return { syncedCount, shopCurrency };
}

function toShopifyProductGid(productId: string | number) {
  if (String(productId).startsWith("gid://")) {
    return String(productId);
  }
  return `gid://shopify/Product/${productId}`;
}

function toShopifyVariantGid(variantId: string | number) {
  if (String(variantId).startsWith("gid://")) {
    return String(variantId);
  }
  return `gid://shopify/ProductVariant/${variantId}`;
}

const PRODUCT_BY_ID_QUERY = `
  query ProductById($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      vendor
      productType
      status
      tags
      createdAt
      updatedAt
      publishedAt
      featuredImage { url }
      priceRangeV2 {
        minVariantPrice { amount }
        maxVariantPrice { amount }
      }
    }
  }
`;

export async function syncShopifyProductById(
  shopDomain: string,
  productId: string | number
) {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const accessToken = decryptAccessToken(shop);
  const productGid = toShopifyProductGid(productId);

  const data: {
    product: ShopifyProductNode | null;
  } = await shopifyAdminGraphql<{
    product: ShopifyProductNode | null;
  }>(shopDomain, accessToken, PRODUCT_BY_ID_QUERY, { id: productGid });

  if (!data.product) {
    return null;
  }

  const product = data.product;
  const productRecord = await prisma.shopifyProduct.upsert({
    where: {
      shopId_productId: {
        shopId: shop.id,
        productId: product.id
      }
    },
    update: {
      title: product.title,
      handle: product.handle,
      bodyHtml: product.descriptionHtml,
      vendor: product.vendor,
      productType: product.productType,
      status: product.status,
      tags: product.tags,
      publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
      shopifyCreatedAt: new Date(product.createdAt),
      shopifyUpdatedAt: new Date(product.updatedAt),
      imageUrl: product.featuredImage?.url || null,
      priceMin: new Prisma.Decimal(product.priceRangeV2.minVariantPrice.amount),
      priceMax: new Prisma.Decimal(product.priceRangeV2.maxVariantPrice.amount),
      updatedAt: new Date()
    },
    create: {
      shopId: shop.id,
      productId: product.id,
      title: product.title,
      handle: product.handle,
      bodyHtml: product.descriptionHtml,
      vendor: product.vendor,
      productType: product.productType,
      status: product.status,
      tags: product.tags,
      publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
      shopifyCreatedAt: new Date(product.createdAt),
      shopifyUpdatedAt: new Date(product.updatedAt),
      imageUrl: product.featuredImage?.url || null,
      priceMin: new Prisma.Decimal(product.priceRangeV2.minVariantPrice.amount),
      priceMax: new Prisma.Decimal(product.priceRangeV2.maxVariantPrice.amount)
    }
  });

  const variants = await fetchAllVariants(shopDomain, accessToken, product.id);
  const variantIds = variants.map((variant) => variant.id);

  for (const variant of variants) {
    await prisma.shopifyVariant.upsert({
      where: {
        shopId_variantId: {
          shopId: shop.id,
          variantId: variant.id
        }
      },
      update: {
        productDbId: productRecord.id,
        title: variant.title,
        sku: variant.sku,
        price: new Prisma.Decimal(variant.price),
        compareAtPrice: variant.compareAtPrice
          ? new Prisma.Decimal(variant.compareAtPrice)
          : null,
        availableForSale: variant.availableForSale,
        inventoryQuantity: variant.inventoryQuantity,
        imageUrl: variant.image?.url || null,
        selectedOptions: variant.selectedOptions,
        shopifyCreatedAt: new Date(variant.createdAt),
        shopifyUpdatedAt: new Date(variant.updatedAt),
        updatedAt: new Date()
      },
      create: {
        shopId: shop.id,
        productDbId: productRecord.id,
        variantId: variant.id,
        title: variant.title,
        sku: variant.sku,
        price: new Prisma.Decimal(variant.price),
        compareAtPrice: variant.compareAtPrice
          ? new Prisma.Decimal(variant.compareAtPrice)
          : null,
        availableForSale: variant.availableForSale,
        inventoryQuantity: variant.inventoryQuantity,
        imageUrl: variant.image?.url || null,
        selectedOptions: variant.selectedOptions,
        shopifyCreatedAt: new Date(variant.createdAt),
        shopifyUpdatedAt: new Date(variant.updatedAt)
      }
    });
  }

  if (variantIds.length > 0) {
    await prisma.shopifyVariant.deleteMany({
      where: {
        shopId: shop.id,
        productDbId: productRecord.id,
        variantId: { notIn: variantIds }
      }
    });
  }

  return productRecord;
}

export async function deleteShopifyProductById(
  shopDomain: string,
  productId: string | number
) {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const productGid = toShopifyProductGid(productId);
  await prisma.shopifyProduct.deleteMany({
    where: { shopId: shop.id, productId: productGid }
  });
}

const INVENTORY_ITEM_QUERY = `
  query InventoryItem($id: ID!) {
    inventoryItem(id: $id) {
      id
      variant { id }
    }
  }
`;

export async function updateVariantInventoryFromItem(params: {
  shopDomain: string;
  inventoryItemId: string | number;
  available: number;
}) {
  const shop = await getShopByDomain(params.shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const accessToken = decryptAccessToken(shop);
  const inventoryGid = params.inventoryItemId.toString().startsWith("gid://")
    ? String(params.inventoryItemId)
    : `gid://shopify/InventoryItem/${params.inventoryItemId}`;

  const data: {
    inventoryItem: { variant: { id: string } | null } | null;
  } = await shopifyAdminGraphql<{
    inventoryItem: { variant: { id: string } | null } | null;
  }>(params.shopDomain, accessToken, INVENTORY_ITEM_QUERY, {
    id: inventoryGid
  });

  const variantGid = data.inventoryItem?.variant?.id;
  if (!variantGid) return;

  await prisma.shopifyVariant.updateMany({
    where: { shopId: shop.id, variantId: toShopifyVariantGid(variantGid) },
    data: {
      inventoryQuantity: params.available,
      availableForSale: params.available > 0,
      updatedAt: new Date()
    }
  });
}

export async function searchShopifyProducts(
  shopDomain: string,
  params: {
    query?: string;
    priceMin?: number;
    priceMax?: number;
    limit?: number;
    cursor?: number;
    status?: string;
  }
): Promise<{ items: ShopifyProductSummary[]; nextCursor: number | null }> {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  const limit = Math.min(Math.max(params.limit || 20, 1), 100);
  const offset = params.cursor || 0;

  const filters: Prisma.Sql[] = [Prisma.sql`p."shopId" = ${shop.id}`];

  if (params.status) {
    filters.push(Prisma.sql`p."status" = ${params.status}`);
  }

  if (params.priceMin != null) {
    filters.push(Prisma.sql`p."priceMax" >= ${params.priceMin}`);
  }

  if (params.priceMax != null) {
    filters.push(Prisma.sql`p."priceMin" <= ${params.priceMax}`);
  }

  if (params.query && params.query.trim()) {
    filters.push(
      Prisma.sql`p."searchVector" @@ plainto_tsquery('simple', ${params.query.trim()})`
    );
  }

  const whereSql = Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`;

  const rows = await prisma.$queryRaw<ShopifyProductSummary[]>(Prisma.sql`
    SELECT
      p."id",
      p."productId",
      p."title",
      p."handle",
      p."vendor",
      p."productType",
      p."status",
      p."tags",
      p."imageUrl",
      p."priceMin",
      p."priceMax"
    FROM "ShopifyProduct" p
    ${whereSql}
    ORDER BY p."updatedAt" DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const nextCursor = rows.length === limit ? offset + limit : null;
  return { items: rows, nextCursor };
}

export async function getShopifyProductById(
  shopDomain: string,
  productId: string
) {
  const shop = await getShopByDomain(shopDomain);
  if (!shop) throw new Error("Shop not found");
  if (!shop.isActive) throw new Error("Shop is not active");

  return prisma.shopifyProduct.findFirst({
    where: { shopId: shop.id, productId },
    include: { variants: true }
  });
}
