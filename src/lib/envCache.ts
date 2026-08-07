import type { EnvironmentReport } from "../lib/env";

const CACHE_KEY = "pr-env-cache";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟内复用缓存

interface CachedReport {
  report: EnvironmentReport;
  cachedAt: number;
}

export function getCachedEnvironmentReport(): EnvironmentReport | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: CachedReport = JSON.parse(raw);
    if (Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
    return parsed.report;
  } catch {
    return null;
  }
}

export function setCachedEnvironmentReport(report: EnvironmentReport): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ report, cachedAt: Date.now() }));
  } catch {
    /* ignore */
  }
}

export function clearCachedEnvironmentReport(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}
