import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import type { CacheState, UsageSnapshot } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const isCollapsed = atom({ plugin: 'usage-band', key: 'isCollapsed' } as const, false)
const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, { expiresAt: null, isBusy: false } as CacheState)
// What the band shows for the cache; the tick rewrites it only when the text changes, which redraws the band.
const cacheLabel = atom({ plugin: 'usage-band', key: 'cacheLabel' } as const, '')

type Figures = { context: SessionContextUsage; rateLimits: SessionRateLimit[] }

/**
 * How long the prompt cache stays warm after the last response. The plugin
 * API does not report the session's TTL; this build's sessions use the
 * 1-hour cache (5 minutes only under usage overage).
 */
export const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_MS = 10 * 60 * 1000

const toSnapshot = (f: Figures): UsageSnapshot => ({
  contextTokens: f.context.tokens,
  contextWindow: f.context.window,
  contextPercent: f.context.percent,
  rateLimits: f.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
})

export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`

export const windowLabel = (kind: string): string =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind

export const resetIn = (resetsAt: string | undefined, now: number): string => {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`
}

/** How many of `width` cells a bar fills at `percent`. */
export const barFill = (percent: number, width: number): number =>
  Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

/**
 * The cache's state as the band words it: `hot · 58m` while the cache is warm
 * with the time until it goes cold, `hot · in use` while a turn runs, `cold`
 * once the TTL has passed or before the first answer.
 */
export const cacheText = (c: CacheState, now: number): string => {
  if (c.isBusy) return 'hot · in use'
  if (c.expiresAt === null || c.expiresAt <= now) return 'cold'
  const left = c.expiresAt - now
  const minutes = Math.ceil(left / 60_000)
  return minutes >= 2 ? `hot · ${minutes}m` : `hot · ${Math.ceil(left / 1000)}s`
}

const cacheColor = (c: CacheState, now: number): 'success' | 'warning' | undefined => {
  if (c.isBusy) return 'success'
  if (c.expiresAt === null || c.expiresAt <= now) return undefined
  return c.expiresAt - now <= CACHE_WARN_MS ? 'warning' : 'success'
}

/** Width of the leading label column, so the first bar of each row starts at one edge. */
const LABEL_WIDTH = 4
/** Width of the second column's label (`7d`, `cache`), so its bars and text start at one edge. */
const LABEL2_WIDTH = 6
/** The unfilled part of a bar: the same block glyph as the fill, in a light grey, so both parts are the same width in any font. */
const TRACK_COLOR = '#d9d9d9'
/** Cells between the two columns. */
const COLUMN_GAP = 3
/** Cells kept for the collapse handle and a margin before it. */
const HANDLE_WIDTH = 4
const MIN_BAR_WIDTH = 4
const MAX_BAR_WIDTH = 20

const levelColor = (percent: number): 'success' | 'warning' | 'error' =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'

/** The one-line form the collapsed band shows: `ctx 60% · 5h 23.5% · 7d 91% · cache hot · 58m`. */
export const summaryText = (s: UsageSnapshot, c: CacheState, now: number): string =>
  [
    s.contextPercent === undefined ? 'ctx –' : `ctx ${s.contextPercent}%`,
    ...s.rateLimits.map(r => `${windowLabel(r.kind)} ${r.percentUsed}%`),
    `cache ${cacheText(c, now)}`,
  ].join(' · ')

const refreshCacheLabel = async ($: EngineInterface) => {
  const text = cacheText(await read($, cache), await $.clock.now())
  if (text !== (await read($, cacheLabel))) await update($, cacheLabel, () => text)
  return text
}

// The countdown's tick: started when an answer warms the cache, stopped once it is cold.
let tick: Timer | null = null

