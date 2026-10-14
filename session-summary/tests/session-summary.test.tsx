import { test, expect, mock } from 'claude-code/testing'

import {
  barFill,
  foldTail,
  meterSvg,
  stackSvg,
  cacheHitPercent,
  countMessages,
  countTool,
  displayServer,
  emptyStats,
  fallbackServer,
  isReadableName,
  formatDuration,
  formatTokens,
  parseConnectorStatus,
  parseMcp,
  restoreStats,
  sharePercent,
} from '../hooks/register'

const NOW = Date.parse('2026-10-13T10:00:00Z')
const JIRA = 'mcp__00fced78-8857-4bb8-8447-8bc4183263d0__getJiraIssue'

const PANE = {
  plugin: 'session-summary',
  component: 'Pane',
  requestId: 'session-summary',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

test('helpers: MCP names, formatting, cache hit rate', () => {
  expect(parseMcp(JIRA)).toEqual({ server: '00fced78-8857-4bb8-8447-8bc4183263d0', tool: 'getJiraIssue' })
  expect(parseMcp('mcp__ccd_session__mark_chapter')).toEqual({ server: 'ccd_session', tool: 'mark_chapter' })
  expect(parseMcp('Bash')).toBeUndefined()
  expect(displayServer('claude.ai Atlassian')).toBe('Atlassian')
  expect(displayServer('plugin:polaris:polaris')).toBe('polaris')
  expect(displayServer('plugin:product-management:slack')).toBe('product-management/slack')
  expect(displayServer('Atlassian MCP')).toBe('Atlassian')
  expect(
    parseConnectorStatus(
      JSON.stringify({ servers: [{ name: 'Atlassian MCP', id: '00fced78-8857-4bb8-8447-8bc4183263d0' }, { name: 'scheduled-tasks' }] }),
    ),
  ).toEqual({ '00fced78-8857-4bb8-8447-8bc4183263d0': 'Atlassian' })
  expect(parseConnectorStatus('not json')).toEqual({})
  expect(isReadableName('Atlassian', '00fced78-8857-4bb8-8447-8bc4183263d0')).toBe(true)
  expect(isReadableName('00fced78-8857-4bb8-8447-8bc4183263d0', '00fced78-8857-4bb8-8447-8bc4183263d0')).toBe(false)
  expect(isReadableName('connector 00fced78', '00fced78-8857-4bb8-8447-8bc4183263d0')).toBe(false)
  expect(isReadableName(undefined, 'x')).toBe(false)
  expect(fallbackServer('00fced78-8857-4bb8-8447-8bc4183263d0')).toBe('connector 00fced78')
  expect(fallbackServer('claude_ai_Google_Drive')).toBe('Google Drive')
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(12_345)).toBe('12.3k')
  expect(formatTokens(250_000)).toBe('250k')
  expect(formatTokens(3_400_000)).toBe('3.4M')
  expect(formatDuration(42_000)).toBe('42s')
  expect(formatDuration(252_000)).toBe('4m 12s')
  expect(formatDuration(5_400_000)).toBe('1h 30m')

  expect(sharePercent(2, 3)).toBe(67)
  expect(sharePercent(1, 0)).toBe(0)
  expect(barFill(67, 10)).toBe(7)
  expect(barFill(1, 10)).toBe(1)
  expect(barFill(0, 10)).toBe(0)
  expect(barFill(100, 6)).toBe(6)
  expect(foldTail([['a', 5], ['b', 4], ['c', 3], ['d', 1]], 3)).toEqual([['a', 5], ['b', 4], ['Other (2)', 4]])
  expect(foldTail([['a', 5]], 3)).toEqual([['a', 5]])
  expect(meterSvg(50, 72)).toContain('fill-opacity="0.18"')
  expect(stackSvg([{ value: 1, color: '#000' }, { value: 0, color: '#111' }, { value: 3, color: '#222' }], 100)).not.toContain('#111')

  const s = { ...emptyStats(NOW), tokens: { input: 100, output: 50, cacheRead: 800, cacheWrite: 100 } }
  expect(cacheHitPercent(s)).toBe(80)
  expect(cacheHitPercent(emptyStats(NOW))).toBeUndefined()
})

