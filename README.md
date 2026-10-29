# PrivOS Agent SDK

An open-source TypeScript agent harness, published as `@privos_ai/privos-agent-sdk`
(originally forked from [skawld-sdk](https://github.com/skawld/skawld-sdk) at upstream `7216fab`;
upstream MIT licence and commit authorship are preserved, see [CHANGELOG.md](CHANGELOG.md)).

On top of the upstream code it adds:

- **`configDir` accepts an array** — skills and subagents load from several roots in
  first-directory-wins order. Passing a single string behaves exactly as before.
- **Tolerant SSE streaming** — a malformed frame mid-stream is repaired or dropped instead of
  aborting the whole run. Dropped frames are surfaced to an optional observer, so a lossy stream
  is visible rather than silent.

Since 0.5.0 every runtime identifier carries the PrivOS name (`${PRIVOS_SKILL_DIR}`,
`PRIVOS_AGENT_*` environment variables, `.privos-agent-sdk/` config directory, `PrivOSAgentError`).
The upstream names are removed, not aliased; the full rename table is in the
[0.5.0 CHANGELOG entry](CHANGELOG.md).

An open-source all-purpose TypeScript agent harness.
Embed a full agent loop — tools, sessions, permissions, streaming events, subagents — into any Node.js or Bun application with a single import.

Runs on **Node.js 18+** and **Bun 1.1+**. ESM-only.

```sh
# pick your package manager
# Bun is reccomended
bun add @privos_ai/privos-agent-sdk
# npm is also supported
npm install @privos_ai/privos-agent-sdk
pnpm add @privos_ai/privos-agent-sdk
yarn add @privos_ai/privos-agent-sdk
```

---

## Minimal usage

```ts
import { Agent } from "@privos_ai/privos-agent-sdk";
import { AnthropicProvider } from "@privos_ai/privos-agent-sdk/providers";
import { defaultTools } from "@privos_ai/privos-agent-sdk/tools";

const agent = new Agent({
  provider: new AnthropicProvider(),   // reads ANTHROPIC_API_KEY from env
  model: "claude-opus-4-5",
  tools: defaultTools(),
  permissions: { mode: "default" },
});

const session = await agent.session();

for await (const event of session.run("List the files in the current directory.")) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
  if (event.type === "result") break;
}

await agent.close();
```

See [`examples/minimal-agent.ts`](./examples/minimal-agent.ts) for a complete runnable version.

---

## Interactive CLI example

[`examples/interactive-cli.ts`](./examples/interactive-cli.ts) is a small REPL that streams agent events, renders subagent activity in live boxes, and runs in `yolo` permission mode against the `OpenAIResponsesProvider`.

Setup:

```sh
export OPENAI_API_KEY=sk-...
# optional overrides
export PRIVOS_AGENT_MODEL=gpt-5            # default: gpt-5
export PRIVOS_AGENT_CONFIG_DIR=./.privos-agent-sdk   # default: ./.privos-agent-sdk
```

Run:

```sh
bun run examples/interactive-cli.ts
```

On startup it prompts for a working directory (defaults to the current one), then accepts free-form messages. Type `/exit` or press `Ctrl+C` to quit.

---

## Providers

| Provider class | Subpath | Environment variable |
|---|---|---|
| `AnthropicProvider` | `@privos_ai/privos-agent-sdk/providers` | `ANTHROPIC_API_KEY` |
| `OpenAIChatCompletionsProvider` | `@privos_ai/privos-agent-sdk/providers` | `OPENAI_API_KEY` |
| `OpenAIResponsesProvider` | `@privos_ai/privos-agent-sdk/providers` | `OPENAI_API_KEY` |

```ts
import {
  AnthropicProvider,
  OpenAIChatCompletionsProvider,
  OpenAIResponsesProvider,
} from "@privos_ai/privos-agent-sdk/providers";
```

---

## Environment variables

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `AnthropicProvider` (falls back to SDK default lookup) |
| `OPENAI_API_KEY` | `OpenAIChatCompletionsProvider`, `OpenAIResponsesProvider` |

---

## Sessions

By default, sessions persist to SQLite at `.privos-agent-sdk/sessions.db`. For tests or embedded applications, pass a custom `sessionStore`, such as `InMemorySessionStore`.

```ts
import { Agent } from "@privos_ai/privos-agent-sdk";
import { InMemorySessionStore } from "@privos_ai/privos-agent-sdk/sessions";

const agent = new Agent({
  provider,
  model,
  sessionStore: new InMemorySessionStore(),
});
```

---

## Public API surface

```
@privos_ai/privos-agent-sdk             → Agent, Session, defaultTools, MCP helpers, core types, Event types, Error classes
@privos_ai/privos-agent-sdk/providers   → AnthropicProvider, OpenAIChatCompletionsProvider, OpenAIResponsesProvider, BaseProvider
@privos_ai/privos-agent-sdk/tools       → ToolRegistry, defaultTools, built-in tool classes, MCP tool helpers, task types
@privos_ai/privos-agent-sdk/sessions    → SqliteSessionStore, InMemorySessionStore, SessionStore and task persistence types
@privos_ai/privos-agent-sdk/permissions → PermissionEngine, permission callback types, permission rule types
```

---

## Model selection and output budgets

`AgentOptions.resolveModel(requestedModel)` can supply a reliable model/route `ModelConfiguration`:
its exact `model`, optional `contextWindow` and output capability `maxOutputTokens`, and the desired
`outputTokenBudget`. The SDK resolves one snapshot per assistant turn before compaction and keeps
it for a context-error retry. A Skill's explicit model name is not rewritten; omission or `inherit`
keeps the Agent model selection.

Budget precedence is Run option, Agent option, model budget, then known provider default. Capability
bounds a selected budget; it does not request the model's entire maximum. Anthropic retains its known
32768 default, while OpenAI with no desired/default budget keeps the wire field absent. Compaction
uses the selected model at `min(80% of context, context - requested output)`; it does not reserve the
same output again inside the 20% headroom. Summary requests keep their own smaller budget. A known
normal or summary budget that cannot fit an explicitly configured context reports a configuration
error instead of being silently reduced.

See `skills/privos-agent-sdk-dev/references/api-reference.md` for the complete contract, custom
provider forwarding and the limits of preflight without a local tokenizer or prior usage.

## License

MIT
