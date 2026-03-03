export type CandidateProduct = {
  id: string;
  productId: string;
  handle?: string | null;
  title: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  priceMin: number | null;
  variant: {
    variantId: string;
    price: number | null;
    compareAtPrice: number | null;
    availableForSale: boolean;
    inventoryQuantity: number | null;
    imageUrl: string | null;
  };
};

export type PerformanceStats = {
  impressions: number;
  clicks: number;
  addToCart: number;
};

export type ComplementMap = {
  productType?: Record<string, string[]>;
  tags?: Record<string, string[]>;
  vendor?: Record<string, string[]>;
};

export type RankingConfig = {
  upsellDeltaMinPct: number;
  upsellDeltaMaxPct: number;
  aggressiveness: number;
  maxRecommendations: number;
  complementMap?: ComplementMap | null;
};

export type RankedCandidate = CandidateProduct & {
  score: number;
  breakdown: {
    similarity: number;
    inventory: number;
    price: number;
    performance: number;
    diversityPenalty: number;
  };
};

export function isVariantAvailable(variant: {
  availableForSale: boolean;
  inventoryQuantity: number | null;
}): boolean {
  if (!variant.availableForSale) return false;
  if (variant.inventoryQuantity == null) return true;
  return variant.inventoryQuantity > 0;
}

export function filterAvailableCandidates(candidates: CandidateProduct[]): CandidateProduct[] {
  return candidates.filter((c) => isVariantAvailable(c.variant));
}

export function filterExcludedCandidates(params: {
  candidates: CandidateProduct[];
  excludeProductIds?: Set<string>;
  excludeHandles?: Set<string>;
  excludeVariantIds?: Set<string>;
}): CandidateProduct[] {
  const {
    candidates,
    excludeProductIds,
    excludeHandles,
    excludeVariantIds
  } = params;
  return candidates.filter((c) => {
    if (excludeProductIds && excludeProductIds.has(c.productId)) return false;
    if (excludeHandles && c.handle && excludeHandles.has(c.handle.toLowerCase())) return false;
    if (excludeVariantIds && excludeVariantIds.has(c.variant.variantId)) return false;
    return true;
  });
}

const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));

function normalizeTags(tags: string[] | null | undefined): string[] {
  if (!tags) return [];
  return tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function buildComplementSet(base: {
  productType?: string | null;
  vendor?: string | null;
  tags?: string[];
}, complementMap?: ComplementMap | null): { types: Set<string>; tags: Set<string>; vendors: Set<string> } {
  const types = new Set<string>();
  const tags = new Set<string>();
  const vendors = new Set<string>();

  if (!complementMap) return { types, tags, vendors };

  const baseType = base.productType?.toLowerCase();
  if (baseType && complementMap.productType?.[baseType]) {
    complementMap.productType[baseType].forEach((t) => types.add(t.toLowerCase()));
  }

  const baseVendor = base.vendor?.toLowerCase();
  if (baseVendor && complementMap.vendor?.[baseVendor]) {
    complementMap.vendor[baseVendor].forEach((v) => vendors.add(v.toLowerCase()));
  }

  const baseTags = normalizeTags(base.tags);
  baseTags.forEach((tag) => {
    const mapped = complementMap.tags?.[tag];
    if (mapped) mapped.forEach((t) => tags.add(t.toLowerCase()));
  });

  return { types, tags, vendors };
}

function overlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(a);
  const hits = b.filter((t) => set.has(t)).length;
  return clamp(hits / Math.max(a.length, b.length));
}

export function computeSimilarityScore(params: {
  base: { productType?: string | null; vendor?: string | null; tags?: string[] };
  candidate: { productType?: string | null; vendor?: string | null; tags?: string[] };
  complementMap?: ComplementMap | null;
}): number {
  const baseTags = normalizeTags(params.base.tags);
  const candidateTags = normalizeTags(params.candidate.tags);
  const complement = buildComplementSet(params.base, params.complementMap);

  const tagOverlap = overlapScore(baseTags, candidateTags);
  const typeMatch =
    params.base.productType &&
    params.candidate.productType &&
    params.base.productType.toLowerCase() === params.candidate.productType.toLowerCase()
      ? 1
      : 0;
  const vendorMatch =
    params.base.vendor &&
    params.candidate.vendor &&
    params.base.vendor.toLowerCase() === params.candidate.vendor.toLowerCase()
      ? 1
      : 0;

  const complementTagMatch = candidateTags.some((t) => complement.tags.has(t)) ? 1 : 0;
  const complementTypeMatch =
    params.candidate.productType &&
    complement.types.has(params.candidate.productType.toLowerCase())
      ? 1
      : 0;
  const complementVendorMatch =
    params.candidate.vendor &&
    complement.vendors.has(params.candidate.vendor.toLowerCase())
      ? 1
      : 0;

  const raw =
    0.35 * tagOverlap +
    0.25 * typeMatch +
    0.15 * vendorMatch +
    0.15 * complementTagMatch +
    0.05 * complementTypeMatch +
    0.05 * complementVendorMatch;

  return clamp(raw);
}

