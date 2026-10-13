export type UsageRateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageSnapshot = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: UsageRateLimit[]
}

/** When the prompt cache goes cold (ms on `$.clock.now()`'s scale; null before the first answer), and whether a turn is running. */
export type CacheState = { expiresAt: number | null; isBusy: boolean }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snapshot: UsageSnapshot | null; isCollapsed: boolean; cache: CacheState; cacheLabel: string }
  }
}
