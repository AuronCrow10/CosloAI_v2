export type SessionImpactCounts = {
  sessions: number;
  addToCartSessions: number;
  checkoutSessions: number;
  purchaseSessions: number;
  revenueCents: number;
  purchaseCount: number;
};

export type SessionImpactMetrics = SessionImpactCounts & {
  addToCartRate: number;
  checkoutRate: number;
  purchaseRate: number;
  aovCents: number;
};

export type SessionImpactUplift = {
  addToCartRate: number;
  checkoutRate: number;
  purchaseRate: number;
  aovCents: number;
};

export type ProductFunnelRow = {
  product_id: string | null;
  title: string | null;
  image_url: string | null;
  impressions: number;
  clicks: number;
  add_to_cart: number;
  checkout: number;
  purchases: number;
  revenue_cents: number;
};

export type ProductFunnelMetrics = {
  productId: string;
  title: string | null;
  imageUrl: string | null;
  impressions: number;
  clicks: number;
  addToCart: number;
  checkout: number;
  purchases: number;
  revenueCents: number;
  rates: {
    ctr: number;
    atcRate: number;
    checkoutRate: number;
    purchaseRate: number;
  };
};

const ratePct = (numerator: number, denominator: number): number => {
  if (!denominator || denominator <= 0) return 0;
  return (numerator / denominator) * 100;
};

export function computeSessionImpactMetrics(
  counts: SessionImpactCounts
): SessionImpactMetrics {
  const addToCartRate = ratePct(counts.addToCartSessions, counts.sessions);
  const checkoutRate = ratePct(counts.checkoutSessions, counts.sessions);
  const purchaseRate = ratePct(counts.purchaseSessions, counts.sessions);
  const aovCents = counts.purchaseCount > 0
    ? Math.round(counts.revenueCents / counts.purchaseCount)
    : 0;

  return {
    ...counts,
    addToCartRate,
    checkoutRate,
    purchaseRate,
    aovCents
  };
}

export function computeSessionImpactUplift(
  withOffer: SessionImpactMetrics,
  withoutOffer: SessionImpactMetrics
): SessionImpactUplift {
  return {
    addToCartRate: withOffer.addToCartRate - withoutOffer.addToCartRate,
    checkoutRate: withOffer.checkoutRate - withoutOffer.checkoutRate,
    purchaseRate: withOffer.purchaseRate - withoutOffer.purchaseRate,
    aovCents: withOffer.aovCents - withoutOffer.aovCents
  };
}

export function buildSessionImpactFromRows(rows: Array<{
  group_key: string;
  sessions: number;
  add_to_cart_sessions: number;
  checkout_sessions: number;
  purchase_sessions: number;
  revenue_cents: number;
  purchase_count: number;
}>) {
  const impactMap = new Map<boolean, SessionImpactCounts>();
  rows.forEach((row) => {
    impactMap.set(row.group_key === "with_offer", {
      sessions: row.sessions || 0,
      addToCartSessions: row.add_to_cart_sessions || 0,
      checkoutSessions: row.checkout_sessions || 0,
      purchaseSessions: row.purchase_sessions || 0,
      revenueCents: row.revenue_cents || 0,
      purchaseCount: row.purchase_count || 0
    });
  });

  const withOffer = computeSessionImpactMetrics(
    impactMap.get(true) || {
      sessions: 0,
      addToCartSessions: 0,
      checkoutSessions: 0,
      purchaseSessions: 0,
      revenueCents: 0,
      purchaseCount: 0
    }
  );

  const withoutOffer = computeSessionImpactMetrics(
    impactMap.get(false) || {
      sessions: 0,
      addToCartSessions: 0,
      checkoutSessions: 0,
      purchaseSessions: 0,
      revenueCents: 0,
      purchaseCount: 0
    }
  );

  return {
    withOffer,
    withoutOffer,
    uplift: computeSessionImpactUplift(withOffer, withoutOffer)
  };
}

export function buildProductFunnels(
  rows: ProductFunnelRow[]
): ProductFunnelMetrics[] {
  const funnels = rows
    .filter((row) => !!row.product_id)
    .map((row) => {
      const impressions = row.impressions || 0;
      const clicks = row.clicks || 0;
      const addToCart = row.add_to_cart || 0;
      const checkout = row.checkout || 0;
      const purchases = row.purchases || 0;
      const revenueCents = row.revenue_cents || 0;

      return {
        productId: row.product_id as string,
        title: row.title ?? null,
        imageUrl: row.image_url ?? null,
        impressions,
        clicks,
        addToCart,
        checkout,
        purchases,
        revenueCents,
        rates: {
          ctr: ratePct(clicks, impressions),
          atcRate: ratePct(addToCart, impressions),
          checkoutRate: ratePct(checkout, addToCart),
          purchaseRate: ratePct(purchases, checkout)
        }
      };
    });

  funnels.sort((a, b) => {
    if (b.revenueCents !== a.revenueCents) {
      return b.revenueCents - a.revenueCents;
    }
    if (b.rates.atcRate !== a.rates.atcRate) {
      return b.rates.atcRate - a.rates.atcRate;
    }
    return b.impressions - a.impressions;
  });

  return funnels;
}

export function computeStyleRates(params: {
  impressions: number;
  clicks: number;
  addToCart: number;
  checkout: number;
  purchases: number;
}) {
  return {
    ctr: ratePct(params.clicks, params.impressions),
    atcRate: ratePct(params.addToCart, params.impressions),
    checkoutRate: ratePct(params.checkout, params.addToCart),
    purchaseRate: ratePct(params.purchases, params.checkout)
  };
}
