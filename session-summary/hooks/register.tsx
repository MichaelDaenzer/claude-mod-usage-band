import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage, Timer, TurnUsage } from 'claude-code'

import type { ActiveTool, SessionStats } from '../types'

const PANE = 'session-summary'
const TITLE = 'Session'

const stats = atom({ plugin: 'session-summary', key: 'stats' } as const, null)
const serverNames = atom({ plugin: 'session-summary', key: 'serverNames' } as const, {} as Record<string, string>)
const collapsed = atom({ plugin: 'session-summary', key: 'collapsed' } as const, {} as Record<string, boolean>)
const activeTools = atom({ plugin: 'session-summary', key: 'activeTools' } as const, {} as Record<string, ActiveTool>)
const activeSkills = atom({ plugin: 'session-summary', key: 'activeSkills' } as const, {} as Record<string, true>)
const activeAgents = atom({ plugin: 'session-summary', key: 'activeAgents' } as const, {} as Record<string, string>)
const turnStartedAt = atom({ plugin: 'session-summary', key: 'turnStartedAt' } as const, null as number | null)
const clock = atom({ plugin: 'session-summary', key: 'clock' } as const, 0)
const blink = atom({ plugin: 'session-summary', key: 'blink' } as const, false)

/** The ticker's period: how often a row in use flips between bright and dim. */
const TICK_MS = 600
/** How fine the times redraw: per second while work runs, per 15 s while idle. */
const LIVE_CLOCK_MS = 1000
const IDLE_CLOCK_MS = 15_000
/** How often running subagents are checked against the agent list, so one killed without a turn end stops blinking. */
const AGENT_CHECK_MS = 10_000
const RUNNING_STATUSES = new Set(['pending', 'running', 'waiting'])

const SECTIONS = ['tokens', 'activity', 'tools', 'skills', 'connectors', 'agents'] as const
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_FILES = 2000

export const emptyStats = (now: number): SessionStats => ({
  trackedSince: now,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  byModel: {},
  prompts: 0,
  turns: 0,
  workMs: 0,
  longestTurnMs: 0,
  tools: {},
  mcp: {},
  subagentToolCalls: 0,
  toolErrors: 0,
  toolDenied: 0,
  skills: {},
  agents: {},
  filesEdited: [],
  filesRead: [],
  compactions: 0,
  isBackfilled: false,
})

/** `mcp__<server>__<tool>` split into its server segment and tool name; undefined for a built-in tool. */
export const parseMcp = (name: string): { server: string; tool: string } | undefined => {
  if (!name.startsWith('mcp__')) return undefined
  const cut = name.indexOf('__', 5)
  return cut < 0 ? { server: name.slice(5), tool: '' } : { server: name.slice(5, cut), tool: name.slice(cut + 2) }
}

/**
 * A server's name as /mcp or the connector list gives it, shortened for the sidebar:
 * `claude.ai Atlassian` → `Atlassian`, `Atlassian MCP` → `Atlassian`, `plugin:polaris:polaris` → `polaris`.
 */
export const displayServer = (listed: string): string => {
  let name = listed
  if (name.startsWith('claude.ai ')) name = name.slice('claude.ai '.length)
  if (name.startsWith('plugin:')) {
    const [, plugin = '', server = ''] = name.split(':')
    name = plugin === server || server === '' ? plugin : `${plugin}/${server}`
  }
  return name.replace(/ MCP$/, '')
}

/** Connector names by id from the desktop app's connector status: claude.ai connectors are wired under their UUID. */
export const parseConnectorStatus = (text: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(text) as { servers?: { id?: unknown; name?: unknown }[] }
    return Object.fromEntries(
      (parsed.servers ?? []).flatMap(s => (typeof s.id === 'string' && typeof s.name === 'string' ? [[s.id, displayServer(s.name)]] : [])),
    )
  } catch {
    return {}
  }
}

/** The fallback when the context breakdown does not name the server: the wire segment, a connector's UUID cut short. */
export const fallbackServer = (segment: string): string => {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)) return `connector ${segment.slice(0, 8)}`
  if (segment.startsWith('claude_ai_')) return segment.slice('claude_ai_'.length).replace(/_/g, ' ')
  return segment
}

const bump = (counts: Record<string, number>, key: string, by = 1) => ({ ...counts, [key]: (counts[key] ?? 0) + by })

