import crypto from 'node:crypto';

function normalizeUrlForSource(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function deterministicUuid(input: string): string {
  const hex = crypto.createHash('md5').update(input).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildSourceId(params: {
  clientId: string;
  jobId?: string | null;
  url: string;
}): string {
  const normUrl = normalizeUrlForSource(params.url);
  const seed = `${params.clientId}|${params.jobId ?? ''}|${normUrl}`;
  return deterministicUuid(seed);
}
