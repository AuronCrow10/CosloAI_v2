import { PlaywrightCrawler, RequestOptions } from '@crawlee/playwright';
import { AppConfig, ParsedPage, Client } from '../types.js';
import { Database } from '../db/index.js';
import { EmbeddingService } from '../embeddings/index.js';
import { parseHtmlToText } from '../parser/index.js';
import { logger } from '../logger.js';
import { ingestTextForClient } from '../ingestion/ingestText.js';
import { fetchSitemapUrls } from './sitemaps.js';

interface CrawlDependencies {
  config: AppConfig;
  db: Database;
  embeddings: EmbeddingService;

  // Optional progress reporter (for crawl_jobs)
  job?: {
    id: string;
    onTotalsKnown?: (totalPagesEstimated: number | null) => Promise<void>;
    onProgress?: (p: {
      pagesVisited: number;
      pagesStored: number;
      chunksStored: number;
    }) => Promise<void>;
  };
}

export function normalizeDomainToStartUrl(domainInput: string): string {
  let urlString: string;
  if (domainInput.startsWith('http://') || domainInput.startsWith('https://')) {
    urlString = domainInput;
  } else {
    urlString = `https://${domainInput}`;
  }

  const url = new URL(urlString);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function extractDomain(hostOrUrl: string): string {
  try {
    const u = new URL(
      hostOrUrl.startsWith('http://') || hostOrUrl.startsWith('https://')
        ? hostOrUrl
        : `https://${hostOrUrl}`,
    );
    return u.hostname;
  } catch {
    return hostOrUrl;
  }
}

/**
 * Normalize URL for dedup + stable "total discovered" counting.
 * - forces https/http origin + pathname
 * - strips hash
 * - removes common tracking params
 * - sorts remaining query params
 * - trims trailing slash (except root)
 */
function normalizeUrlForDedup(raw: string): string | null {
  try {
    const u = new URL(raw);

    // strip hash
    u.hash = '';

    // remove common tracking params
    const dropPrefixes = ['utm_'];
    const dropExact = new Set([
      'gclid',
      'fbclid',
      'igshid',
      'mc_cid',
      'mc_eid',
      'ref',
      'ref_src',
      'mkt_tok',
    ]);

    const kept: [string, string][] = [];
    for (const [k, v] of u.searchParams.entries()) {
      const lower = k.toLowerCase();
      if (dropExact.has(lower)) continue;
      if (dropPrefixes.some((p) => lower.startsWith(p))) continue;
      kept.push([k, v]);
    }

    // rewrite search params in stable order
    u.search = '';
    kept
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
      .forEach(([k, v]) => u.searchParams.append(k, v));

    // normalize pathname
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.toString();
  } catch {
    return null;
  }
}

export async function crawlDomain(
  domainInput: string,
  clientInfo: Client,
  deps: CrawlDependencies,
): Promise<void> {
  const startUrl = normalizeDomainToStartUrl(domainInput);
  const domain = extractDomain(domainInput);
  const { config, db, embeddings, job } = deps;

  logger.info(
    `Starting crawl for domain: ${domain} (start URL: ${startUrl}, client=${clientInfo.id}, model=${clientInfo.embeddingModel})`,
  );
  logger.info(
    `Limits: maxPages=${config.crawl.maxPages}, maxDepth=${config.crawl.maxDepth}, concurrency=${config.crawl.concurrency}`,
  );

  let pagesVisited = 0;
  let pagesStored = 0;
  let chunksStored = 0;

  const sitemapUrls = await fetchSitemapUrls(startUrl, domain, config.crawl.enableSitemap);

  const startRequests =
    sitemapUrls.length > 0
      ? [
          { url: startUrl, userData: { depth: 0 } },
          ...sitemapUrls.map((url) => ({ url, userData: { depth: 0 } })),
        ]
      : [{ url: startUrl, userData: { depth: 0 } }];

  // ---- SMART TOTALS (works with or without sitemap) ----
  const discoveredUrls = new Set<string>();

  const addDiscovered = (rawUrl: string): boolean => {
    const norm = normalizeUrlForDedup(rawUrl);
    if (!norm) return false;
    if (discoveredUrls.has(norm)) return false;
    discoveredUrls.add(norm);
    return true;
  };

  for (const r of startRequests) addDiscovered(r.url);

  // Initial estimate:
  // - sitemap: bounded count is meaningful right away
  // - no sitemap: start with discovered set (usually 1) and it grows as we discover links
  let totalPagesEstimated =
    sitemapUrls.length > 0
      ? Math.min(config.crawl.maxPages, discoveredUrls.size)
      : Math.min(config.crawl.maxPages, discoveredUrls.size);

  // Throttle total updates to avoid spamming DB/webhooks
  let lastTotalsReportAt = 0;
  let lastTotalsReported = totalPagesEstimated;

  const maybeReportTotals = async (force = false) => {
    if (!job?.onTotalsKnown) return;

    const now = Date.now();
    const current = Math.min(config.crawl.maxPages, discoveredUrls.size);

    // totals should never go backwards
    if (current < totalPagesEstimated) return;

    totalPagesEstimated = current;

    const delta = totalPagesEstimated - lastTotalsReported;
    const tooSoon = now - lastTotalsReportAt < 1000;

    // Report if forced, or totals jumped enough, or enough time elapsed
    if (!force && tooSoon && delta < 5) return;

    lastTotalsReportAt = now;
    lastTotalsReported = totalPagesEstimated;
    await job.onTotalsKnown(totalPagesEstimated);
  };

  // Emit initial totals immediately
  await maybeReportTotals(true);

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: config.crawl.maxPages,
    maxConcurrency: config.crawl.concurrency,
    respectRobotsTxtFile: config.crawl.respectRobotsTxt,
    useSessionPool: true,

    async requestHandler({ request, page, enqueueLinks, log }) {
      const depth: number = (request.userData.depth as number) ?? 0;

      if (depth > config.crawl.maxDepth) {
        log.info(`Skipping ${request.url}, depth ${depth} > ${config.crawl.maxDepth}`);
        return;
      }

      log.info(`Processing ${request.url} (depth ${depth})`);

      try {
        if (config.crawl.contentWaitSelector) {
          await page.waitForSelector(config.crawl.contentWaitSelector, { timeout: 15000 });
        } else {
          await page.waitForLoadState('networkidle', { timeout: 15000 });
        }
      } catch {
        log.warning(`Timeout waiting for page to load: ${request.url}`);
      }

      let html: string;
      try {
        html = await page.content();
      } catch (err) {
        log.error(`Failed to get page content for ${request.url}`, { err });
        return;
      }

      pagesVisited += 1;

      const parsed: ParsedPage = parseHtmlToText(html, request.url, domain);

      if (!parsed.cleanedText || parsed.cleanedText.length < config.crawl.minChars) {
        log.info(
          `Skipping ${request.url} - cleaned text too short (${parsed.cleanedText.length} chars)`,
        );
      } else {
        try {
          const { chunksCreated, chunksStored: storedNow } = await ingestTextForClient({
            text: parsed.cleanedText,
            url: parsed.url,
            domain: parsed.domain,
            client: clientInfo,
            deps: { config, db, embeddings },
          });

          if (chunksCreated > 0) {
            pagesStored += 1;
            chunksStored += storedNow;
          }
        } catch (err) {
          log.error(`Ingestion failed for URL ${request.url}`, { err });
        }
      }

      // Enqueue links and update smart totals *as we discover URLs*
      if (depth < config.crawl.maxDepth) {
        await enqueueLinks({
          strategy: 'same-domain',
          transformRequestFunction: (reqOpts: RequestOptions) => {
            try {
              const u = new URL(reqOpts.url);

              // same-domain only
              if (u.hostname !== domain) return null;

              // normalize for dedup
              const norm = normalizeUrlForDedup(u.toString());
              if (!norm) return null;

              // cap at maxPages (don’t inflate totals beyond our crawl limit)
              if (discoveredUrls.size >= config.crawl.maxPages) return null;

              // Add only if newly discovered
              const added = addDiscovered(norm);
              if (!added) return null;

              // attach updated depth
              reqOpts.userData = { ...(reqOpts.userData || {}), depth: depth + 1 };

              // use normalized URL
              reqOpts.url = norm;

              return reqOpts;
            } catch {
              return null;
            }
          },
        });

        // totals may have increased due to newly accepted links
        await maybeReportTotals(false);
      }

      if (job?.onProgress) {
        await job.onProgress({ pagesVisited, pagesStored, chunksStored });
      }
    },

    async failedRequestHandler({ request, log, error }) {
      log.error(`Request ${request.url} failed too many times`, { error });
    },
  });

  await crawler.run(startRequests);

  // final totals report (helps UI be consistent right before completion webhook)
  await maybeReportTotals(true);

  logger.info(
    `Crawl finished for domain=${domain}, client=${clientInfo.id}. pagesVisited=${pagesVisited}, pagesStored=${pagesStored}, chunksStored=${chunksStored}, totalEstimated=${totalPagesEstimated}`,
  );
}