test('countTool splits built-in and MCP calls and tracks files, errors and subagent calls', () => {
  let s = emptyStats(NOW)
  s = countTool(s, 'Read', { file_path: 'a.ts' }, {})
  s = countTool(s, 'Read', { file_path: 'a.ts' }, {})
  s = countTool(s, 'Edit', { file_path: 'b.ts' }, { inSubagent: true })
  s = countTool(s, 'Write', { file_path: 'c.ts' }, { isError: true })
  s = countTool(s, 'Bash', { command: 'ls' }, { isDenied: true })
  s = countTool(s, JIRA, {}, {})
  s = countTool(s, JIRA, {}, {})

  expect(s.tools).toEqual({ Read: 2, Edit: 1, Write: 1, Bash: 1 })
  expect(s.mcp['00fced78-8857-4bb8-8447-8bc4183263d0']).toEqual({ total: 2, tools: { getJiraIssue: 2 } })
  expect(s.filesRead).toEqual(['a.ts'])
  expect(s.filesEdited).toEqual(['b.ts'])
  expect(s.toolErrors).toBe(1)
  expect(s.toolDenied).toBe(1)
  expect(s.subagentToolCalls).toBe(1)
})

test('countMessages seeds prompts, tools and Skill calls from a transcript', () => {
  const s = countMessages(
    emptyStats(NOW),
    [
      { role: 'user', text: 'build a mod', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: '1', tool: 'Skill', input: { skill: 'plugin-authoring' } },
          { tool_use_id: '2', tool: 'Bash', input: { command: 'ls' }, isError: true },
        ],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [] },
    ],
    false,
  )
  expect(s.prompts).toBe(1)
  expect(s.skills).toEqual({ 'plugin-authoring': 1 })
  expect(s.tools).toEqual({ Skill: 1, Bash: 1 })
  expect(s.toolErrors).toBe(1)
})

test('the pane shows live counts and folds sections', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({
    value: { startedAt: NOW - 600_000, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: 'claude-opus-5-5', input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 1_000 },
    }
  })

  await $.session.start({ cwd: 'C:/Sources', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
  await $.tool.call({ tool: 'Read', file_path: 'b.ts' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.skill.prompt({ skill: 'plugin-authoring', text: 'x' })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _chunk of step) {
    // drain
  }
  await step.result
  await $.turn.complete({ answer: 'ok', durationMs: 65_000, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'head-tokens' }))?.text).toContain('12.0k')
    expect((await ui.find({ key: 'kpi-hit' }))?.text).toContain('80%')
    expect((await ui.find({ key: 't-m-claude-opus-5-5' }))?.text).toContain('opus-5-5')
    expect((await ui.find({ key: 'head-tools' }))?.text).toContain('3 calls')
    expect((await ui.find({ key: 'tool-Read' }))?.text).toContain('2')
    expect((await ui.find({ key: 'tool-Bash' }))?.text).toContain('1')
    expect((await ui.find({ key: 'skill-plugin-authoring' }))?.text).toContain('1')
    if (surface === 'terminal') {
      // no percentage beside tool and skill bars (on desktop the bar's alt text still names the share)
      expect((await ui.find({ key: 'tool-Read' }))?.text).not.toContain('%')
      expect((await ui.find({ key: 'skill-plugin-authoring' }))?.text).not.toContain('%')
    }
    expect(await ui.find({ key: 'live-tool-Read' })).toBeUndefined()
    expect((await ui.find({ key: 'a-l' }))?.text).toContain('1m 5s')

    await ui.press({ key: 'toggle-tools' })
    expect(await ui.find({ key: 'tool-Read' })).toBeUndefined()
    await ui.press({ key: 'toggle-tools' })
    expect(await ui.find({ key: 'tool-Read' })).toBeDefined()

    await ui.press({ key: 'all' })
    expect(await ui.find({ key: 't-cr' })).toBeUndefined()
    await ui.press({ key: 'all' })
    expect(await ui.find({ key: 't-cr' })).toBeDefined()
    await ui.unmount()
  }
})

