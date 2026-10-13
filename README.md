# claude-mod-usage-band

A [Claude Code](https://claude.com/claude-code) mod that keeps your usage on screen: a band directly above the prompt with

- **ctx**: how full the context window is, as a bar, a percentage and tokens used over the window size
- **cache**: whether the prompt cache is hot, and for how long: `hot · 58m` counts down to the moment it goes cold, `hot · in use` while a turn runs, `cold` otherwise (turns yellow in the last 10 minutes)
- **5h / 7d**: the subscription rate-limit windows, each with percent used and the time until it resets

Bars turn yellow at 70% and red at 90%. The band refreshes on every measurement the engine pushes: after each turn and whenever a window moves a whole point. No polling, no extra API calls.

It draws on the terminal and in the Claude desktop app. The arrow handle at the band's top right collapses it to a one-line summary (`ctx 60% · 5h 23.5% · 7d 91%`) and expands it again.

## Install

From the prompt of a terminal Claude Code session:

```
/plugin install usage-band --marketplace MichaelDaenzer/claude-mod-usage-band
```

Answer `y` to add the marketplace, then pick the **user** scope so it loads in every session, including the desktop app's.

## Limits

The plugin API exposes only the 5h and 7d windows (and a gateway spend limit). Per-model weekly windows, such as the one for Fable, are not reachable by mods as of Claude Code 2.1.295.

The cache countdown assumes the 1-hour prompt-cache TTL, timed from the end of each answer; the API does not report the session's TTL, so it is wrong by design for the 5-minute cache used under usage overage.

## Development

The mod lives in `usage-band/`:

| File | Role |
|---|---|
| `.claude-plugin/plugin.json` | manifest |
| `hooks/register.tsx` | the hooks module: reads `$.session.usage()`, listens to `session.measure`, draws the `AbovePrompt` band |
| `types/index.d.ts` | state contract for the stored snapshot |
| `tests/usage-band.test.tsx` | tests run against the engine's own test kit |

Check and test:

```
claude plugin validate usage-band
claude plugin test usage-band
```

To run a working copy instead of the installed one, add the clone as a marketplace and install from it; the plugin is then read from the folder directly and `/reload-plugins` picks up edits:

```
claude plugin marketplace add <path-to-clone>
claude plugin install usage-band@mda-mods --scope user
```
