/** AskUser tool — lets the model ask the user clarifying questions mid-run. See spec_docs/phase-02/16-ask-user.html. */

import type { Tool, ToolContext, ToolResult } from "./base.js";
import { AbortError, ToolExecutionError } from "../core/errors.js";

export interface AskUserOption {
  /** Display text the user selects. Concise, 1–5 words. */
  label: string;
  /** What choosing this option means — trade-offs, implications. */
  description?: string;
}

/**
 * A request for a secret (API key or token). The user enters the value in a
 * host-provided secure form; neither the value nor anything derived from it
 * ever flows back through this tool. The host maps these snake_case names to
 * its own and decides the (value-free) answer text.
 */
export interface AskUserCredential {
  /** Lowercase host the key is for, e.g. "api.openai.com". A leading "*." is allowed. */
  host: string;
  /** URL path prefix the key applies to; must start with "/". */
  path_prefix?: string;
  /** Why the key is needed, shown to the user. 1–200 characters of plain text. */
  purpose: string;
  /** Env var name the key will be exposed under, e.g. "OPENAI_API_KEY". */
  env_name?: string;
  /** Env var name for the matching base URL, e.g. "OPENAI_BASE_URL". */
  base_url_env_name?: string;
  /** true: the stored key for this host no longer works; ask for a new value. */
  rotate?: boolean;
  /**
   * Set by the host on its own copy of the question to correlate a pending
   * request. validate() never copies it from model input.
   */
  requestId?: string;
}

export interface AskUserQuestion {
  /** The complete question, e.g. "Which storage backend should the cache use?" */
  question: string;
  /** Short chip/tag label for UIs, max 12 characters, e.g. "Backend". */
  header: string;
  /** 2–4 distinct choices. Empty when `credential` is set. */
  options: AskUserOption[];
  /** Ask for an API key or token through a secure form. Must be the only question. */
  credential?: AskUserCredential;
  /** Allow selecting multiple options. Resolved by validate(); defaults to false. */
  multi_select: boolean;
}

export interface AskUserInput {
  /** 1–4 questions presented to the user in one prompt. */
  questions: AskUserQuestion[];
}

export interface AskUserRequest {
  tool_use_id: string;
  questions: AskUserQuestion[];
}

export interface AskUserAnswer {
  /**
   * The user's answer(s) to one question: option labels and/or free text.
   * Exactly one entry when multi_select is false; one or more when true.
   */
  selected: string[];
}

export type AskUserResponse =
  | { answers: AskUserAnswer[] }
  | { declined: true; reason?: string };

export type AskUserHandler = (
  req: AskUserRequest,
  signal: AbortSignal,
) => Promise<AskUserResponse>;

const SCHEMA = {
  type: "object" as const,
  properties: {
    questions: {
      type: "array",
      description: "1-4 questions to present to the user in a single prompt.",
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The complete question to ask. Clear, specific, ends with a question mark." },
          header: { type: "string", description: "Very short label displayed as a chip/tag (max 12 chars), e.g. 'Approach'." },
          options: {
            type: "array",
            description: "2-4 distinct, mutually exclusive choices (unless multi_select). Do NOT add an 'Other' option — free-text answers are always available to the user. Omit when `credential` is set.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Display text for this option. Concise, 1-5 words." },
                description: { type: "string", description: "What this option means or implies. Useful for trade-offs." },
              },
              required: ["label"],
            },
          },
          multi_select: { type: "boolean", description: "Allow selecting multiple options. Defaults to false." },
          credential: {
            type: "object",
            description: "Ask the user for an API key or token. Use as the only question, with no options.",
            properties: {
              host: { type: "string", description: "Lowercase host the key is for, e.g. 'api.openai.com'." },
              path_prefix: { type: "string", description: "Optional URL path prefix starting with '/'." },
              purpose: { type: "string", description: "Why the key is needed, 1-200 characters of plain text." },
              env_name: { type: "string", description: "Env var name for the key, e.g. 'OPENAI_API_KEY'." },
              base_url_env_name: { type: "string", description: "Env var name for the base URL, e.g. 'OPENAI_BASE_URL'." },
              rotate: { type: "boolean", description: "true when the stored key for this host was rejected and a new one is needed." },
            },
            required: ["host", "purpose"],
          },
        },
        required: ["question", "header"],
      },
    },
  },
  required: ["questions"],
};

