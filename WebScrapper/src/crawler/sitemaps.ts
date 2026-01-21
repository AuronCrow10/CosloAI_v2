import { load as cheerioLoad } from 'cheerio';
import { logger } from '../logger.js';

const COMMON_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/wp-sitemap.xml',
  '/index.php/sitemap_index.xml',
];

const MAX_SITEMAPS_TO_FETCH = 50;

function toOrigin(startUrl: string): string | null {
  try {
    return new URL(startUrl).origin;
  } catch {
    return null;
  }
}

function normalizeSitemapUrl(raw: string, origin: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, origin).toString();
  } catch {
    return null;
  }
}

function extractDomainFromUrl(hostOrUrl: string): string {
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

async function fetchRobotsSitemaps(startUrl: string, domain: string): Promise<string[]> {
  const origin = toOrigin(startUrl);
  if (!origin) return [];

  const robotsUrl = new URL('/robots.txt', origin).toString();
  try {
    const res = await fetch(robotsUrl);
    if (!res.ok) return [];
    const txt = await res.text();
    const out: string[] = [];
    for (const line of txt.split(/\r?\n/)) {
      const match = line.trim().match(/^sitemap:\s*(.+)$/i);
      if (!match) continue;
      const url = normalizeSitemapUrl(match[1], origin);
      if (!url) continue;
      if (extractDomainFromUrl(url) !== domain) continue;
      out.push(url);
    }
    return out;
  } catch (err) {
    logger.warn(`Error reading robots.txt for sitemap discovery (${robotsUrl}):`, err);
    return [];
  }
}

function buildSitemapCandidates(startUrl: string, robotsSitemaps: string[]): string[] {
  const origin = toOrigin(startUrl);
  if (!origin) return [...robotsSitemaps];
  const common = COMMON_SITEMAP_PATHS.map((p) => new URL(p, origin).toString());
  return [...robotsSitemaps, ...common];
}

function parseSitemapXml(xml: string): { urls: string[]; sitemapIndexes: string[] } {
  const $ = cheerioLoad(xml, { xmlMode: true });

  const indexLocs: string[] = [];
  $('sitemap > loc').each((_, el) => {
    const raw = $(el).text().trim();
    if (raw) indexLocs.push(raw);
  });

  if (indexLocs.length > 0) {
    return { urls: [], sitemapIndexes: indexLocs };
  }

  const urls: string[] = [];
  $('url > loc, loc').each((_, el) => {
    const raw = $(el).text().trim();
    if (raw) urls.push(raw);
  });

  return { urls, sitemapIndexes: [] };
}

export async function fetchSitemapUrls(
  startUrl: string,
  domain: string,
  enableSitemap: boolean,
): Promise<string[]> {
  if (!enableSitemap) {
    logger.info('Sitemap support disabled via config.');
    return [];
  }

  const robotsSitemaps = await fetchRobotsSitemaps(startUrl, domain);
  const candidates = buildSitemapCandidates(startUrl, robotsSitemaps);
  const queue = [...new Set(candidates)];
  const seenSitemaps = new Set<string>();
  const pageUrls = new Set<string>();

  while (queue.length > 0 && seenSitemaps.size < MAX_SITEMAPS_TO_FETCH) {
    const sitemapUrl = queue.shift() as string;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const res = await fetch(sitemapUrl);
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseSitemapXml(xml);

      if (parsed.sitemapIndexes.length > 0) {
        for (const raw of parsed.sitemapIndexes) {
          const normalized = normalizeSitemapUrl(raw, sitemapUrl);
          if (!normalized) continue;
          if (extractDomainFromUrl(normalized) !== domain) continue;
          queue.push(normalized);
        }
      } else {
        for (const raw of parsed.urls) {
          const normalized = normalizeSitemapUrl(raw, sitemapUrl);
          if (!normalized) continue;
          if (extractDomainFromUrl(normalized) !== domain) continue;
          pageUrls.add(normalized);
        }
      }
    } catch (err) {
      logger.warn(`Error while fetching/parsing sitemap (${sitemapUrl}):`, err);
    }
  }

  if (seenSitemaps.size >= MAX_SITEMAPS_TO_FETCH && queue.length > 0) {
    logger.warn(
      `Sitemap discovery capped at ${MAX_SITEMAPS_TO_FETCH} files; some sitemaps were skipped.`,
    );
  }

  if (pageUrls.size > 0) {
    logger.info(`Parsed ${pageUrls.size} URLs from sitemap discovery`);
  }

  return Array.from(pageUrls);
}
