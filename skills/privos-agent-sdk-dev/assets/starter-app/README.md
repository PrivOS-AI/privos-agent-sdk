# PrivOS Agent SDK Starter App

A minimal but complete terminal agent built on `@privos_ai/privos-agent-sdk`. Copy this folder, then adapt `src/index.ts`.

Docs: the `privos-agent-sdk-dev` skill's `references/` (start with `project-setup.md`).

## What it shows

- Provider + model + `defaultTools()` wiring
- A `canUseTool` permission prompt for write/exec tools (reads run freely)
- A persistent multi-turn session (SQLite at `.privos-agent-sdk/sessions.db`)
- Streaming assistant text + live tool-call display
- Graceful shutdown (`agent.close()` on `/exit` and Ctrl+C)

## Run

```sh
export ANTHROPIC_API_KEY=sk-ant-...
bun install      # or npm install
bun run start    # or: bun run src/index.ts
```

Type messages; `/exit` or Ctrl+C to quit. Sessions persist under `.privos-agent-sdk/` — add it to `.gitignore`.

## Adapt it

- **OpenAI:** swap the provider block (commented in `src/index.ts`) for `OpenAIResponsesProvider` + `model: "gpt-5"`.
- **No prompts (trusted/local):** set `permissions: { mode: "yolo" }` and drop `canUseTool`.
- **Resume a prior session:** `await agent.session({ id })`.
- **Custom tools / MCP / skills / subagents:** see the skill's `building-agents.md`.