test('a running tool and an invoked skill are drawn in use until they end', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.usage', () => ({
    value: { startedAt: NOW - 600_000, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.session.start({ cwd: 'C:/Sources', surface: 'desktop', isInteractive: true })
  const running = $.tool.call({ tool: 'Grep', pattern: 'x' })
  await $.skill.prompt({ skill: 'dataviz', text: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'live-tool-Grep' })).toBeDefined()
  expect(await ui.find({ key: 'live-skill-dataviz' })).toBeDefined()
  await clock.advance(600)
  expect(await ui.find({ key: 'live-tool-Grep' })).toBeDefined()

  release()
  await running
  expect(await ui.find({ key: 'live-tool-Grep' })).toBeUndefined()
  expect((await ui.find({ key: 'tool-Grep' }))?.text).toContain('1')
  expect(await ui.find({ key: 'live-skill-dataviz' })).toBeDefined()

  await $.turn.complete({ answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await ui.find({ key: 'live-skill-dataviz' })).toBeUndefined()
  await ui.unmount()
})

test('a running subagent and a connector whose tool runs are drawn in use, and the working time moves', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.usage', () => ({
    value: { startedAt: NOW - 600_000, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: [] }))
  const agents: { id: string; description: string; type: string; status: 'running' }[] = []
  on('agent.list', () => ({ value: agents }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('tool.call', async () => {
    await gate
    return { result: {} }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.session.start({ cwd: 'C:/Sources', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'scan',
    description: 'scan',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  agents.push({ id: 'a1', description: 'scan', type: 'Explore', status: 'running' })
  const running = $.tool.call({ tool: JIRA })
  await clock.advance(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'live-agent-Explore' })).toBeDefined()
  expect(await ui.find({ key: 'live-srv-00fced78-8857-4bb8-8447-8bc4183263d0' })).toBeDefined()
  expect(await ui.find({ key: 'live-srvtool-00fced78-8857-4bb8-8447-8bc4183263d0-getJiraIssue' })).toBeDefined()
  expect((await ui.find({ key: 'head-connectors' }))?.text).toContain('1 calls')

  await clock.advance(5_000)
  expect((await ui.find({ key: 'kpi-work' }))?.text).toContain('5s')

  release()
  await running
  expect(await ui.find({ key: 'live-srv-00fced78-8857-4bb8-8447-8bc4183263d0' })).toBeUndefined()

  await $.turn.complete({ answer: 'done', durationMs: 4_000, isAborted: false, turnId: 'a-t1', reason: 'answer', agentId: 'a1' })
  expect(await ui.find({ key: 'live-agent-Explore' })).toBeUndefined()
  expect((await ui.find({ key: 'agent-Explore' }))?.text).toContain('1')
  await ui.unmount()
})

test('stats saved to the store come back after a restart', async ($, on) => {
  const saved = {
    ...emptyStats(NOW - 60_000),
    tokens: { input: 5_000, output: 1_000, cacheRead: 40_000, cacheWrite: 4_000 },
    tools: { Bash: 7 },
    workMs: 125_000,
  }
  expect(restoreStats(saved, NOW)?.tools).toEqual({ Bash: 7 })
  expect(restoreStats({ nope: 1 }, NOW)).toBeUndefined()

  mock.clock(on, { now: NOW })
  // An in-memory store whose writes the test reads back.
  const writes = new Map<string, unknown>([['stats:s1', saved]])
  on('store.get', (_$, e) => ({ value: writes.get(e.key) }))
  on('store.set', (_$, e) => {
    writes.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    writes.delete(e.key)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({
    value: { startedAt: NOW - 600_000, context: { window: 200_000 }, rateLimits: [] },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.session.start({ cwd: 'C:/Sources', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'kpi-tokens' }))?.text).toContain('50.0k')
  expect((await ui.find({ key: 'tool-Bash' }))?.text).toContain('7')
  expect((await ui.find({ key: 'kpi-work' }))?.text).toContain('2m 5s')

  await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const stored = restoreStats(writes.get('stats:s1'), NOW)
  expect(stored?.turns).toBe(1)
  expect(stored?.tools).toEqual({ Bash: 7 })
  expect(writes.get('sessions')).toEqual(['s1'])
  await ui.unmount()
})