export function computeInventoryScore(inv: number | null): number {
  if (inv == null) return 0.4;
  if (inv <= 0) return 0;
  return clamp(0.3 + Math.min(inv, 50) / 70);
}

export function computePriceDeltaScore(params: {
  basePrice: number | null;
  candidatePrice: number | null;
  minPct: number;
  maxPct: number;
}): number {
  const { basePrice, candidatePrice, minPct, maxPct } = params;
  if (!basePrice || !candidatePrice) return 0;
  const deltaPct = ((candidatePrice - basePrice) / basePrice) * 100;
  if (deltaPct < minPct || deltaPct > maxPct) return 0;
  const mid = (minPct + maxPct) / 2;
  const halfRange = (maxPct - minPct) / 2 || 1;
  const distance = Math.abs(deltaPct - mid);
  return clamp(1 - distance / halfRange);
}

export function computePerformanceScore(stats: PerformanceStats | undefined): number {
  if (!stats) return 0.2;
  const impressions = Math.max(stats.impressions, 1);
  const ctr = stats.clicks / impressions;
  const atc = stats.addToCart / impressions;
  return clamp(0.6 * ctr + 0.4 * atc);
}

export function computeCandidateScore(params: {
  candidate: CandidateProduct;
  base: { productType?: string | null; vendor?: string | null; tags?: string[]; price?: number | null };
  performance?: PerformanceStats;
  config: RankingConfig;
  forUpsell: boolean;
}): Omit<RankedCandidate, "score"> & { score: number } {
  const similarity = computeSimilarityScore({
    base: params.base,
    candidate: params.candidate,
    complementMap: params.config.complementMap ?? null
  });
  const inventory = computeInventoryScore(params.candidate.variant.inventoryQuantity);
  const price = params.forUpsell
    ? computePriceDeltaScore({
        basePrice: params.base.price ?? null,
        candidatePrice: params.candidate.variant.price ?? params.candidate.priceMin ?? null,
        minPct: params.config.upsellDeltaMinPct,
        maxPct: params.config.upsellDeltaMaxPct
      })
    : 0.5;
  const performance = computePerformanceScore(params.performance);

  const aggressiveness = clamp(params.config.aggressiveness, 0, 1);
  const weightSimilarity = 0.45 - aggressiveness * 0.15;
  const weightPrice = 0.2 + aggressiveness * 0.15;
  const weightPerformance = 0.15 + aggressiveness * 0.1;
  const weightInventory = 1 - (weightSimilarity + weightPrice + weightPerformance);

  const score =
    weightSimilarity * similarity +
    weightPrice * price +
    weightPerformance * performance +
    weightInventory * inventory;

  return {
    ...params.candidate,
    score: clamp(score),
    breakdown: {
      similarity,
      inventory,
      price,
      performance,
      diversityPenalty: 0
    }
  };
}

export function applyDiversityPenalty(
  candidate: RankedCandidate,
  selected: RankedCandidate[]
): RankedCandidate {
  if (selected.length === 0) return candidate;
  let penalty = 0;
  for (const item of selected) {
    if (candidate.productType && item.productType && candidate.productType === item.productType) {
      penalty += 0.12;
    }
    if (candidate.vendor && item.vendor && candidate.vendor === item.vendor) {
      penalty += 0.08;
    }
    if (candidate.title && item.title && candidate.title === item.title) {
      penalty += 0.2;
    }
  }
  const nextScore = clamp(candidate.score - penalty);
  return {
    ...candidate,
    score: nextScore,
    breakdown: {
      ...candidate.breakdown,
      diversityPenalty: penalty
    }
  };
}

export function rankCandidates(params: {
  candidates: CandidateProduct[];
  base: { productType?: string | null; vendor?: string | null; tags?: string[]; price?: number | null };
  performanceMap: Map<string, PerformanceStats>;
  config: RankingConfig;
  forUpsell: boolean;
}): RankedCandidate[] {
  const scored = params.candidates.map((candidate) =>
    computeCandidateScore({
      candidate,
      base: params.base,
      performance: params.performanceMap.get(candidate.productId),
      config: params.config,
      forUpsell: params.forUpsell
    })
  );

  const selected: RankedCandidate[] = [];
  const pool = scored.slice();

  const max = Math.max(1, params.config.maxRecommendations || 3);
  while (pool.length > 0 && selected.length < max) {
    const adjusted = pool.map((c) => applyDiversityPenalty(c, selected));
    adjusted.sort((a, b) => b.score - a.score);
    const winner = adjusted[0];
    selected.push(winner);
    const index = pool.findIndex((c) => c.id === winner.id);
    if (index >= 0) pool.splice(index, 1);
  }

  return selected;
}
