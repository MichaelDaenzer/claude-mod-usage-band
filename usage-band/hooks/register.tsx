import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { UsageSnapshot } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const isCollapsed = atom({ plugin: 'usage-band', key: 'isCollapsed' } as const, false)

type Figures = { context: SessionContextUsage; rateLimits: SessionRateLimit[] }

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

/** Width of the leading label column, so the first bar of each row starts at one edge. */
const LABEL_WIDTH = 4

/**
 * The unfilled part of a bar: the same block glyph as the fill, in the theme's
 * subtle grey (close to the panel background in light and dark themes), so
 * both parts are the same width in any font. Each span also paints its
 * background in its own color, which fills the hairline gaps a proportional
 * font leaves between block glyphs.
 */
const TRACK_COLOR = 'subtle'

const levelColor = (percent: number): 'success' | 'warning' | 'error' =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'

/** The one-line form the collapsed band shows: `ctx 60% · 5h 23.5% · 7d 91%`. */
export const summaryText = (s: UsageSnapshot): string =>
  [
    s.contextPercent === undefined ? 'ctx –' : `ctx ${s.contextPercent}%`,
    ...s.rateLimits.map(r => `${windowLabel(r.kind)} ${r.percentUsed}%`),
  ].join(' · ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined) // clears a status line an earlier version of this mod pinned
    const usage = await $.session.usage()
    await update($, snapshot, () => toSnapshot(usage))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, () => toSnapshot(e))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null) return next(e)

    const now = await $.clock.now()
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
        <Box flexDirection="row" justifyContent="space-between">
          <Box key="summary">
            <Text dimColor>{summaryText(s)}</Text>
          </Box>
          {toggle}
        </Box>
      )
    }

    const barWidth = e.props.bodyColumns >= 80 ? 20 : 10
    const ctx = s.contextPercent

    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
        <Box flexDirection="column">
          <Box key="context" gap={1}>
            <Box width={LABEL_WIDTH}>
              <Text dimColor>ctx</Text>
            </Box>
            {ctx === undefined ? (
              <Text dimColor>–/{formatTokens(s.contextWindow)}</Text>
            ) : (
              <Box gap={1}>
                <Box>
                  <Text color={levelColor(ctx)} backgroundColor={levelColor(ctx)}>{'█'.repeat(barFill(ctx, barWidth))}</Text>
                  <Text color={TRACK_COLOR} backgroundColor={TRACK_COLOR}>{'█'.repeat(barWidth - barFill(ctx, barWidth))}</Text>
                </Box>
                <Text bold color={levelColor(ctx)}>{ctx}%</Text>
                <Text dimColor>
                  {formatTokens(s.contextTokens ?? 0)}/{formatTokens(s.contextWindow)}
                </Text>
              </Box>
            )}
          </Box>
          {s.rateLimits.length > 0 ? (
            <Box key="limits" flexDirection="row" gap={3}>
              {s.rateLimits.map((r, i) => {
                const reset = resetIn(r.resetsAt, now)
                return (
                  <Box key={`limit-${r.kind}`} gap={1}>
                    <Box width={i === 0 ? LABEL_WIDTH : undefined}>
                      <Text dimColor>{windowLabel(r.kind)}</Text>
                    </Box>
                    <Box>
                      <Text color={levelColor(r.percentUsed)} backgroundColor={levelColor(r.percentUsed)}>{'█'.repeat(barFill(r.percentUsed, barWidth))}</Text>
                      <Text color={TRACK_COLOR} backgroundColor={TRACK_COLOR}>{'█'.repeat(barWidth - barFill(r.percentUsed, barWidth))}</Text>
                    </Box>
                    <Text bold color={levelColor(r.percentUsed)}>{r.percentUsed}%</Text>
                    {reset ? <Text dimColor>↻ {reset}</Text> : null}
                  </Box>
                )
              })}
            </Box>
          ) : null}
        </Box>
        {toggle}
      </Box>
    )
  })
}
