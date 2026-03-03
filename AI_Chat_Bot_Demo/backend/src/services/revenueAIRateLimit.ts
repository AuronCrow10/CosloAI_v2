type SlidingWindowLimiter = {
  allow: (key: string) => boolean;
};

type DedupeWindow = {
  isDuplicate: (key: string) => boolean;
};

export function createSlidingWindowLimiter(params: {
  windowMs: number;
  max: number;
}): SlidingWindowLimiter {
  const hits = new Map<string, number[]>();
  const { windowMs, max } = params;

  return {
    allow: (key: string) => {
      const now = Date.now();
      const windowStart = now - windowMs;
      const entry = hits.get(key) || [];
      const filtered = entry.filter((ts) => ts > windowStart);
      if (filtered.length >= max) {
        hits.set(key, filtered);
        return false;
      }
      filtered.push(now);
      hits.set(key, filtered);
      return true;
    }
  };
}

export function createDedupeWindow(params: { windowMs: number }): DedupeWindow {
  const lastSeen = new Map<string, number>();
  const { windowMs } = params;

  return {
    isDuplicate: (key: string) => {
      const now = Date.now();
      const last = lastSeen.get(key);
      if (last && now - last < windowMs) {
        return true;
      }
      lastSeen.set(key, now);
      return false;
    }
  };
}