const startTick = ($: EngineInterface) => {
  if (tick !== null) return
  tick = $.clock.every(1000, async () => {
    if ((await refreshCacheLabel($)) === 'cold' && tick !== null) {
      tick.cancel()
      tick = null
    }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined) // clears a status line an earlier version of this mod pinned
    const usage = await $.session.usage()
    await update($, snapshot, () => toSnapshot(usage))
    if ((await read($, cache)).expiresAt !== null) startTick($) // a reload mid-countdown
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, () => toSnapshot(e))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, cache, c => ({ ...c, isBusy: true }))
    await refreshCacheLabel($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + CACHE_TTL_MS, isBusy: false }))
      await refreshCacheLabel($)
      startTick($)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null) return next(e)

    const now = await $.clock.now()
    const c = await read($, cache)
    await read($, cacheLabel) // subscribes the band to the tick, so the countdown redraws
    const { Box, Button, Text } = $.ui.resolve(e)
    const collapsed = await read($, isCollapsed)
    const toggle = (
      <Button
        key="toggle"
        plain
        dimColor
        label={collapsed ? '▶' : '▼'}
        onPress={() => update($, isCollapsed, v => !v)}
      />
    )

    if (collapsed) {
      return (
        <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between">
          <Box key="summary" flexShrink={1}>
            <Text dimColor wrap="truncate-end">{summaryText(s, c, now)}</Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            {toggle}
          </Box>
        </Box>
      )
    }

    // Cells each column needs besides its bar: label, gaps, `100%`, and the
    // tokens text (`257k/1.0M`) or the reset text (`↻ 23h 59m`).
    const column1Fixed = LABEL_WIDTH + 1 + 1 + 5 + 1 + 10
    const column2Fixed = LABEL2_WIDTH + 1 + 1 + 5 + 1 + 10
    // The bars take what is left of the band's width, between 4 and 20 cells,
    // so a narrow window shrinks the bars and never the handle.
    const available = e.props.bodyColumns - HANDLE_WIDTH - COLUMN_GAP - column1Fixed - column2Fixed
    const barWidth = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, Math.floor(available / 2)))
    // The first column holds the context cell and the first window's cell at
    // this width, so the second column (cache above, the second window below) lines up.
    const columnWidth = column1Fixed + barWidth
    const ctx = s.contextPercent
    const [first, ...rest] = s.rateLimits

    const bar = (percent: number) => (
      <Box>
        <Text color={levelColor(percent)}>{'█'.repeat(barFill(percent, barWidth))}</Text>
        <Text color={TRACK_COLOR}>{'█'.repeat(barWidth - barFill(percent, barWidth))}</Text>
      </Box>
    )

    const windowCell = (r: NonNullable<typeof first>, labelWidth: number) => {
      const reset = resetIn(r.resetsAt, now)
      return (
        <Box key={`limit-${r.kind}`} gap={1}>
          <Box width={labelWidth}>
            <Text dimColor>{windowLabel(r.kind)}</Text>
          </Box>
          {bar(r.percentUsed)}
          <Text bold color={levelColor(r.percentUsed)}>{r.percentUsed}%</Text>
          {reset ? <Text dimColor>↻ {reset}</Text> : null}
        </Box>
      )
    }

    const color = cacheColor(c, now)

    return (
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="flex-start">
        <Box flexDirection="column" flexShrink={1}>
          <Box flexDirection="row" gap={COLUMN_GAP}>
            <Box key="context" width={columnWidth} gap={1}>
              <Box width={LABEL_WIDTH}>
                <Text dimColor>ctx</Text>
              </Box>
              {ctx === undefined ? (
                <Text dimColor>–/{formatTokens(s.contextWindow)}</Text>
              ) : (
                <Box gap={1}>
                  {bar(ctx)}
                  <Text bold color={levelColor(ctx)}>{ctx}%</Text>
                  <Text dimColor>
                    {formatTokens(s.contextTokens ?? 0)}/{formatTokens(s.contextWindow)}
                  </Text>
                </Box>
              )}
            </Box>
            <Box key="cache" gap={1}>
              <Box width={LABEL2_WIDTH}>
                <Text dimColor>cache</Text>
              </Box>
              {color ? (
                <Text bold color={color}>{cacheText(c, now)}</Text>
              ) : (
                <Text dimColor>{cacheText(c, now)}</Text>
              )}
            </Box>
          </Box>
          {first ? (
            <Box key="limits" flexDirection="row" gap={COLUMN_GAP}>
              <Box width={columnWidth}>{windowCell(first, LABEL_WIDTH)}</Box>
              {rest.map(r => windowCell(r, LABEL2_WIDTH))}
            </Box>
          ) : null}
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          {toggle}
        </Box>
      </Box>
    )
  })
}
