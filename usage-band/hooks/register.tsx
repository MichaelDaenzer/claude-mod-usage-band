import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { UsageSnapshot } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)

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

export const bar = (percent: number, width: number): string => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Width of the leading label column, so the first bar of each row starts at one edge. */
const LABEL_WIDTH = 4

const levelColor = (percent: number): 'success' | 'warning' | 'error' =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'

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
    const { Box, Text } = $.ui.resolve(e)
    const barWidth = e.props.bodyColumns >= 80 ? 20 : 10
    const ctx = s.contextPercent

    return (
      <Box flexDirection="column">
        <Box key="context" gap={1}>
          <Box width={LABEL_WIDTH}>
            <Text dimColor>ctx</Text>
          </Box>
          {ctx === undefined ? (
            <Text dimColor>–/{formatTokens(s.contextWindow)}</Text>
          ) : (
            <Box gap={1}>
              <Text color={levelColor(ctx)}>{bar(ctx, barWidth)}</Text>
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
                  <Text color={levelColor(r.percentUsed)}>{bar(r.percentUsed, barWidth)}</Text>
                  <Text bold color={levelColor(r.percentUsed)}>{r.percentUsed}%</Text>
                  {reset ? <Text dimColor>↻ {reset}</Text> : null}
                </Box>
              )
            })}
          </Box>
        ) : null}
      </Box>
    )
  })
}
