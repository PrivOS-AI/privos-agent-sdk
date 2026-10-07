import { describe, expect, it } from "bun:test";
import { ProviderError } from "../core/errors.js";
import { AnthropicProvider } from "./anthropic.js";
import type { BaseProvider, ProviderRequest } from "./base.js";
import { sanitizeLoneSurrogates, stripLoneSurrogates } from "./lone-surrogates.js";
import { OpenAIChatCompletionsProvider } from "./openai-chat.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";

const HIGH = "\ud83d"; // first half of 📱 (U+1F4F1)
const LOW = "\udcf1"; // second half of 📱

describe("stripLoneSurrogates", () => {
  it("removes a lone high surrogate", () => {
    expect(stripLoneSurrogates(`abc${HIGH}`)).toBe("abc");
    expect(stripLoneSurrogates(`a${HIGH}b`)).toBe("ab");
  });

  it("removes a lone low surrogate", () => {
    expect(stripLoneSurrogates(`${LOW}abc`)).toBe("abc");
    expect(stripLoneSurrogates(`a${LOW}b`)).toBe("ab");
  });

  it("removes every lone half in the string", () => {
    expect(stripLoneSurrogates(`${HIGH}a${LOW}b${HIGH}`)).toBe("ab");
  });

  it("leaves valid pairs and Vietnamese text untouched", () => {
    for (const text of [
      "📱",
      "call 📱 now",
      "𝒜",
      "Tạo ảnh 1 con bò cười",
      "Tạo ảnh 1 con bò cười 📱",
      "plain ascii",
      "",
    ]) {
      expect(stripLoneSurrogates(text)).toBe(text);
    }
  });

  it("drops only the unpaired half that sits next to a valid pair", () => {
    expect(stripLoneSurrogates(`${HIGH}${HIGH}${LOW}`)).toBe("📱");
    expect(stripLoneSurrogates(`${HIGH}${LOW}${LOW}`)).toBe("📱");
    // A low half followed by a high half is two unpaired halves, not a pair.
    expect(stripLoneSurrogates(`${LOW}${HIGH}`)).toBe("");
  });

  it("repairs text that was cut through an emoji", () => {
    expect(stripLoneSurrogates("Gọi số 📱".slice(0, -1))).toBe("Gọi số ");
  });
});

describe("sanitizeLoneSurrogates", () => {
  // `h`/`l` are the lone halves; building the expected value with empty strings keeps the shape identical.
  const requestShaped = (h: string, l: string) => ({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: `You are an agent ${h}` }],
    messages: [
      { role: "user", content: [{ type: "text", text: `Tạo ảnh 1 con bò cười 📱${h}` }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Search",
            input: { query: `${l}query`, filters: { tags: [`a${h}`, "b"] } },
          },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `ok${h}` }] },
    ],
  });

  it("walks messages, system blocks and tool-call inputs", () => {
    expect(sanitizeLoneSurrogates(requestShaped(HIGH, LOW))).toStrictEqual(requestShaped("", ""));
  });

  it("leaves numbers, booleans, null and undefined untouched", () => {
    const payload = { n: 1.5, zero: 0, yes: true, no: false, nothing: null, missing: undefined, list: [1, true, null] };
    expect(sanitizeLoneSurrogates(payload)).toStrictEqual(payload);
    expect(sanitizeLoneSurrogates(7)).toBe(7);
    expect(sanitizeLoneSurrogates(false)).toBe(false);
    expect(sanitizeLoneSurrogates(null)).toBeNull();
    expect(sanitizeLoneSurrogates(undefined)).toBeUndefined();
  });

  it("passes binary leaves and class instances through by reference", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = Buffer.from("image bytes");
    const signal = new AbortController().signal;
    const when = new Date(0);
    const out = sanitizeLoneSurrogates({ bytes, buffer, signal, when, nested: [bytes] });
    expect(out.bytes).toBe(bytes);
    expect(out.buffer).toBe(buffer);
    expect(out.signal).toBe(signal);
    expect(out.when).toBe(when);
    expect(out.nested[0]).toBe(bytes);
  });

  it("returns a copy and never mutates its input", () => {
    const input = { messages: [{ text: `a${HIGH}` }] };
    const out = sanitizeLoneSurrogates(input);
    expect(out).not.toBe(input);
    expect(out.messages).not.toBe(input.messages);
    expect(out.messages[0]?.text).toBe("a");
    expect(input.messages[0]?.text).toBe(`a${HIGH}`);
  });

  it("sanitizes object keys as well as values", () => {
    const input: Record<string, string> = { [`k${HIGH}`]: "v" };
    expect(sanitizeLoneSurrogates(input)).toStrictEqual({ k: "v" });
  });

  it("walks null-prototype dictionaries", () => {
    const dict = Object.assign(Object.create(null), { a: `x${HIGH}` });
    expect(sanitizeLoneSurrogates(dict)).toStrictEqual({ a: "x" });
  });

  it("keeps a __proto__ key as plain data instead of swapping the prototype", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"x":"y\\ud83d"}}');
    const out = sanitizeLoneSurrogates(parsed) as object;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ x: "y" });
  });
});

