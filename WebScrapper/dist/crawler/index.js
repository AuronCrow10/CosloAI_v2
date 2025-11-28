import { PlaywrightCrawler } from '@crawlee/playwright';
import { load as cheerioLoad } from 'cheerio';
import { parseHtmlToText } from '../parser/index.js';
import { logger } from '../logger.js';
import { ingestTextForClient } from '../ingestion/ingestText.js';
/**
 * Normalize input such as:
 * - "example.com" -> "https://example.com/"
 * - "https://example.com" -> "https://example.com/"
 * - "http://example.com" -> "http://example.com/"
 */
export function normalizeDomainToStartUrl(domainInput) {
    let urlString;
    if (domainInput.startsWith('http://') || domainInput.startsWith('https://')) {
        urlString = domainInput;
    }
    else {
        urlString = `https://${domainInput}`;
    }
    const url = new URL(urlString);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
}
export function extractDomain(hostOrUrl) {
    try {
        const u = new URL(hostOrUrl.startsWith('http://') || hostOrUrl.startsWith('https://')
            ? hostOrUrl
            : `https://${hostOrUrl}`);
        return u.hostname;
    }
    catch {
        return hostOrUrl;
    }
}
/**
 * Try to fetch and parse sitemap.xml for the given domain.
 * Returns an array of URLs (may be empty if not found / parse error).
 */
async function tryFetchSitemapUrls(startUrl, domain, enableSitemap) {
    if (!enableSitemap) {
        logger.info('Sitemap support disabled via config.');
        return [];
    }
    const sitemapUrl = new URL(startUrl);
    sitemapUrl.pathname = '/sitemap.xml';
    sitemapUrl.search = '';
    sitemapUrl.hash = '';
    logger.info(`Attempting to fetch sitemap from ${sitemapUrl.toString()}`);
    try {
        const res = await fetch(sitemapUrl.toString());
        if (!res.ok) {
            logger.warn(`Sitemap fetch failed with status ${res.status}. Falling back to homepage crawl.`);
            return [];
        }
        const xml = await res.text();
        const $ = cheerioLoad(xml, { xmlMode: true });
        const urls = [];
        $('url > loc, loc').each((_, el) => {
            const raw = $(el).text().trim();
            if (!raw)
                return;
            try {
                const u = new URL(raw);
                if (u.hostname === domain) {
                    urls.push(u.toString());
                }
            }
            catch {
                // ignore invalid URL
            }
        });
        logger.info(`Parsed ${urls.length} URLs from sitemap.xml`);
        return urls;
    }
    catch (err) {
        logger.warn(`Error while fetching/parsing sitemap (${sitemapUrl.toString()}):`, err);
        return [];
    }
}
/**
 * Crawl a domain for a specific client.
 * - Uses client's embedding_model to generate embeddings.
 * - Routes inserts into page_chunks_small or page_chunks_large.
 */
export async function crawlDomain(domainInput, clientInfo, deps) {
    const startUrl = normalizeDomainToStartUrl(domainInput);
    const domain = extractDomain(domainInput);
    const { config, db, embeddings } = deps;
    logger.info(`Starting crawl for domain: ${domain} (start URL: ${startUrl}, client=${clientInfo.id}, model=${clientInfo.embeddingModel})`);
    logger.info(`Limits: maxPages=${config.crawl.maxPages}, ` +
        `maxDepth=${config.crawl.maxDepth}, concurrency=${config.crawl.concurrency}`);
    let pagesProcessed = 0;
    let chunksStored = 0;
    // Attempt sitemap-based seeds
    const sitemapUrls = await tryFetchSitemapUrls(startUrl, domain, config.crawl.enableSitemap);
    const startRequests = sitemapUrls.length > 0
        ? [
            { url: startUrl, userData: { depth: 0 } }, // ensure homepage is included
            ...sitemapUrls.map((url) => ({ url, userData: { depth: 0 } })),
        ]
        : [{ url: startUrl, userData: { depth: 0 } }];
    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: config.crawl.maxPages,
        maxConcurrency: config.crawl.concurrency,
        // Respect robots.txt
        respectRobotsTxtFile: true,
        useSessionPool: true,
        async requestHandler({ request, page, enqueueLinks, log }) {
            const depth = request.userData.depth ?? 0;
            if (depth > config.crawl.maxDepth) {
                log.info(`Skipping ${request.url}, depth ${depth} > ${config.crawl.maxDepth}`);
                return;
            }
            log.info(`Processing ${request.url} (depth ${depth})`);
            try {
                if (config.crawl.contentWaitSelector) {
                    await page.waitForSelector(config.crawl.contentWaitSelector, {
                        timeout: 15000,
                    });
                }
                else {
                    await page.waitForLoadState('networkidle', { timeout: 15000 });
                }
            }
            catch (err) {
                log.warning(`Timeout waiting for page to load: ${request.url}`);
            }
            let html;
            try {
                html = await page.content();
            }
            catch (err) {
                log.error(`Failed to get page content for ${request.url}`, { err });
                return;
            }
            const parsed = parseHtmlToText(html, request.url, domain);
            if (!parsed.cleanedText || parsed.cleanedText.length < config.crawl.minChars) {
                log.info(`Skipping ${request.url} - cleaned text too short (${parsed.cleanedText.length} chars)`);
            }
            else {
                try {
                    const { chunksCreated, chunksStored: storedNow } = await ingestTextForClient({
                        text: parsed.cleanedText,
                        url: parsed.url,
                        domain: parsed.domain,
                        client: clientInfo,
                        deps: { config, db, embeddings },
                    });
                    if (chunksCreated > 0) {
                        pagesProcessed += 1;
                        chunksStored += storedNow;
                        logger.info(`Stored ${chunksCreated} chunks for ${request.url}. ` +
                            `Total pages=${pagesProcessed}, total chunks=${chunksStored}`);
                    }
                    else {
                        log.info(`No chunks produced for ${request.url} by ingestion helper.`);
                    }
                }
                catch (err) {
                    log.error(`Ingestion failed for URL ${request.url}`, { err });
                }
            }
            // Enqueue same-domain links, respecting depth
            if (depth < config.crawl.maxDepth) {
                await enqueueLinks({
                    strategy: 'same-domain',
                    transformRequestFunction: (reqOpts) => {
                        const u = new URL(reqOpts.url);
                        if (u.hostname !== domain) {
                            return null;
                        }
                        reqOpts.userData = {
                            ...(reqOpts.userData || {}),
                            depth: depth + 1,
                        };
                        return reqOpts;
                    },
                });
            }
        },
        async failedRequestHandler({ request, log, error }) {
            log.error(`Request ${request.url} failed too many times`, { error });
        },
    });
    await crawler.run(startRequests);
    logger.info(`Crawl finished for domain=${domain}, client=${clientInfo.id}. Pages processed=${pagesProcessed}, chunks stored=${chunksStored}`);
}
