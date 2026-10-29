import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, getAgentInternals } from "./agent.js";
import { ContextLengthError } from "./errors.js";
import { getSessionInternals } from "./session.js";
import { maybeCompact } from "./compaction.js";
import { resolveTurnModel, type ModelConfiguration } from "./model-config.js";
import { BaseProvider, type ProviderRequest, type ProviderStreamEvent } from "../providers/base.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import type { Message } from "./types.js";

class ControlledProvider extends BaseProvider {
  readonly id = "controlled";
  readonly requests: ProviderRequest[] = [];
  contextWindow() { return 200_000; }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    yield* textResponse(request.model);
  }
}

function* textResponse(model: string): Iterable<ProviderStreamEvent> {
  yield { type: "message_start", model };
  yield { type: "text_delta", text: "done" };
  yield { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } };
}

function* toolResponse(model: string, name: string, input: unknown, inputTokens: number): Iterable<ProviderStreamEvent> {
  yield { type: "message_start", model };
  yield { type: "tool_use_start", id: `call-${name}`, name };
  yield { type: "tool_use_input_delta", id: `call-${name}`, json_delta: JSON.stringify(input) };
  yield { type: "tool_use_end", id: `call-${name}` };
  yield { type: "message_end", stop_reason: "tool_use", usage: { input_tokens: inputTokens, output_tokens: 2 } };
}

function history(): Message[] {
  return Array.from({ length: 15 }, (_, n) => [
    { role: "user" as const, content: [{ type: "text" as const, text: `question ${n}` }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: `answer ${n}` }] },
  ]).flat();
}