const DESCRIPTION =
  `Asks the user clarifying questions when you are blocked on a decision only ` +
  `they can make: ambiguous requirements, multiple valid approaches with ` +
  `meaningfully different trade-offs, missing context you cannot discover from ` +
  `the codebase, or risky/irreversible choices. Present 1-4 questions, each with ` +
  `2-4 distinct options. Put your recommended option first and append ` +
  `'(Recommended)' to its label. Set multi_select: true when choices are ` +
  `combinable. The user can always answer with free text instead of picking an ` +
  `option, so never add an 'Other' or 'Something else' option. Batch related ` +
  `questions into one call rather than calling this tool repeatedly. Do NOT use ` +
  `this tool for anything you can answer by reading files or running commands, ` +
  `and do not use it to ask for permission to run a tool — the permission system ` +
  `handles that. ` +
  `To obtain an API key or token, ask ONE question with \`credential\` and no ` +
  `other questions. The user enters it in a secure form; you never see it. ` +
  `Never ask for a secret in a normal question or in chat. If a stored key is ` +
  `rejected by the service (401/403), ask again with \`rotate: true\`.`;

const HOST_RE = /^(\*\.)?[a-z0-9.-]+$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export class AskUserTool implements Tool<AskUserInput> {
  readonly name = "AskUser";
  readonly description = DESCRIPTION;
  readonly input_schema = SCHEMA;
  readonly scope = "read" as const;
  readonly parallelSafe = false;

  constructor(private readonly handler: AskUserHandler) {}

  validate(raw: Record<string, unknown>): AskUserInput {
    const { questions } = raw;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) {
      throw new ToolExecutionError("questions must be an array of 1–4 entries", { tool_name: this.name });
    }

    const validated: AskUserQuestion[] = questions.map((q: unknown, qi: number) => {
      if (typeof q !== "object" || q === null) {
        throw new ToolExecutionError(`questions[${qi}] must be an object`, { tool_name: this.name });
      }
      const qObj = q as Record<string, unknown>;

      if (typeof qObj.question !== "string" || qObj.question.trim() === "") {
        throw new ToolExecutionError(`questions[${qi}].question must be a non-empty string`, { tool_name: this.name });
      }
      if (typeof qObj.header !== "string" || qObj.header.trim() === "") {
        throw new ToolExecutionError(`questions[${qi}].header must be a non-empty string`, { tool_name: this.name });
      }
      if (qObj.header.length > 12) {
        throw new ToolExecutionError(`questions[${qi}].header must be at most 12 characters`, { tool_name: this.name });
      }

      const credential = qObj.credential == null ? undefined : this.validateCredential(qObj.credential, qi, questions.length);

      let options: AskUserOption[] = [];
      if (credential) {
        if (qObj.options !== undefined && (!Array.isArray(qObj.options) || qObj.options.length > 0)) {
          throw new ToolExecutionError(`questions[${qi}].options must be absent or empty when credential is set`, { tool_name: this.name });
        }
      } else {
        if (!Array.isArray(qObj.options) || qObj.options.length < 2 || qObj.options.length > 4) {
          throw new ToolExecutionError(`questions[${qi}].options must be an array of 2–4 entries`, { tool_name: this.name });
        }
        options = this.validateOptions(qObj.options, qi);
      }

      const multi_select = typeof qObj.multi_select === "boolean" ? qObj.multi_select : false;

      return {
        question: qObj.question,
        header: qObj.header,
        options,
        multi_select,
        ...(credential ? { credential } : {}),
      };
    });

    return { questions: validated };
  }

  private validateOptions(rawOptions: unknown[], qi: number): AskUserOption[] {
    const labels = new Set<string>();
    return rawOptions.map((o: unknown, oi: number) => {
      if (typeof o !== "object" || o === null) {
        throw new ToolExecutionError(`questions[${qi}].options[${oi}] must be an object`, { tool_name: this.name });
      }
      const oObj = o as Record<string, unknown>;
      if (typeof oObj.label !== "string" || oObj.label.trim() === "") {
        throw new ToolExecutionError(`questions[${qi}].options[${oi}].label must be a non-empty string`, { tool_name: this.name });
      }
      if (labels.has(oObj.label)) {
        throw new ToolExecutionError(`questions[${qi}].options has duplicate label: "${oObj.label}"`, { tool_name: this.name });
      }
      labels.add(oObj.label);
      const opt: AskUserOption = { label: oObj.label };
      if (typeof oObj.description === "string") opt.description = oObj.description;
      return opt;
    });
  }

  /**
   * Shape-checks a credential request and returns a copy holding only the
   * known fields, so model-supplied extras (request_id, status, …) are dropped.
   * The host re-validates the full rule set; this only checks shape.
   */
  private validateCredential(raw: unknown, qi: number, questionCount: number): AskUserCredential {
    const at = `questions[${qi}].credential`;
    const fail = (msg: string): never => {
      throw new ToolExecutionError(`${at}${msg}`, { tool_name: this.name });
    };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(" must be an object");
    if (questionCount !== 1) return fail(" requires it to be the only question");
    const c = raw as Record<string, unknown>;

    if (typeof c.host !== "string" || !HOST_RE.test(c.host)) {
      return fail(".host must be lowercase letters, digits, dots and hyphens (optional leading '*.')");
    }
    if (c.path_prefix !== undefined && (typeof c.path_prefix !== "string" || !c.path_prefix.startsWith("/"))) {
      return fail(".path_prefix must be a string starting with '/'");
    }
    if (
      typeof c.purpose !== "string" || c.purpose.trim() === "" || c.purpose.length > 200 ||
      CONTROL_CHARS_RE.test(c.purpose)
    ) {
      return fail(".purpose must be 1–200 characters of plain text");
    }
    for (const key of ["env_name", "base_url_env_name"] as const) {
      const v = c[key];
      if (v !== undefined && (typeof v !== "string" || !ENV_NAME_RE.test(v))) {
        return fail(`.${key} must match ${ENV_NAME_RE.source}`);
      }
    }
    if (c.rotate !== undefined && typeof c.rotate !== "boolean") return fail(".rotate must be a boolean");

    const out: AskUserCredential = { host: c.host, purpose: c.purpose };
    if (c.path_prefix !== undefined) out.path_prefix = c.path_prefix as string;
    if (c.env_name !== undefined) out.env_name = c.env_name as string;
    if (c.base_url_env_name !== undefined) out.base_url_env_name = c.base_url_env_name as string;
    if (c.rotate !== undefined) out.rotate = c.rotate as boolean;
    return out;
  }

  summarize(input: AskUserInput): string {
    const first = input.questions[0]!.question;
    const truncated = first.length > 60 ? first.slice(0, 60) + "…" : first;
    const extra = input.questions.length > 1 ? ` (+${input.questions.length - 1} more)` : "";
    return `Ask user: "${truncated}"${extra}`;
  }

  async execute(input: AskUserInput, ctx: ToolContext): Promise<ToolResult> {
    // Race the handler against the abort signal.
    let onAbort: (() => void) | undefined;
    let response: AskUserResponse;
    try {
      response = await Promise.race([
        this.handler({ tool_use_id: ctx.toolUseId ?? ctx.runId, questions: input.questions }, ctx.signal),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new AbortError("aborted", { cause: ctx.signal.reason }));
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (err) {
      if (err instanceof AbortError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `AskUser failed: ${msg}`,
        summary: "AskUser failed",
        is_error: true,
      };
    } finally {
      if (onAbort !== undefined) ctx.signal.removeEventListener("abort", onAbort);
    }

    if (typeof response !== "object" || response === null) {
      return {
        content: "AskUser handler returned an invalid response: expected an object",
        summary: "AskUser handler error",
        is_error: true,
      };
    }

    // Declined
    if ("declined" in response) {
      if (response.declined !== true) {
        return {
          content: "AskUser handler returned an invalid response: declined must be true when present",
          summary: "AskUser handler error",
          is_error: true,
        };
      }
      const reasonClause = response.reason ? ` (reason: ${response.reason})` : "";
      return {
        content: `The user declined to answer${reasonClause}. Proceed using your best judgment and state any assumptions you make.`,
        summary: "User declined to answer",
        is_error: false,
      };
    }

    // Validate response
    const { answers } = response;
    if (!Array.isArray(answers)) {
      return {
        content: "AskUser handler returned an invalid response: answers must be an array",
        summary: "AskUser handler error",
        is_error: true,
      };
    }
    if (answers.length !== input.questions.length) {
      return {
        content: `AskUser handler returned an invalid response: expected ${input.questions.length} answer(s), got ${answers.length}`,
        summary: "AskUser handler error",
        is_error: true,
      };
    }
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i]!;
      const q = input.questions[i]!;
      if (!a || !Array.isArray(a.selected)) {
        return {
          content: `AskUser handler returned an invalid response: answers[${i}].selected must be an array`,
          summary: "AskUser handler error",
          is_error: true,
        };
      }
      if (a.selected.length === 0 || a.selected.some((s: unknown) => typeof s !== "string" || (s as string).trim() === "")) {
        return {
          content: `AskUser handler returned an invalid response: answers[${i}].selected must contain at least one non-empty string`,
          summary: "AskUser handler error",
          is_error: true,
        };
      }
      if (!q.multi_select && a.selected.length !== 1) {
        return {
          content: `AskUser handler returned an invalid response: answers[${i}].selected must have exactly one entry when multi_select is false`,
          summary: "AskUser handler error",
          is_error: true,
        };
      }
    }

    // Render answers
    const lines: string[] = ["User answered:", ""];
    for (let i = 0; i < input.questions.length; i++) {
      const q = input.questions[i]!;
      const a = answers[i]!;
      lines.push(`[${q.header}] ${q.question}`);
      lines.push(`→ ${a.selected.join(", ")}`);
      if (i < input.questions.length - 1) lines.push("");
    }

    const n = input.questions.length;
    return {
      content: lines.join("\n"),
      summary: `User answered ${n} question${n === 1 ? "" : "s"}`,
      is_error: false,
    };
  }
}
