/** Token counts summed over every model response the mod saw (main loop and subagents). */
export type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Calls to one MCP server, by tool name on that server. */
export type ServerCalls = { total: number; tools: Record<string, number> }

/** A tool call in flight, and the subagent loop it runs in (absent on the main loop). */
export type ActiveTool = { tool: string; agentId?: string }

export type SessionStats = {
  /** When the mod started counting tokens (ms on `$.clock.now()`); tokens before it are not reachable. */
  trackedSince: number
  tokens: TokenTotals
  /** Total tokens (all four kinds) per model id. */
  byModel: Record<string, number>
  prompts: number
  /** Main-loop turns, their summed and longest wall-clock time. */
  turns: number
  workMs: number
  longestTurnMs: number
  /** Built-in tool calls by tool name, main loop and subagents together. */
  tools: Record<string, number>
  /** MCP calls by server segment of the wire name (`mcp__<server>__<tool>`). */
  mcp: Record<string, ServerCalls>
  subagentToolCalls: number
  toolErrors: number
  toolDenied: number
  skills: Record<string, number>
  /** Subagents started, by subagent type. */
  agents: Record<string, number>
  filesEdited: string[]
  filesRead: string[]
  compactions: number
  /** True when the counts were seeded from the transcript because the mod loaded mid-session. */
  isBackfilled: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-summary': {
      stats: SessionStats | null
      /** Display name per MCP server segment, from the context breakdown (`claude.ai Atlassian`). */
      serverNames: Record<string, string>
      /** Collapsed sections, by section key. */
      collapsed: Record<string, boolean>
      /** Tool calls running now, by tool_use_id. */
      activeTools: Record<string, ActiveTool>
      /** Skills invoked in the running turn, by skill name. */
      activeSkills: Record<string, true>
      /** Subagents running now: agent id → subagent type. */
      activeAgents: Record<string, string>
      /** When the running main-loop turn started (ms on `$.clock.now()`), null between turns. */
      turnStartedAt: number | null
      /** The ticker's last written time: every second while work runs, every 15 s idle; redraws the times. */
      clock: number
      /** The blink phase of rows in use; flips while anything is in use. */
      blink: boolean
    }
  }
}
