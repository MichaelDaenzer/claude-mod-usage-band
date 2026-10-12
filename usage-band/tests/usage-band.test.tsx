import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, formatTokens, resetIn } from '../hooks/register'

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-10-12T10:00:00Z')

const FIGURES = {
  context: { tokens: 120_000, window: 200_000, percent: 60 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-12T12:30:00Z' },
    { kind: 'seven_day', percentUsed: 91, resetsAt: '2026-10-15T10:00:00Z' },
  ],
  cost: { usd: 1.2345 },
}

test('formatting helpers', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(120_000)).toBe('120k')
  expect(formatTokens(1_500_000)).toBe('1.5M')
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(0, 4)).toBe('░░░░')
  expect(bar(100, 4)).toBe('████')
  expect(resetIn('2026-10-12T12:30:00Z', NOW)).toBe('2h 30m')
  expect(resetIn('2026-10-15T10:00:00Z', NOW)).toBe('3d')
  expect(resetIn(undefined, NOW)).toBe('')
  expect(resetIn('2026-10-12T09:00:00Z', NOW)).toBe('')
})

const empty = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="empty" />
  })

test('band draws nothing before the first figures and yields to a survey', async ($, on) => {
  mock.clock(on, { now: NOW })
  empty(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('band shows context and rate limits after a measurement', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ value: { startedAt: NOW, ...FIGURES } }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  empty(on)

  await $.session.measure({ ...FIGURES, changed: ['context', 'rateLimits', 'cost'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Box', key: 'context' }))?.text).toContain('60%')
    expect((await ui.find({ type: 'Box', key: 'context' }))?.text).toContain('120k/200k')
    expect((await ui.find({ type: 'Box', key: 'limit-five_hour' }))?.text).toContain('23.5%')
    expect((await ui.find({ type: 'Box', key: 'limit-five_hour' }))?.text).toContain('2h 30m')
    expect((await ui.find({ type: 'Box', key: 'limit-seven_day' }))?.text).toContain('91%')
    expect(await ui.find({ type: 'Box', key: 'cost' })).toBeUndefined()
    const limits = await ui.find({ type: 'Box', key: 'limits' })
    expect(limits?.text).toContain('5h')
    expect(limits?.text).toContain('7d')
    expect(limits?.text).not.toContain('$')
    await ui.unmount()
  }

  const survey = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.find({ type: 'Box', key: 'context' })).toBeUndefined()
  await survey.unmount()
})
