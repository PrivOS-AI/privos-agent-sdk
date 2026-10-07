# Changelog

All notable changes to `@privos_ai/privos-agent-sdk` are documented here.

## [0.3.1] — 2026-10-07

Patch release. A request changes only if one of its strings contains an unpaired UTF-16 surrogate,
and then only by losing that one code unit; every other request is sent exactly as before.

### Fixed

- **Lone UTF-16 surrogates are stripped from every outgoing provider request.** Text cut through an
  emoji (`text.slice(0, n)` over 📱) ends in an unpaired high surrogate. `JSON.stringify` writes it
  as a `\ud83d` escape, the gateway decodes that back into a lone surrogate and cannot re-encode
  the prompt as UTF-8, so it rejects the whole request (Z.ai answers HTTP 500
  `surrogates not allowed`) and LiteLLM then takes the model offline for every tenant behind the
  gateway. This is the 2026-10-07 incident: one half-cut emoji in a prompt left a shared gateway
  without that model for ten minutes. `AnthropicProvider`, `OpenAIChatCompletionsProvider` and
  `OpenAIResponsesProvider` now deep-copy the request payload with every unpaired half removed
  (string values, array items and object keys; valid pairs, all other text and binary data are
  untouched) right before it is handed to the provider SDK. The two OpenAI providers also clean the
  request itself before the payload is built, so a lone half inside a replayed tool call's input is
  removed before that input is serialized into the call's JSON `arguments` string.

### Added

- **`sanitizeLoneSurrogates?: boolean`** on `AnthropicProviderOptions` and
  `OpenAIChatProviderOptions` (inherited by `OpenAIResponsesProviderOptions`). Default `true`; pass
  `false` to send requests exactly as built.
- `stripLoneSurrogates(text)` and `sanitizeLoneSurrogates(value)` are exported from
  `@privos_ai/privos-agent-sdk/providers` for callers that assemble prompts outside the providers.

## [0.3.0] — 2026-08-13

First stable release of the PrivOS fork. Published from a workstation, so this
tarball carries **no npm provenance** — the attestation is a signed statement
about where a build happened and only the builder can produce it. The release
workflow that publishes from CI is in place (`.github/workflows/release.yml`);
it needs an npm automation token on the repository before it can run, so the
next release is the first attested one. `0.3.0-rc.0` is this release without
the name-collision fix below. Everything below `0.2.0` is upstream
[skawld-sdk](https://github.com/skawld/skawld-sdk) history, kept verbatim.

### Added

- **`configDir` accepts `string[]`** — imported from upstream PR #1
  (`5290006b2c2030c75a0af9927b25c5e4b7657e68`, applied as `3cfabfc`). Skills and subagents load
  from several roots in first-directory-wins order; a single string behaves exactly as before.
- **Tolerant SSE streaming** — imported from upstream PR #2
  (`56e28678a90634ce7a2c7f27febbbcc961fea655`, applied as `2c2e758`). Malformed frames are
  repaired or dropped instead of aborting the run, with an opt-out and an observer for dropped
  frames.

### Changed

- Package renamed to `@privos_ai/privos-agent-sdk`; repository is
  [PrivOS-AI/privos-agent-sdk](https://github.com/PrivOS-AI/privos-agent-sdk). Runtime
  identifiers are untouched on purpose — `.skawld`, `SKAWLD_*`, `SkawldError`, class names,
  exports and the session format are all unchanged, so an existing consumer only swaps the
  import specifier.

### Fixed

- **Name-collision precedence is deterministic.** Both the skill and subagent loaders walked
  `readdir` order, which the filesystem defines, so when two entries in one directory claimed the
  same name the winner differed between machines — the same tree resolved one way locally and the
  other way in CI. Entries are now walked in lexicographic order, so within a directory the first
  file wins exactly as the first directory wins across directories. This is the contract the
  multi-root feature exists to provide; previously it only held across directories, not inside one.
- **Skill-loader test fixtures ship with the repository.** `tests/fixtures/skills` was listed in
  `.gitignore`, so a fresh clone ran 18 skill-loader and skills-wiring tests against a directory
  that was never committed and failed all of them — indistinguishable from a broken fork. Base
  is upstream `7216fab`.

## [0.2.0] — 2026-06-13

### Added

- **AskUser tool** — Agents can now pause mid-run to elicit structured input from the user. Supports single-select, multi-select, and free-text responses with a 1–4 question format, option validation, and graceful decline handling.
- **Hooks system** — Introduced a first-class hook API (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PreCompact`) that allows consumers to intercept, modify, or block agent actions at runtime without modifying core loop logic.
- **Steering & interruption** — Added `Session.steer()` and `Session.interrupt()` for active-run control. `steer()` injects a user message at the next turn boundary without aborting the run; `interrupt()` ends the current run cleanly while preserving all in-flight turn state.

### Improved

- Hardened abort signal propagation across parallel tool execution, ensuring in-flight tool calls emit proper `tool_call_end` events before surfacing `AbortError`.
- Improved adjacent-batch partitioning in the tool scheduler to preserve strict result ordering across mixed read/write batches.
- Strengthened session store concurrency guarantees; concurrent `updateMeta` calls now correctly accumulate all patches without loss.
- Expanded provider error normalization for OpenAI Chat and Responses APIs, covering HTTP-date `retry-after` headers and mid-stream abort detection.
- Refined compaction logic to correctly re-inject skill listings and invoked skill bodies after context threshold is crossed.

## [0.1.0] — 2026-06-01

Initial release.
