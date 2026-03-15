const BLOCKED_EXTENSIONS = new Set([
  '.xml',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.tif',
  '.tiff',
]);

export function shouldSkipCrawlUrl(rawUrl: string): boolean {
  const extPattern =
    /\.(xml|pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|webp|svg|bmp|tiff?)(?:$|[?#])/i;
  if (extPattern.test(rawUrl)) return true;
  try {
    const u = new URL(rawUrl);
    const path = decodeURIComponent(u.pathname).toLowerCase();

    // Avoid crawling machine-oriented endpoints that pollute retrieval quality.
    if (path.includes('sitemap')) {
      return true;
    }

    for (const ext of BLOCKED_EXTENSIONS) {
      if (path.endsWith(ext)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
