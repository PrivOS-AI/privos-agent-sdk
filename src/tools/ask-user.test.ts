import { describe, test, expect } from "bun:test";
import { AskUserTool } from "./ask-user.js";
import { AbortError, ToolExecutionError } from "../core/errors.js";
import type { AskUserHandler, AskUserResponse } from "./ask-user.js";
import type { ToolContext } from "./base.js";

// Minimal ToolContext stub — AskUserTool only needs signal, runId, toolUseId.
function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    cwd: "/tmp",
    signal: signal ?? new AbortController().signal,
    fileReadTracker: {} as any,
    sessionId: "sess-1",
    runId: "run-1",
    toolUseId: "toolu-1",
    sessionStore: {} as any,
  };
}

const SINGLE_Q = {
  question: "Which backend should we use?",
  header: "Backend",
  options: [
    { label: "SQLite", description: "Embedded, no server" },
    { label: "PostgreSQL", description: "Full relational DB" },
  ],
  multi_select: false,
};

function makeTool(handler: AskUserHandler): AskUserTool {
  return new AskUserTool(handler);
}

// ---------------------------------------------------------------------------
// validate() — shape rules
// ---------------------------------------------------------------------------
describe("AskUserTool.validate()", () => {
  test("accepts a minimal valid input", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["SQLite"] }] }));
    const input = tool.validate({ questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] }] });
    expect(input.questions).toHaveLength(1);
    expect(input.questions[0]!.multi_select).toBe(false);
  });

  test("defaults multi_select to false", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["A"] }] }));
    const raw = {
      questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] }],
    };
    const input = tool.validate(raw);
    expect(input.questions[0]!.multi_select).toBe(false);
  });

  test("preserves explicit multi_select: true", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["A", "B"] }] }));
    const raw = {
      questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }], multi_select: true }],
    };
    const input = tool.validate(raw);
    expect(input.questions[0]!.multi_select).toBe(true);
  });

  test("rejects 0 questions", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() => tool.validate({ questions: [] })).toThrow(ToolExecutionError);
  });

  test("rejects 5 questions", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const q = { question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] };
    expect(() => tool.validate({ questions: [q, q, q, q, q] })).toThrow(ToolExecutionError);
  });

  test("rejects empty question string", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "", header: "H", options: [{ label: "A" }, { label: "B" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects empty header string", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "", options: [{ label: "A" }, { label: "B" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects header longer than 12 chars", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "VeryLongHeader", options: [{ label: "A" }, { label: "B" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("accepts header of exactly 12 chars", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const input = tool.validate({
      questions: [{ question: "Q?", header: "123456789012", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(input.questions[0]!.header).toBe("123456789012");
  });

  test("rejects 1 option (needs 2–4)", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "H", options: [{ label: "A" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects 5 options", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const opts = [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }];
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "H", options: opts }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects duplicate option labels", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "H", options: [{ label: "A" }, { label: "A" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("rejects empty option label", () => {
    const tool = makeTool(async () => ({ declined: true }));
    expect(() =>
      tool.validate({ questions: [{ question: "Q?", header: "H", options: [{ label: "" }, { label: "B" }] }] }),
    ).toThrow(ToolExecutionError);
  });

  test("accepts 4 questions (max)", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const q = { question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] };
    const input = tool.validate({ questions: [q, q, q, q] });
    expect(input.questions).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// summarize()
// ---------------------------------------------------------------------------
describe("AskUserTool.summarize()", () => {
  test("single question", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const input = tool.validate({ questions: [{ question: "Which backend?", header: "Backend", options: [{ label: "A" }, { label: "B" }] }] });
    expect(tool.summarize(input)).toBe('Ask user: "Which backend?"');
  });

  test("multiple questions appends count", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const q = { question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] };
    const input = tool.validate({ questions: [q, q, q] });
    expect(tool.summarize(input)).toBe('Ask user: "Q?" (+2 more)');
  });

  test("truncates long first question to 60 chars", () => {
    const tool = makeTool(async () => ({ declined: true }));
    const longQ = "A".repeat(70) + "?";
    const input = tool.validate({ questions: [{ question: longQ, header: "H", options: [{ label: "A" }, { label: "B" }] }] });
    const summary = tool.summarize(input);
    // 60 chars + ellipsis
    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// execute() — happy paths
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — answers", () => {
  test("renders single answer", async () => {
    const handler: AskUserHandler = async () => ({ answers: [{ selected: ["SQLite"] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(typeof result.content).toBe("string");
    const content = result.content as string;
    expect(content).toContain("User answered:");
    expect(content).toContain("[Backend] Which backend should we use?");
    expect(content).toContain("→ SQLite");
    expect(result.summary).toBe("User answered 1 question");
  });

  test("renders multi-select answer with comma join", async () => {
    const q = { question: "Platforms?", header: "Platforms", options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }], multi_select: true };
    const handler: AskUserHandler = async () => ({ answers: [{ selected: ["macOS", "Linux"] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("→ macOS, Linux");
  });

  test("renders free text answer", async () => {
    const handler: AskUserHandler = async () => ({ answers: [{ selected: ["something custom"] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.content).toContain("→ something custom");
  });

  test("handler receives ctx.toolUseId as tool_use_id", async () => {
    let seenId: string | undefined;
    const handler: AskUserHandler = async (req) => {
      seenId = req.tool_use_id;
      return { answers: [{ selected: ["SQLite"] }] };
    };
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    await tool.execute(input, makeCtx());
    expect(seenId).toBe("toolu-1");
  });

  test("summary pluralises for multiple questions", async () => {
    const q = { question: "Q?", header: "H", options: [{ label: "A" }, { label: "B" }] };
    const handler: AskUserHandler = async () => ({
      answers: [{ selected: ["A"] }, { selected: ["B"] }],
    });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [q, q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.summary).toBe("User answered 2 questions");
  });
});

// ---------------------------------------------------------------------------
// execute() — declined
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — declined", () => {
  test("decline without reason", async () => {
    const handler: AskUserHandler = async () => ({ declined: true });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("The user declined to answer");
    expect(result.content).not.toContain("(reason:");
    expect(result.summary).toBe("User declined to answer");
  });

  test("decline with reason", async () => {
    const handler: AskUserHandler = async () => ({ declined: true, reason: "in a meeting" });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("(reason: in a meeting)");
  });
});

// ---------------------------------------------------------------------------
// execute() — invalid handler response
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — invalid response", () => {
  test("answers length mismatch", async () => {
    const handler: AskUserHandler = async () => ({
      answers: [{ selected: ["A"] }, { selected: ["B"] }],
    });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("expected 1 answer");
  });

  test("selected is not an array", async () => {
    const handler: AskUserHandler = async () =>
      ({ answers: [{ selected: "SQLite" }] } as any);
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("selected must be an array");
  });

  test("selected is empty array", async () => {
    const handler: AskUserHandler = async () => ({ answers: [{ selected: [] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
  });

  test("null response", async () => {
    const handler: AskUserHandler = async () => null as any;
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("expected an object");
  });

  test("declined: false is invalid, not a decline", async () => {
    const handler: AskUserHandler = async () => ({ declined: false } as any);
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("declined must be true");
  });

  test("multi_select: false but two selections", async () => {
    const handler: AskUserHandler = async () => ({ answers: [{ selected: ["A", "B"] }] });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("exactly one entry");
  });
});

// ---------------------------------------------------------------------------
// execute() — handler throws
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — handler throws", () => {
  test("non-abort error yields is_error result with message", async () => {
    const handler: AskUserHandler = async () => {
      throw new Error("something broke");
    };
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const result = await tool.execute(input, makeCtx());
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("AskUser failed: something broke");
  });
});

// ---------------------------------------------------------------------------
// execute() — abort
// ---------------------------------------------------------------------------
describe("AskUserTool.execute() — abort", () => {
  test("pre-aborted signal throws AbortError immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    // Handler never resolves
    const handler: AskUserHandler = () => new Promise(() => {});
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    await expect(tool.execute(input, makeCtx(ac.signal))).rejects.toBeInstanceOf(AbortError);
  });

  test("signal fires mid-run throws AbortError and ignores late handler", async () => {
    const ac = new AbortController();
    let resolveHandler!: (v: AskUserResponse) => void;
    const handler: AskUserHandler = () => new Promise<AskUserResponse>(r => { resolveHandler = r; });
    const tool = makeTool(handler);
    const input = tool.validate({ questions: [SINGLE_Q] });
    const execPromise = tool.execute(input, makeCtx(ac.signal));
    // Abort after scheduling
    queueMicrotask(() => ac.abort());
    await expect(execPromise).rejects.toBeInstanceOf(AbortError);
    // Handler resolving after abort should be silently ignored (no throw)
    resolveHandler({ answers: [{ selected: ["SQLite"] }] });
  });
});

// ---------------------------------------------------------------------------
// Agent wiring: AskUser registered when handler provided
// ---------------------------------------------------------------------------
describe("Agent wiring", () => {
  test("AskUserTool is present in registry when askUser provided", async () => {
    const { Agent } = await import("../core/agent.js");
    const { InMemorySessionStore } = await import("../sessions/memory.js");

    // Minimal mock provider
    const mockProvider = {
      contextWindow: () => 100_000,
      complete: async function* () { yield { type: "result" as const, stop_reason: "end_turn", message: { role: "assistant" as const, content: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    } as any;

    const handler: AskUserHandler = async () => ({ declined: true });
    const agent = new Agent({
      provider: mockProvider,
      model: "claude-haiku-4-5-20251001",
      sessionStore: new InMemorySessionStore(),
      askUser: handler,
    });

    const { getAgentInternals } = await import("../core/agent.js");
    const ai = getAgentInternals(agent);
    const names = ai.tools.list().map(t => t.name);
    expect(names).toContain("AskUser");
    await agent.close();
  });

  test("AskUserTool is absent when askUser not provided", async () => {
    const { Agent, getAgentInternals } = await import("../core/agent.js");
    const { InMemorySessionStore } = await import("../sessions/memory.js");

    const mockProvider = {
      contextWindow: () => 100_000,
      complete: async function* () { yield { type: "result" as const, stop_reason: "end_turn", message: { role: "assistant" as const, content: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    } as any;

    const agent = new Agent({
      provider: mockProvider,
      model: "claude-haiku-4-5-20251001",
      sessionStore: new InMemorySessionStore(),
    });

    const ai = getAgentInternals(agent);
    const names = ai.tools.list().map(t => t.name);
    expect(names).not.toContain("AskUser");
    await agent.close();
  });

  test("throws ConfigError when AskUser already registered and askUser handler provided", async () => {
    const { Agent } = await import("../core/agent.js");
    const { InMemorySessionStore } = await import("../sessions/memory.js");
    const { ToolRegistry } = await import("./registry.js");

    const mockProvider = {
      contextWindow: () => 100_000,
      complete: async function* () { yield { type: "result" as const, stop_reason: "end_turn", message: { role: "assistant" as const, content: [] }, usage: { input_tokens: 1, output_tokens: 1 } }; },
    } as any;

    const handler: AskUserHandler = async () => ({ declined: true });
    // Pre-register a tool named "AskUser" in a custom registry
    const registry = new ToolRegistry();
    const fakeAskUser = new AskUserTool(handler);
    registry.register(fakeAskUser);

    expect(() => new Agent({
      provider: mockProvider,
      model: "claude-haiku-4-5-20251001",
      sessionStore: new InMemorySessionStore(),
      tools: registry,
      askUser: handler,
    })).toThrow(/AskUser/);
  });
});

// ---------------------------------------------------------------------------
// buildChildTools excludes AskUser
// ---------------------------------------------------------------------------
describe("buildChildTools", () => {
  test("excludes AskUser even in wildcard filter", async () => {
    const { buildChildTools } = await import("../subagents/runner.js");
    const { ToolRegistry } = await import("./registry.js");

    const registry = new ToolRegistry();
    const handler: AskUserHandler = async () => ({ declined: true });
    registry.register(new AskUserTool(handler));

    const child = buildChildTools(registry, undefined); // wildcard
    const names = child.list().map(t => t.name);
    expect(names).not.toContain("AskUser");
  });

  test("excludes AskUser when explicitly listed in filter", async () => {
    const { buildChildTools } = await import("../subagents/runner.js");
    const { ToolRegistry } = await import("./registry.js");

    const registry = new ToolRegistry();
    const handler: AskUserHandler = async () => ({ declined: true });
    registry.register(new AskUserTool(handler));

    const child = buildChildTools(registry, ["AskUser"]);
    const names = child.list().map(t => t.name);
    expect(names).not.toContain("AskUser");
  });
});

// ---------------------------------------------------------------------------
// credential questions
// ---------------------------------------------------------------------------
describe("AskUserTool credential questions", () => {
  const tool = makeTool(async () => ({ declined: true }));
  const cred = { host: "api.openai.com", purpose: "Call the OpenAI API" };
  const credQ = (extra: Record<string, unknown> = {}, credExtra: Record<string, unknown> = {}) => ({
    question: "Need an OpenAI key",
    header: "OpenAI key",
    credential: { ...cred, ...credExtra },
    ...extra,
  });
  const invalid = (raw: unknown, msg: RegExp) =>
    expect(() => tool.validate(raw as Record<string, unknown>)).toThrow(msg);

  test("is valid without options and keeps the credential", () => {
    const input = tool.validate({
      questions: [credQ({}, { path_prefix: "/v1", env_name: "OPENAI_API_KEY", base_url_env_name: "OPENAI_BASE_URL", rotate: true })],
    });
    const q = input.questions[0]!;
    expect(q.options).toEqual([]);
    expect(q.credential).toEqual({
      host: "api.openai.com",
      purpose: "Call the OpenAI API",
      path_prefix: "/v1",
      env_name: "OPENAI_API_KEY",
      base_url_env_name: "OPENAI_BASE_URL",
      rotate: true,
    });
  });

  test("accepts empty options and a wildcard host", () => {
    const input = tool.validate({ questions: [credQ({ options: [] }, { host: "*.example.com" })] });
    expect(input.questions[0]!.credential!.host).toBe("*.example.com");
  });

  test("strips model-supplied request_id, requestId, status and unknown fields", () => {
    const input = tool.validate({
      questions: [credQ({}, { request_id: "r1", requestId: "r2", status: "resolved", extra: 1 })],
    });
    expect(input.questions[0]!.credential).toEqual({ ...cred });
  });

  test("must be the only question", () => {
    invalid({ questions: [credQ(), SINGLE_Q] }, /credential requires it to be the only question/);
    invalid({ questions: [credQ(), credQ()] }, /credential requires it to be the only question/);
  });

  test("rejects options on a credential question", () => {
    invalid({ questions: [credQ({ options: [{ label: "A" }, { label: "B" }] })] }, /options must be absent or empty/);
  });

  test("rejects a bad host, prefix, purpose, env name and rotate", () => {
    invalid({ questions: [credQ({}, { host: "API.openai.com" })] }, /\.host must be/);
    invalid({ questions: [credQ({}, { host: "https://api.openai.com" })] }, /\.host must be/);
    invalid({ questions: [credQ({}, { host: "" })] }, /\.host must be/);
    invalid({ questions: [credQ({}, { path_prefix: "v1" })] }, /\.path_prefix must be/);
    invalid({ questions: [credQ({}, { purpose: "" })] }, /\.purpose must be 1–200/);
    invalid({ questions: [credQ({}, { purpose: "x".repeat(201) })] }, /\.purpose must be 1–200/);
    invalid({ questions: [credQ({}, { purpose: "line\nbreak" })] }, /\.purpose must be 1–200/);
    invalid({ questions: [credQ({}, { env_name: "openai_key" })] }, /\.env_name must match/);
    invalid({ questions: [credQ({}, { base_url_env_name: "A" })] }, /\.base_url_env_name must match/);
    invalid({ questions: [credQ({}, { rotate: "yes" })] }, /\.rotate must be a boolean/);
    invalid({ questions: [credQ({ credential: "nope" })] }, /credential must be an object/);
  });

  test("a credential question without header or question text gets neutral defaults", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["x"] }] }));
    const input = tool.validate({ questions: [{ credential: { host: "api.example.com", purpose: "Read the weekly report" } }] });
    expect(input.questions[0]!.header).toBe("API key");
    expect(input.questions[0]!.question).toBe("Read the weekly report");
    expect(input.questions[0]!.credential!.host).toBe("api.example.com");
  });

  test("a plain question still needs header and question text", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["x"] }] }));
    expect(() => tool.validate({ questions: [{ ...SINGLE_Q, header: "" }] })).toThrow(/header must be a non-empty string/);
    expect(() => tool.validate({ questions: [{ ...SINGLE_Q, question: "" }] })).toThrow(/question must be a non-empty string/);
  });

  test("a plain question with credential: null stays valid and carries no credential", () => {
    const tool = makeTool(async () => ({ answers: [{ selected: ["SQLite"] }] }));
    const input = tool.validate({ questions: [{ ...SINGLE_Q, credential: null }] });
    expect(input.questions[0]!.credential).toBeUndefined();
  });

  test("a plain question still needs 2-4 options", () => {
    invalid({ questions: [{ question: "Q?", header: "H" }] }, /options must be an array of 2–4 entries/);
  });

  test("schema describes credential, never says password, and no longer requires options", () => {
    expect(tool.description).toContain("ask ONE question with `credential` and no other questions");
    expect(tool.description).toContain("ask again with `rotate: true`");
    expect(JSON.stringify(tool.input_schema).toLowerCase()).not.toContain("password");
    expect(tool.description.toLowerCase()).not.toContain("password");
    const item = (tool.input_schema.properties.questions.items as { required: string[] });
    expect(item.required).toEqual(["question", "header"]);
  });

  test("rendering passes the handler text through and adds nothing from the input", async () => {
    const hostText = "Credential stored in the vault for api.openai.com. Use $OPENAI_API_KEY.";
    const credTool = makeTool(async () => ({ answers: [{ selected: [hostText] }] }));
    const input = credTool.validate({ questions: [credQ({}, { env_name: "OPENAI_API_KEY" })] });
    const result = await credTool.execute(input, makeCtx());
    expect(result.is_error).toBeFalsy();
    expect(result.content).toBe(
      `User answered:\n\n[OpenAI key] Need an OpenAI key\n→ ${hostText}`,
    );
  });

  test("the handler receives the validated credential question", async () => {
    let seen: unknown;
    const credTool = makeTool(async (req) => {
      seen = req.questions[0]!.credential;
      return { answers: [{ selected: ["ok"] }] };
    });
    await credTool.execute(credTool.validate({ questions: [credQ({}, { request_id: "r1" })] }), makeCtx());
    expect(seen).toEqual({ ...cred });
  });
});