const addUnique = (list: string[], item: unknown) =>
  typeof item !== 'string' || item === '' || list.includes(item) || list.length >= MAX_FILES ? list : [...list, item]

export type ToolOutcome = { isError?: boolean; isDenied?: boolean; inSubagent?: boolean }

/** A tool call as it starts: counted under its tool, or under its MCP server. The Skill tool's skill is counted by `skill.prompt`. */
export const countCall = (s: SessionStats, name: string, inSubagent: boolean): SessionStats => {
  const mcp = parseMcp(name)
  const next: SessionStats = { ...s }
  if (mcp) {
    const server = s.mcp[mcp.server] ?? { total: 0, tools: {} }
    next.mcp = { ...s.mcp, [mcp.server]: { total: server.total + 1, tools: bump(server.tools, mcp.tool) } }
  } else {
    next.tools = bump(s.tools, name)
  }
  if (inSubagent) next.subagentToolCalls = s.subagentToolCalls + 1
  return next
}

/** A tool call as it ends: errors, denials, and the files it edited or read. */
export const countOutcome = (s: SessionStats, name: string, input: Record<string, unknown>, o: ToolOutcome): SessionStats => {
  const next: SessionStats = { ...s }
  if (o.isError) next.toolErrors = s.toolErrors + 1
  if (o.isDenied) next.toolDenied = s.toolDenied + 1
  if (!o.isError && !o.isDenied) {
    if (EDIT_TOOLS.has(name)) next.filesEdited = addUnique(s.filesEdited, input.file_path ?? input.notebook_path)
    if (name === 'Read') next.filesRead = addUnique(s.filesRead, input.file_path)
  }
  return next
}

/** One whole tool call folded into the stats, as the transcript holds it. */
export const countTool = (s: SessionStats, name: string, input: Record<string, unknown>, o: ToolOutcome): SessionStats =>
  countOutcome(countCall(s, name, o.inSubagent === true), name, input, o)

export const countUsage = (s: SessionStats, u: TurnUsage): SessionStats => {
  const total = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return {
    ...s,
    tokens: {
      input: s.tokens.input + u.input_tokens,
      output: s.tokens.output + u.output_tokens,
      cacheRead: s.tokens.cacheRead + u.cache_read_input_tokens,
      cacheWrite: s.tokens.cacheWrite + u.cache_creation_input_tokens,
    },
    byModel: bump(s.byModel, u.model, total),
  }
}

/** Folds a transcript (the main one, or a subagent's) into the stats: tool uses, and for the main one prompts and Skill calls. */
export const countMessages = (s: SessionStats, messages: readonly SessionMessage[], inSubagent: boolean): SessionStats => {
  let next = s
  for (const m of messages) {
    if (m.role === 'user') {
      if (!inSubagent && m.text.trim() !== '' && !m.toolResults?.length) next = { ...next, prompts: next.prompts + 1 }
      continue
    }
    for (const use of m.toolUses) {
      next = countTool(next, use.tool, use.input, { isError: use.isError === true, inSubagent })
      if (use.tool === 'Skill' && typeof use.input.skill === 'string') next = { ...next, skills: bump(next.skills, use.input.skill) }
    }
  }
  return next
}

/** Seeds the stats from what the session already holds, for a mod loaded mid-session. */
const backfill = async ($: EngineInterface, now: number): Promise<SessionStats> => {
  let s = emptyStats(now)
  const main = await $.session.messages()
  s = countMessages(s, main, false)
  for (const agent of await $.agent.list()) {
    s = { ...s, agents: bump(s.agents, agent.type) }
    const rows = await $.session.messages({ agentId: agent.id })
    if (Array.isArray(rows)) s = countMessages(s, rows, true)
  }
  return { ...s, isBackfilled: main.length > 0 }
}

/** Names an MCP server segment once, from the context breakdown's tool list; the fallback when the breakdown does not list it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether `name` reads as a name for `segment`: not absent, not the segment itself, no UUID, not the fallback. */
export const isReadableName = (name: string | undefined, segment: string): name is string =>
  name !== undefined && name !== '' && name !== segment && !UUID.test(name) && name !== fallbackServer(segment)