describe("effective model configuration", () => {
  it("keeps capability separate from an unspecified API budget", async () => {
    const provider = new ControlledProvider();
    const agent = new Agent({ provider, model: "gateway/model", sessionStore: new InMemorySessionStore(),
      resolveModel: model => ({ model, contextWindow: 1_000_000, maxOutputTokens: 900_000 }) });
    const selected = resolveTurnModel(getAgentInternals(agent));
    expect(selected).toEqual({ model: "gateway/model", contextWindow: 1_000_000, configuredContextWindow: 1_000_000, maxOutputCapacity: 900_000 });
    const session = await agent.session();
    for await (const _event of session.run("question")) { /* controlled provider */ }
    expect(provider.requests[0]!.max_output_tokens).toBeUndefined();
    await agent.close();
  });

  it("uses Run, Agent, model and known provider defaults in order, bounded by capability", () => {
    const provider = Object.assign(new ControlledProvider(), { defaultOutputTokens: () => 32768 });
    const configuration: ModelConfiguration = { model: "actual", contextWindow: 1_000_000, maxOutputTokens: 60_000, outputTokenBudget: 50_000 };
    const agent = new Agent({ provider, model: "alias", maxOutputTokens: 55_000, resolveModel: () => configuration });
    const ai = getAgentInternals(agent);
    expect(resolveTurnModel(ai, { maxOutputTokens: 70_000 }).maxOutputTokens).toBe(60_000);
    expect(resolveTurnModel(ai).maxOutputTokens).toBe(55_000);
    ai.maxOutputTokens = undefined;
    expect(resolveTurnModel(ai).maxOutputTokens).toBe(50_000);
    configuration.outputTokenBudget = undefined;
    expect(resolveTurnModel(ai).maxOutputTokens).toBe(32768);
    configuration.maxOutputTokens = 1000;
    expect(resolveTurnModel(ai).maxOutputTokens).toBe(1000);
  });

  it("compacts at the input threshold or the actual output fit threshold, without double-counting headroom", async () => {
    const agent = new Agent({ provider: new ControlledProvider(), model: "fixture", sessionStore: new InMemorySessionStore(),
      resolveModel: model => ({ model, contextWindow: 1_000_000, maxOutputTokens: 900_000, outputTokenBudget: 256_000 }),
      compaction: { id: "controlled", async compact() { return [{ role: "user", content: [{ type: "text", text: "summary" }] }]; } } });
    const session = await agent.session();
    const si = getSessionInternals(session); const ai = getAgentInternals(agent);
    si.providerView.push(...history());
    si.lastUsage = { input_tokens: 600_000, output_tokens: 20 };
    expect(await maybeCompact(si, ai, new AbortController().signal)).toBe(false);
    si.lastUsage.input_tokens = 744_000;
    expect(await maybeCompact(si, ai, new AbortController().signal)).toBe(true);
    si.providerView.push(...history());
    si.lastUsage.input_tokens = 100_000;
    const runSelection = resolveTurnModel(ai, { maxOutputTokens: 900_000 });
    expect(await maybeCompact(si, ai, new AbortController().signal, runSelection)).toBe(true);
    await agent.close();
  });

  it("reports a budget that cannot fit a configured context rather than silently reducing it", () => {
    const provider = Object.assign(new ControlledProvider(), { defaultOutputTokens: () => 32768 });
    const configured: ModelConfiguration = { model: "small", contextWindow: 16_000 };
    const agent = new Agent({ provider, model: "small", resolveModel: () => configured });
    const ai = getAgentInternals(agent);
    expect(() => resolveTurnModel(ai)).toThrow("budget must be smaller");
    configured.outputTokenBudget = 4000;
    expect(resolveTurnModel(ai).maxOutputTokens).toBe(4000);
    expect(() => resolveTurnModel(ai, { maxOutputTokens: 16_000 })).toThrow("budget must be smaller");
    configured.maxOutputTokens = 8000;
    expect(resolveTurnModel(ai, { maxOutputTokens: 64_000 }).maxOutputTokens).toBe(8000);
  });

  it("applies the same known-context budget check before a default summary request", async () => {
    const provider = new ControlledProvider();
    const configured: ModelConfiguration = { model: "small", contextWindow: 3000, outputTokenBudget: 500 };
    const agent = new Agent({ provider, model: "small", resolveModel: () => configured, sessionStore: new InMemorySessionStore() });
    const si = getSessionInternals(await agent.session());
    si.providerView.push(...history());
    si.lastUsage = { input_tokens: 2500, output_tokens: 10 };
    await expect(maybeCompact(si, getAgentInternals(agent), new AbortController().signal)).rejects.toThrow("budget must be smaller");
    expect(provider.requests).toHaveLength(0);
    configured.maxOutputTokens = 1000;
    expect(await maybeCompact(si, getAgentInternals(agent), new AbortController().signal)).toBe(true);
    expect(provider.requests[0]!.max_output_tokens).toBe(1000);
    expect(provider.requests[0]!.model).toBe("small");
    await agent.close();
  });

  it("resolves a persistent host model again at each new turn and run, not only at Agent construction", async () => {
    let phase = "role";
    const provider = new ControlledProvider();
    const agent = new Agent({ provider, model: "start", sessionStore: new InMemorySessionStore(), resolveModel: () => ({ model: phase, outputTokenBudget: phase === "role" ? 100 : 200 }) });
    const session = await agent.session();
    for await (const _event of session.run("first")) { /* controlled provider */ }
    phase = "skill";
    for await (const _event of session.run("second")) { /* controlled provider */ }
    expect(provider.requests.map(r => [r.model, r.max_output_tokens])).toEqual([["role", 100], ["skill", 200]]);
    await agent.close();
  });

  it("preserves an exact Skill choice through threshold compaction and forced retry, then returns to the base model", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "sdk-model-config-"));
    mkdirSync(path.join(cwd, "config/skills/slim"), { recursive: true });
    writeFileSync(path.join(cwd, "config/skills/slim/SKILL.md"), "---\nname: slim\ndescription: Select the precise fixture model\nmodel: gateway/slim\n---\nUse the selected model.");
    writeFileSync(path.join(cwd, "input.txt"), "local fixture");
    const normalRequests: ProviderRequest[] = []; const summaryRequests: ProviderRequest[] = []; const resolved: string[] = [];
    class FlowProvider extends ControlledProvider {
      override async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
        if (request.system[0]?.text.startsWith("Summarize the conversation")) {
          summaryRequests.push({ ...request, messages: structuredClone(request.messages) });
          yield* textResponse(request.model); return;
        }
        normalRequests.push({ ...request, messages: structuredClone(request.messages) });
        if (normalRequests.length === 1) { yield* toolResponse(request.model, "Skill", { skill: "slim" }, 900); return; }
        if (normalRequests.length === 2) throw new ContextLengthError("controlled context response");
        if (normalRequests.length === 3) { yield* toolResponse(request.model, "Read", { file_path: "input.txt" }, 10); return; }
        yield* textResponse(request.model);
      }
    }
    const store = new InMemorySessionStore(); const record = await store.create({});
    await store.appendMessages(record.id, history());
    const agent = new Agent({ provider: new FlowProvider(), model: "gateway/wide[1m]", cwd, configDir: "config", sessionStore: store, permissions: { mode: "yolo" },
      resolveModel: model => { resolved.push(model); return model === "gateway/slim" ? { model, contextWindow: 1000, maxOutputTokens: 500, outputTokenBudget: 300 }
        : { model, contextWindow: 10_000, outputTokenBudget: 100 }; } });
    try {
      const events = [];
      for await (const event of (await agent.session({ id: record.id })).run("Invoke the fixture Skill")) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
      expect(normalRequests.map(r => [r.model, r.max_output_tokens])).toEqual([["gateway/wide[1m]", 100], ["gateway/slim", 300], ["gateway/slim", 300], ["gateway/wide[1m]", 100]]);
      expect(summaryRequests.map(r => [r.model, r.max_output_tokens])).toEqual([["gateway/slim", 500], ["gateway/slim", 500]]);
      expect(resolved).toEqual(["gateway/wide[1m]", "gateway/slim", "gateway/wide[1m]"]);
    } finally { await agent.close(); rmSync(cwd, { recursive: true, force: true }); }
  });

  it("keeps an inherited Skill on the Agent selection without an extra permission request", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "sdk-model-inherit-"));
    mkdirSync(path.join(cwd, "config/skills/inherited"), { recursive: true });
    writeFileSync(path.join(cwd, "config/skills/inherited/SKILL.md"), "---\nname: inherited\ndescription: Keep the current model\nmodel: inherit\n---\nContinue.");
    class InheritProvider extends ControlledProvider {
      override async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
        this.requests.push({ ...request, messages: structuredClone(request.messages) });
        if (this.requests.length === 1) yield* toolResponse(request.model, "Skill", { skill: "inherited" }, 10);
        else yield* textResponse(request.model);
      }
    }
    const provider = new InheritProvider();
    const agent = new Agent({ provider, model: "gateway/exact[1m]", cwd, configDir: "config", sessionStore: new InMemorySessionStore() });
    try {
      const events = [];
      for await (const event of (await agent.session()).run("Use the inherited Skill")) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
      expect(events.some(event => event.type === "permission_request")).toBe(false);
      expect(provider.requests.map(request => request.model)).toEqual(["gateway/exact[1m]", "gateway/exact[1m]"]);
    } finally { await agent.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
});
