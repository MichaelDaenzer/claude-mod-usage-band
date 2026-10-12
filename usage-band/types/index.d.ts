export type UsageRateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type UsageSnapshot = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: UsageRateLimit[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snapshot: UsageSnapshot | null }
  }
}