/** Readable names for MCP server segments: the context breakdown's tool list (plugin servers), overridden by the desktop app's connector status. */
const lookupServerNames = async ($: EngineInterface): Promise<Record<string, string>> => {
  const found: Record<string, string> = {}
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const tools = usage.context.breakdown?.mcpTools ?? []
    for (const tool of tools) {
      const server = parseMcp(tool.name)?.server
      if (server === undefined) continue
      const name = displayServer(tool.serverName)
      if (isReadableName(name, server)) found[server] = name
    }
  } catch {
    // no breakdown
  }
  try {
    // The desktop app's own MCP server: it lists claude.ai connectors by name beside their UUID. Absent in a terminal
    // session, where the call rejects and a finished call's provenance (classic.PostToolUse) names the server instead.
    const status = await $.mcp.call('ccd_connectors', 'session_connectors_status')
    const text = status.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    Object.assign(found, parseConnectorStatus(text))
  } catch {
    // no desktop app
  }
  return found
}

// Segments already looked up in this load, so a server no source names is not looked up on every call.
const lookedUp = new Set<string>()

/** Names the given MCP server segments that have no readable name yet. */
const nameServers = async ($: EngineInterface, segments: readonly string[]) => {
  const names = await read($, serverNames)
  const missing = segments.filter(seg => !lookedUp.has(seg) && !isReadableName(names[seg], seg))
  if (missing.length === 0) return
  for (const seg of missing) lookedUp.add(seg)
  const found = await lookupServerNames($)
  await update($, serverNames, current => {
    const next = { ...current }
    for (const seg of missing) {
      const name = found[seg]
      if (name !== undefined) next[seg] = name
    }
    return next
  })
}

/** Sets one server's name from a source that names it directly (a finished call's provenance). */
const setServerName = ($: EngineInterface, segment: string, listed: string) => {
  const name = displayServer(listed)
  if (!isReadableName(name, segment)) return Promise.resolve()
  return update($, serverNames, current => (current[segment] === name ? current : { ...current, [segment]: name }))
}

// --- persistence ------------------------------------------------------------
// $.state lives as long as the process: an app restart empties it. The stats are kept in $.store per session id too,
// written at most every few seconds, at a turn's end and at the session's end, and read back when the session starts.

/** How many sessions' stats the store keeps; older ones fall back to the transcript backfill on resume. */
const KEEP_SESSIONS = 8
/** The longest a change waits before it is written to the store. */
const SAVE_EVERY_MS = 5_000
const SESSIONS_KEY = 'sessions'
const statsKey = (sessionId: string) => `stats:${sessionId}`

/** Stats read back from the store, filled up with the fields a newer version added; undefined when it is not stats. */
export const restoreStats = (saved: unknown, now: number): SessionStats | undefined => {
  if (typeof saved !== 'object' || saved === null || !('tokens' in saved) || !('tools' in saved)) return undefined
  const fresh = emptyStats(now)
  const s = saved as Partial<SessionStats>
  return { ...fresh, ...s, tokens: { ...fresh.tokens, ...s.tokens } }
}

let isDirty = false
let lastSave = 0

const saveStats = async ($: EngineInterface) => {
  const s = await read($, stats)
  if (s === null) return
  isDirty = false
  lastSave = await $.clock.now()
  try {
    const id = await $.session.id()
    await $.store.set(statsKey(id), s)
    const listed = await $.store.get(SESSIONS_KEY)
    const ids = Array.isArray(listed) ? listed.filter((x): x is string => typeof x === 'string') : []
    if (ids.at(-1) === id) return
    const kept = [...ids.filter(x => x !== id), id]
    for (const old of kept.slice(0, -KEEP_SESSIONS)) await $.store.delete(statsKey(old))
    await $.store.set(SESSIONS_KEY, kept.slice(-KEEP_SESSIONS))
  } catch {
    // the store refused (full, or no store): the stats stay in the session
    isDirty = true
  }
}

const loadStats = async ($: EngineInterface, now: number): Promise<SessionStats | undefined> => {
  try {
    return restoreStats(await $.store.get(statsKey(await $.session.id())), now)
  } catch {
    return undefined
  }
}

const change = async ($: EngineInterface, fn: (s: SessionStats) => SessionStats) => {
  isDirty = true
  return update($, stats, s => (s === null ? s : fn(s)))
}

// --- formatting -------------------------------------------------------------

