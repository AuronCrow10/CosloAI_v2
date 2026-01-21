const BLOCKED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
]);

export function shouldSkipCrawlUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.toLowerCase();
    for (const ext of BLOCKED_EXTENSIONS) {
      if (path.endsWith(ext)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