/* ---- the providers: what actually leaves for the gateway ---- */

// JSON.stringify writes a lone half as a six-character \udXXX escape and a valid pair as the raw
// character, so this matches exactly what a gateway would decode back into a lone surrogate.
const LONE_HALF_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i;

// `.test` is a reserved TLD: it never resolves, so nothing can leave this machine even if the
// fake fetch below were bypassed.
const GATEWAY = { apiKey: "test-key-not-real", baseURL: "http://gateway.test" };

/**
 * Build a provider whose HTTP layer is a fake that records each request body and answers 400.
 * Both vendor SDKs receive their fetch from `tolerantSseFetch`, which reads `globalThis.fetch` once,
 * when the provider is constructed; the global is therefore only replaced for the duration of `build`.
 */
function providerOnFakeWire<P extends BaseProvider>(build: () => P): { provider: P; bodies: string[] } {
  const bodies: string[] = [];
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "rejected by the fake wire" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  try {
    return { provider: build(), bodies };
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const event of events) void event;
}

const TRUNCATED_USER_TEXT = "Tạo ảnh 1 con bò cười 📱".slice(0, -1); // ends in a lone high surrogate

function request(model: string, overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model,
    system: [{ type: "text", text: `You are a helpful agent ${LOW}` }],
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: TRUNCATED_USER_TEXT }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Search", input: { query: "bò" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `found it${HIGH}` }] },
    ],
    max_output_tokens: 64,
    max_retries: 0,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface ProviderCase {
  name: string;
  model: string;
  build: (options: { sanitizeLoneSurrogates?: boolean }) => BaseProvider;
}

const providerCases: ProviderCase[] = [
  { name: "AnthropicProvider", model: "claude-opus-4-6", build: (o) => new AnthropicProvider({ ...GATEWAY, ...o }) },
  { name: "OpenAIChatCompletionsProvider", model: "gpt-4o", build: (o) => new OpenAIChatCompletionsProvider({ ...GATEWAY, ...o }) },
  { name: "OpenAIResponsesProvider", model: "gpt-5", build: (o) => new OpenAIResponsesProvider({ ...GATEWAY, ...o }) },
];

// Lone halves only inside a replayed tool call's input, so any escape on the wire comes from that input.
function toolInputRequest(model: string): ProviderRequest {
  return request(model, {
    system: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "search please" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Search", input: { query: `bò${HIGH}`, tags: [`${LOW}tag`] } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
    ],
  });
}

for (const { name, model, build } of providerCases) {
  describe(`${name} request sanitizing`, () => {
    it("strips lone surrogates from the request body by default", async () => {
      const { provider, bodies } = providerOnFakeWire(() => build({}));
      await expect(drain(provider.stream(request(model)))).rejects.toBeInstanceOf(ProviderError);

      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      expect(body).toContain("Tạo ảnh 1 con bò cười");
      expect(body).toContain("You are a helpful agent");
      expect(body).toContain("found it");
      expect(body).not.toMatch(LONE_HALF_ESCAPE);
      // encodeURIComponent throws on a raw lone surrogate, so this also rules out an unescaped one.
      expect(() => encodeURIComponent(body)).not.toThrow();
    });

    it("sends the lone surrogate untouched when sanitizeLoneSurrogates is false", async () => {
      const { provider, bodies } = providerOnFakeWire(() => build({ sanitizeLoneSurrogates: false }));
      await expect(drain(provider.stream(request(model)))).rejects.toBeInstanceOf(ProviderError);

      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      expect(body).toContain("Tạo ảnh 1 con bò cười");
      expect(body).toMatch(LONE_HALF_ESCAPE);
    });

    // The OpenAI providers serialize a replayed tool call's input into a JSON `arguments` string while
    // the payload is built. There a lone half is only escape text that a walk over the payload cannot
    // see, so it has to be removed from the request before the payload is built.
    it("strips lone surrogates from a replayed tool-call input by default", async () => {
      const { provider, bodies } = providerOnFakeWire(() => build({}));
      await expect(drain(provider.stream(toolInputRequest(model)))).rejects.toBeInstanceOf(ProviderError);

      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      expect(body).toContain("bò");
      expect(body).toContain("tag");
      expect(body).not.toMatch(LONE_HALF_ESCAPE);
    });

    it("sends a replayed tool-call input untouched when sanitizeLoneSurrogates is false", async () => {
      const { provider, bodies } = providerOnFakeWire(() => build({ sanitizeLoneSurrogates: false }));
      await expect(drain(provider.stream(toolInputRequest(model)))).rejects.toBeInstanceOf(ProviderError);

      expect(bodies).toHaveLength(1);
      const body = bodies[0] ?? "";
      expect(body).toContain("bò");
      expect(body).toMatch(LONE_HALF_ESCAPE);
    });
  });
}