export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`

export const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
}

/** The terminal's unfilled part of a share bar: the same block glyph as the fill in a light grey, so both parts are one width in any font. */
const TRACK_COLOR = '#d9d9d9'
/** Ranked rows shown per section before the tail folds into "Other". */
export const ROW_LIMIT = 8
/** Width of an SVG share meter in CSS pixels, and its thickness. */
const METER_PX = 72
const METER_THICKNESS = 8

/**
 * The meter and token-mix hues. Theme-independent steps (the pane cannot read the app's theme), checked with the
 * dataviz validator in light and dark mode: blue, orange, aqua, yellow pass every gate in both; yellow sits at 2.99:1
 * on the light surface, so the token legend always prints its values.
 */
export const HUES = { blue: '#3987e5', orange: '#d95926', aqua: '#199e70', yellow: '#c98500' } as const
/** The meter of a row in use: the dataviz status "good" step, readable on both surfaces. */
const LIVE_GREEN = '#0ca30c'

/** `n` as a whole percentage of `total`; 0 when there is no total. */
export const sharePercent = (n: number, total: number): number => (total <= 0 ? 0 : Math.round((n / total) * 100))

/** How many of `width` cells a bar fills at `percent`; at least one for any share above zero. */
export const barFill = (percent: number, width: number): number =>
  percent <= 0 ? 0 : Math.max(1, Math.min(width, Math.round((percent / 100) * width)))

/** The first `limit` entries, the rest folded into one `Other (n)` entry; an entry named in `keep` (one in use) is never folded. */
export const foldTail = (
  entries: [string, number][],
  limit = ROW_LIMIT,
  keep: ReadonlySet<string> = new Set(),
): [string, number][] => {
  if (entries.length <= limit) return entries
  const rest = entries.slice(limit - 1)
  const pinned = rest.filter(([name]) => keep.has(name))
  const tail = rest.filter(([name]) => !keep.has(name))
  const other: [string, number][] = tail.length === 0 ? [] : [[`Other (${tail.length})`, tail.reduce((a, [, n]) => a + n, 0)]]
  return [...entries.slice(0, limit - 1), ...pinned, ...other]
}

/** A bar shape square at the baseline (left) with a 4px rounded data-end (right). */
const barPath = (x: number, w: number, h: number) => {
  const r = Math.min(4, h / 2, w)
  return `M${x} 0H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${r}V${h - r}A${r} ${r} 0 0 1 ${x + w - r} ${h}H${x}Z`
}

/** A share meter: a faint track for 100% in the fill's own hue, the share drawn over it. */
export const meterSvg = (percent: number, width = METER_PX, h = METER_THICKNESS, color: string = HUES.blue): string => {
  const w = percent <= 0 ? 0 : Math.max(2, Math.round((Math.min(100, percent) / 100) * width))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">` +
    `<path d="${barPath(0, width, h)}" fill="${color}" fill-opacity="0.18"/>` +
    (w > 0 ? `<path d="${barPath(0, w, h)}" fill="${color}"/>` : '') +
    `</svg>`
  )
}

/** One stacked bar of parts, a 2px gap between segments, square at the baseline and rounded at the end. */
export const stackSvg = (parts: { value: number; color: string }[], width: number, h = 12): string => {
  const shown = parts.filter(p => p.value > 0)
  const total = shown.reduce((a, p) => a + p.value, 0)
  const gap = 2
  const room = width - gap * Math.max(0, shown.length - 1)
  let x = 0
  const rects = shown.map((p, i) => {
    const w = i === shown.length - 1 ? width - x : Math.max(2, Math.round((p.value / total) * room))
    const rect = `<rect x="${x}" y="0" width="${Math.max(0, w)}" height="${h}" fill="${p.color}"/>`
    x += w + gap
    return rect
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">` +
    `<defs><clipPath id="bar"><path d="${barPath(0, width, h)}"/></clipPath></defs>` +
    `<g clip-path="url(#bar)">${rects.join('')}</g></svg>`
  )
}

/** A legend swatch. */
export const swatchSvg = (color: string, size = 10): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="2" fill="${color}"/></svg>`

const truncate = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`)

const shortModel = (id: string) => id.replace(/^claude-/, '')

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0)

const sorted = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

export const tokenTotal = (s: SessionStats) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite

/** Share of input tokens the prompt cache served; undefined before any input. */
export const cacheHitPercent = (s: SessionStats): number | undefined => {
  const input = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite
  return input === 0 ? undefined : Math.round((s.tokens.cacheRead / input) * 100)
}

