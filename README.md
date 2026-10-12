# claude-mods

Personal Claude Code mods (plugins with hooks modules).

## usage-band

Keeps the context-window fill and the 5h / 7d rate-limit windows on screen in a band above the prompt. Refreshes on every measurement the engine pushes (after each turn and whenever a window moves a point).

Install at user scope from a terminal session:

```
claude plugin marketplace add C:/Sources/claude-mods/usage-band
claude plugin install usage-band@mda-mods --scope user
```

The marketplace is this folder, so the installed plugin is read from it directly: edit, then `/reload-plugins`.

Check: `claude plugin validate usage-band`, `claude plugin test usage-band`.
