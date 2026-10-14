# claude-mode-session-stats

A [Claude Code](https://claude.com/claude-code) mod that keeps a running summary of the session in a sidebar pane:

- **Headline numbers**: tokens, cache hit rate, tool calls and how long Claude has been working
- **Tokens**: the mix of input, cache write, cache read and output as one stacked bar, and tokens per model
- **Activity**: prompts and turns, working time against session time, longest turn, files edited and read, tool errors and denials, tool calls inside subagents, compactions
- **Tools, Skills, Connectors & MCP, Subagents**: ranked rows with a share bar and a count; the top 8 per section, the rest folded into "Other"

Everything updates live: tokens after every model response, counts the moment a call starts, times every second while a turn runs. A tool, skill, connector or subagent that is in use right now is drawn bold green and blinks. claude.ai connectors show by name (Atlassian, Slack, ...) rather than their internal id.

Type `/summary` to show or hide the pane; each section header collapses and expands, and "collapse all" folds everything. The counts are kept per session across app restarts.

It draws in the Claude desktop app (SVG bars) and in the terminal (text bars).

## Install

From the prompt of a terminal Claude Code session:

```
/plugin install session-summary --marketplace MichaelDaenzer/claude-mode-session-stats
```

Answer `y` to add the marketplace, then pick the **user** scope so it loads in every session, including the desktop app's.

## Limits

- Loaded partway through a session, the mod seeds tools, skills, subagents and prompts from the transcript; tokens and times count from the moment it loaded. Skills typed as `/name` before then are not in the transcript as tool calls and are missed.
- A skill counts as in use from its invocation to the end of that turn: the plugin API has no "skill finished" event.
- Connector names come from the desktop app's connector status; in a terminal session a claude.ai connector shows as `connector <id>` until a finished call names it.
- The stats of the last 8 sessions are kept in the plugin's store; an older session resumed is seeded from its transcript again.

## Development

| File | Role |
|---|---|
| `.claude-plugin/plugin.json` | manifest |
| `hooks/register.tsx` | the hooks module: counts on `tool.call`, `skill.prompt`, `agent.spawn`, `turn.step`, `turn.complete`; draws the `Pane` |
| `types/index.d.ts` | state contract |
| `tests/session-summary.test.tsx` | tests run against the engine's own test kit |

Check and test:

```
claude plugin validate .
claude plugin test .
```