// --- in use -----------------------------------------------------------------

const isAnythingActive = async ($: EngineInterface) =>
  Object.keys(await read($, activeTools)).length > 0 ||
  Object.keys(await read($, activeSkills)).length > 0 ||
  Object.keys(await read($, activeAgents)).length > 0

/** Keeps only the subagents the agent list still calls running. */
const pruneAgents = async ($: EngineInterface) => {
  const running = new Set((await $.agent.list()).filter(a => RUNNING_STATUSES.has(a.status)).map(a => a.id))
  await update($, activeAgents, a => Object.fromEntries(Object.entries(a).filter(([id]) => running.has(id))))
}

// The one ticker: flips the blink while anything is in use, and moves the clock the times are drawn from.
// Each tick only reads state; the pane redraws when the blink flips or the clock moves to its next second (15 s idle).
let ticker: Timer | null = null
let lastBucket = -1
let lastAgentCheck = 0

const startTicker = ($: EngineInterface) => {
  if (ticker !== null) return
  ticker = $.clock.every(TICK_MS, async () => {
    const isLive = await isAnythingActive($)
    if (isLive) await update($, blink, b => !b)
    else if (await read($, blink)) await update($, blink, () => false)

    const now = await $.clock.now()
    const isWorking = isLive || (await read($, turnStartedAt)) !== null
    const bucket = Math.floor(now / (isWorking ? LIVE_CLOCK_MS : IDLE_CLOCK_MS))
    if (bucket !== lastBucket) {
      lastBucket = bucket
      await update($, clock, () => now)
    }

    if (isDirty && now - lastSave >= SAVE_EVERY_MS) await saveStats($)

    if (now - lastAgentCheck >= AGENT_CHECK_MS && Object.keys(await read($, activeAgents)).length > 0) {
      lastAgentCheck = now
      await pruneAgents($)
    }
  })
}

/** Drops the tool calls of one loop (the main one when `agentId` is absent): a turn's end leaves none of its calls running. */
const endLoop = ($: EngineInterface, agentId: string | undefined) =>
  update($, activeTools, a => Object.fromEntries(Object.entries(a).filter(([, t]) => t.agentId !== agentId)))

