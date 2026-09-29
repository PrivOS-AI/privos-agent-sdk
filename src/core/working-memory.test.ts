import { expect, test } from "bun:test";
import { Agent } from "./agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { validateMemoryNote, type WorkingMemory } from "./working-memory.js";
import type { BaseProvider, ProviderRequest } from "../providers/base.js";

test("private recall is bounded and ephemeral, owner-bound, and invalidates resumed context", async () => {
  const requests: ProviderRequest[] = [];
  const provider: BaseProvider = {
    id: "memory-test", contextWindow: () => 200000,
    async *stream(request) {
      requests.push(structuredClone({ ...request, signal: undefined }) as ProviderRequest);
      yield { type: "message_start", model: "test" };
      yield { type: "text_delta", text: "old answer quoting an obsolete choice" };
      yield { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    },
  };
  let epoch = "1";
  const memory: WorkingMemory = {
    ownerKey: "workspace/user/project", recall: async () => ({ contextEpoch: epoch, context: "private reference " + "x".repeat(16000) }),
    remember: async () => "saved",
  };
  const store = new InMemorySessionStore();
  const make = (workingMemory?: WorkingMemory) => new Agent({ provider, model: "test", sessionStore: store, workingMemory });
  const session = await make(memory).session();
  for await (const _ of session.run("first")) { /* drain */ }
  expect(JSON.stringify(requests[0]?.messages)).toContain("private reference");
  expect(JSON.stringify(requests[0]?.messages).length).toBeLessThan(14000);
  expect(JSON.stringify(await store.loadMessages(session.id))).not.toContain("private reference");
  await expect(make({ ...memory, ownerKey: "other" }).session({ id: session.id })).rejects.toThrow("different memory context");
  await expect(make().session({ id: session.id })).rejects.toThrow("different memory context");
  epoch = "2";
  const resumed = await make(memory).session({ id: session.id });
  for await (const _ of resumed.run("current")) { /* drain */ }
  expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("obsolete choice");
  for await (const _ of resumed.run("next")) { /* drain */ }
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain("current");
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain("old answer");
  expect(JSON.stringify(await store.loadMessages(session.id))).toContain("first");
  expect(() => validateMemoryNote({ key: "x", text: "password=secret-value", kind: "observation" })).toThrow("Credentials");
  expect(() => validateMemoryNote({ key: "x", text: "safe", kind: "observation", userId: "other" })).toThrow("selectors");
});


test("Remember runs automatically through the real tool loop without dropping its result", async () => {
  let saved = 0;
  let calls = 0;
  const requests: ProviderRequest[] = [];
  const provider: BaseProvider = { id: "memory-tool-test", contextWindow: () => 200000,
    async *stream(request) {
      requests.push(request);
      yield { type: "message_start", model: "test" };
      if (calls++ === 0) {
        yield { type: "tool_use_start", id: "remember-1", name: "Remember" };
        yield { type: "tool_use_input_delta", id: "remember-1", json_delta: JSON.stringify({ key: "invoice escalation", text: "Ask Priya after ten working days.", kind: "observation" }) };
        yield { type: "tool_use_end", id: "remember-1" };
        yield { type: "message_end", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } };
      } else {
        yield { type: "text_delta", text: "Saved the finding." };
        yield { type: "message_end", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 } };
      }
    },
  };
  const memory: WorkingMemory = { ownerKey: "w/u/p", recall: async () => ({ contextEpoch: "unchanged", context: saved ? "Ask Priya" : "" }), remember: async () => { saved++; return "Saved privately"; } };
  const agent = new Agent({ provider, model: "test", workingMemory: memory, sessionStore: new InMemorySessionStore() });
  const session = await agent.session();
  for await (const _ of session.run("Keep useful findings")) { /* drain */ }
  expect(saved).toBe(1);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1]?.messages)).toContain("Saved privately");
  expect(() => validateMemoryNote({ key: "api_key=supersecret", text: "safe", kind: "observation" })).toThrow("Credentials");
});
