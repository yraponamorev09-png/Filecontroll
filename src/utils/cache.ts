interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const DEFAULT_TTL = 30_000; // 30 seconds

const cache = new Map<string, CacheEntry<any>>();

export function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function cacheSet<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

export function cacheInvalidate(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function cacheClear(): void {
  cache.clear();
}

export function cacheSize(): number {
  return cache.size;
}

// Deduplication: prevent concurrent identical fetches
const inflight = new Map<string, Promise<any>>();

export async function dedupFetch<T>(key: string, fetcher: () => Promise<T>, ttl: number = DEFAULT_TTL): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== null) return cached;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fetcher().then(data => {
    cacheSet(key, data, ttl);
    inflight.delete(key);
    return data;
  });
  inflight.set(key, promise);
  return promise;
}