// --- hooks ------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await read($, stats)) === null) {
      const now = await $.clock.now()
      // After an app restart the store has this session's stats; otherwise the transcript seeds them.
      let seeded = await loadStats($, now)
      if (seeded === undefined) {
        try {
          seeded = await backfill($, now)
        } catch {
          seeded = emptyStats(now)
        }
      }
      const restored = seeded
      await update($, stats, s => s ?? restored)
      try {
        const running = (await $.agent.list()).filter(a => RUNNING_STATUSES.has(a.status))
        await update($, activeAgents, a => ({ ...Object.fromEntries(running.map(r => [r.id, r.type])), ...a }))
      } catch {
        // no agent list: subagents show in use from their next spawn
      }
      void $.ui.open({ id: PANE, title: TITLE })
    }
    await $.command.register({ name: 'summary', description: 'Show or hide the session summary sidebar' })
    // Every load, so a server named by its fallback earlier gets its readable name.
    await nameServers($, Object.keys((await read($, stats))?.mcp ?? {}))
    startTicker($)
    return next(e)
  })

  on('command.run', { command: 'summary' }, async $ => {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Session summary hidden. /summary shows it again.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Session summary shown.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await change($, s => ({ ...s, prompts: s.prompts + 1 }))
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    const id = e.tool_use_id
    await update($, activeTools, a => ({ ...a, [id]: e.agentId === undefined ? { tool: name } : { tool: name, agentId: e.agentId } }))
    await change($, s => countCall(s, name, e.agentId !== undefined))
    const mcp = parseMcp(name)
    if (mcp) await nameServers($, [mcp.server])
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } finally {
      await update($, activeTools, ({ [id]: _done, ...rest }) => rest)
    }
    const input = e as unknown as Record<string, unknown>
    await change($, s => countOutcome(s, name, input, { isError: result.isError === true, isDenied: result.deny !== undefined }))
    return result
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    await change($, s => ({ ...s, skills: bump(s.skills, e.skill) }))
    await update($, activeSkills, a => ({ ...a, [e.skill]: true as const }))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      const type = e.subagentType || 'general-purpose'
      await change($, s => ({ ...s, agents: bump(s.agents, type) }))
      const id = result.agentId
      if (id !== undefined) await update($, activeAgents, a => ({ ...a, [id]: type }))
    }
    return result
  }).catch(($, e, next) => next(e))

  // Tokens count per model response, so they move during a turn rather than at its end.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (usage) await change($, s => countUsage(s, usage))
    return result
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, turnStartedAt, () => now)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await change($, s => ({
        ...s,
        turns: s.turns + 1,
        workMs: s.workMs + e.durationMs,
        longestTurnMs: Math.max(s.longestTurnMs, e.durationMs),
      }))
      await update($, turnStartedAt, () => null)
      await update($, activeSkills, () => ({}))
      await saveStats($)
    } else {
      const id = e.agentId
      await update($, activeAgents, ({ [id]: _done, ...rest }) => rest)
    }
    await endLoop($, e.agentId)
    return result
  })

  // A finished MCP call names its server as /mcp lists it: the most direct source of a connector's name.
  on('classic.PostToolUse', async ($, e, next) => {
    const mcp = parseMcp(e.tool_name)
    if (mcp && e.mcp_server) await setServerName($, mcp.server, e.mcp_server.name)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await saveStats($)
    if (e.reason === 'clear') {
      // A /clear goes on under a new session id with no session.start: its counts start over.
      const now = await $.clock.now()
      await update($, stats, () => emptyStats(now))
      await update($, activeSkills, () => ({}))
      await update($, turnStartedAt, () => null)
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined) await change($, s => ({ ...s, compactions: s.compactions + 1 }))
    return result
  })

  // --- drawing ----------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Desktop, VS Code and mobile draw SVG; the terminal gets a text form of the same layout.
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const s = await read($, stats)
    const names = await read($, serverNames)
    const folded = await read($, collapsed)
    const liveTools = new Set(Object.values(await read($, activeTools)).map(t => t.tool))
    const liveSkills = new Set(Object.keys(await read($, activeSkills)))
    const liveBuiltins = new Set([...liveTools].filter(name => parseMcp(name) === undefined))
    const liveServers = new Set([...liveTools].flatMap(name => parseMcp(name)?.server ?? []))
    const liveAgents = new Set(Object.values(await read($, activeAgents)))
    const isBlinkDim = await read($, blink) // subscribes the pane to the blink, so rows in use flash
    await read($, clock) // subscribes the pane to the ticker, so the times move
    const runningSince = await read($, turnStartedAt)
    const now = await $.clock.now()
    const workMs = s === null ? 0 : s.workMs + (runningSince === null ? 0 : Math.max(0, now - runningSince))
    const { startedAt } = await $.session.usage()
    const cols = Math.max(24, e.props.bodyColumns)
    const inner = cols - 2
    const textBarWidth = inner >= 40 ? 10 : 6

    if (s === null) return <Text dimColor>Collecting…</Text>

    const toggle = (key: string) => update($, collapsed, c => ({ ...c, [key]: !c[key] }))
    const setAll = (isFolded: boolean) =>
      update($, collapsed, () => Object.fromEntries(SECTIONS.map(k => [k, isFolded])))
    const allFolded = SECTIONS.every(k => folded[k])

    const kv = (key: string, label: string, value: string) => (
      <Box key={key} width="100%" flexDirection="row" justifyContent="space-between">
        <Text dimColor wrap="truncate-end">{label}</Text>
        <Text>{value}</Text>
      </Box>
    )

    const tile = (key: string, label: string, value: string) => (
      <Box key={key} width="50%" flexDirection="column" marginBottom={1}>
        <Text dimColor>{label}</Text>
        <Text bold>{value}</Text>
      </Box>
    )

    const swatch = (color: string, label: string) =>
      Svg ? <Svg source={swatchSvg(color)} alt={label} /> : <Text color={color}>■</Text>

    const meter = (percent: number, alt: string, color: string) => {
      if (Svg) return <Svg source={meterSvg(percent, undefined, undefined, color)} alt={alt} />
      const filled = barFill(percent, textBarWidth)
      return (
        <Text wrap="truncate">
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text color={TRACK_COLOR}>{'█'.repeat(textBarWidth - filled)}</Text>
        </Text>
      )
    }

    type RowOptions = { showPercent?: boolean; isLive?: boolean }

    /** A ranked row: name, its share of `total` as a meter, optionally the share, the count. In use: green, bold, blinking. */
    const shareRow = (key: string, name: string, n: number, total: number, unit: string, o: RowOptions = {}) => {
      const percent = sharePercent(n, total)
      return (
        <Box key={key} width="100%" flexDirection="row" alignItems="center" gap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            {o.isLive ? (
              <Box key={`live-${key}`}>
                <Text color="success" bold dimColor={isBlinkDim} wrap="truncate-end">
                  {name}
                </Text>
              </Box>
            ) : (
              <Text wrap="truncate-end">{name}</Text>
            )}
          </Box>
          {meter(percent, `${name}: ${percent}% of ${unit}${o.isLive ? ', in use' : ''}`, o.isLive ? LIVE_GREEN : HUES.blue)}
          {o.showPercent ? (
            <Box width={4} flexDirection="row" justifyContent="flex-end">
              <Text dimColor>{percent}%</Text>
            </Box>
          ) : null}
          <Box width={5} flexDirection="row" justifyContent="flex-end">
            {o.isLive ? (
              <Text bold color="success">
                {n > 0 ? `${n}` : ''}
              </Text>
            ) : (
              <Text bold>{n}</Text>
            )}
          </Box>
        </Box>
      )
    }

    /** Ranked rows of `counts`; names in `live` are drawn in use, listed even before their first call completes. */
    const ranked = (prefix: string, counts: Record<string, number>, unit: string, live: ReadonlySet<string>, showPercent: boolean) => {
      const total = sum(counts)
      const withLive = { ...Object.fromEntries([...live].map(name => [name, 0])), ...counts }
      return foldTail(sorted(withLive), ROW_LIMIT, live).map(([name, n]) =>
        shareRow(`${prefix}-${name}`, name, n, total, unit, { showPercent, isLive: live.has(name) }),
      )
    }

    const section = (key: string, title: string, summary: string, body: () => unknown) => (
      <Box key={`sec-${key}`} flexDirection="column" marginBottom={1}>
        <Box key={`head-${key}`} flexDirection="row" gap={1}>
          <Button key={`toggle-${key}`} plain label={`${folded[key] ? '▶' : '▼'} ${title}`} onPress={() => toggle(key)} />
          <Text dimColor>{summary}</Text>
        </Box>
        {folded[key] ? null : (
          <Box key={`body-${key}`} flexDirection="column" paddingLeft={2} marginTop={1}>
            {body() as never}
          </Box>
        )}
      </Box>
    )

    const empty = (key: string) => (
      <Text key={`${key}-empty`} dimColor>
        none yet
      </Text>
    )

    const total = tokenTotal(s)
    const hit = cacheHitPercent(s)
    const toolCount = sum(s.tools)
    const mcpCount = Object.values(s.mcp).reduce((a, m) => a + m.total, 0)
    const agentCount = sum(s.agents)
    const skillCount = sum(s.skills)
    const tracked = s.trackedSince - startedAt > 60_000
    const mix = [
      { key: 'in', label: 'input', value: s.tokens.input, color: HUES.blue },
      { key: 'cw', label: 'cache write', value: s.tokens.cacheWrite, color: HUES.orange },
      { key: 'cr', label: 'cache read', value: s.tokens.cacheRead, color: HUES.aqua },
      { key: 'out', label: 'output', value: s.tokens.output, color: HUES.yellow },
    ]
    const stackWidth = Math.min(360, Math.max(120, inner * 7))

    return (
      <Box flexDirection="column">
        <Box key="top" width="100%" flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text dimColor>started {formatDuration(now - startedAt)} ago</Text>
          <Button key="all" plain dimColor label={allFolded ? 'expand all' : 'collapse all'} onPress={() => setAll(!allFolded)} />
        </Box>

        <Box key="kpi" width="100%" flexDirection="row" flexWrap="wrap">
          {tile('kpi-tokens', 'Tokens', formatTokens(total))}
          {tile('kpi-hit', 'Cache hit', hit === undefined ? '–' : `${hit}%`)}
          {tile('kpi-tools', 'Tool calls', `${toolCount + mcpCount}`)}
          {tile('kpi-work', 'Claude working', formatDuration(workMs))}
        </Box>

        {s.isBackfilled || tracked ? (
          <Box key="note" marginBottom={1}>
            <Text dimColor wrap="wrap">
              Loaded mid-session: tokens and times count from {formatDuration(now - s.trackedSince)} ago.
            </Text>
          </Box>
        ) : null}

        {section('tokens', 'Tokens', formatTokens(total), () => [
          total > 0 && Svg ? (
            <Box key="t-stack" marginBottom={1}>
              <Svg source={stackSvg(mix, stackWidth)} alt={mix.map(m => `${m.label} ${formatTokens(m.value)}`).join(', ')} />
            </Box>
          ) : null,
          ...mix.map(m => (
            <Box key={`t-${m.key}`} width="100%" flexDirection="row" alignItems="center" gap={1}>
              {swatch(m.color, m.label)}
              <Box flexGrow={1}>
                <Text dimColor>{m.label}</Text>
              </Box>
              <Text>{formatTokens(m.value)}</Text>
              <Box width={4} flexDirection="row" justifyContent="flex-end">
                <Text dimColor>{sharePercent(m.value, total)}%</Text>
              </Box>
            </Box>
          )),
          ...sorted(s.byModel).map(([model, n], i) => (
            <Box key={`t-m-${model}`} width="100%" flexDirection="row" justifyContent="space-between" marginTop={i === 0 ? 1 : 0}>
              <Text dimColor>{shortModel(model)}</Text>
              <Text>{formatTokens(n)}</Text>
            </Box>
          )),
        ])}

        {section('activity', 'Activity', `${s.prompts} prompts`, () => [
          kv('a-p', 'Prompts · turns', `${s.prompts} · ${s.turns}`),
          kv('a-w', 'Working · session', `${formatDuration(workMs)} · ${formatDuration(now - startedAt)}`),
          kv('a-l', 'Longest turn', formatDuration(s.longestTurnMs)),
          kv('a-f', 'Files edited · read', `${s.filesEdited.length} · ${s.filesRead.length}`),
          kv('a-e', 'Tool errors · denied', `${s.toolErrors} · ${s.toolDenied}`),
          kv('a-s', 'Tool calls in subagents', `${s.subagentToolCalls}`),
          kv('a-c', 'Compactions', `${s.compactions}`),
        ])}

        {section('tools', 'Tools', `${toolCount} calls`, () =>
          toolCount === 0 && liveBuiltins.size === 0 ? empty('tools') : ranked('tool', s.tools, 'tool calls', liveBuiltins, false),
        )}

        {section('skills', 'Skills', `${skillCount}`, () =>
          skillCount === 0 && liveSkills.size === 0 ? empty('skills') : ranked('skill', s.skills, 'skill uses', liveSkills, false),
        )}

        {section('connectors', 'Connectors & MCP', `${mcpCount} calls`, () =>
          mcpCount === 0
            ? empty('mcp')
            : Object.entries(s.mcp)
                .sort((a, b) => b[1].total - a[1].total)
                .flatMap(([server, calls]) => {
                  const listed = names[server]
                  return [
                  shareRow(`srv-${server}`, isReadableName(listed, server) ? listed : fallbackServer(server), calls.total, mcpCount, 'MCP calls', {
                    isLive: liveServers.has(server),
                  }),
                  ...foldTail(sorted(calls.tools), 5, new Set(Object.keys(calls.tools).filter(t => liveTools.has(`mcp__${server}__${t}`)))).map(
                    ([tool, n]) => (
                      <Box key={`srvtool-${server}-${tool}`} width="100%" flexDirection="row" justifyContent="space-between" paddingLeft={2}>
                        {liveTools.has(`mcp__${server}__${tool}`) ? (
                          <Box key={`live-srvtool-${server}-${tool}`}>
                            <Text color="success" bold dimColor={isBlinkDim} wrap="truncate-end">
                              {tool}
                            </Text>
                          </Box>
                        ) : (
                          <Text dimColor wrap="truncate-end">
                            {tool}
                          </Text>
                        )}
                        <Text dimColor>{n}</Text>
                      </Box>
                    ),
                  ),
                  ]
                }),
        )}

        {section('agents', 'Subagents', `${agentCount}`, () =>
          agentCount === 0 && liveAgents.size === 0 ? empty('agents') : ranked('agent', s.agents, 'subagents', liveAgents, false),
        )}
      </Box>
    )
  })
}
