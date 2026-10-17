/** Config loader: resolves and merges all sources in precedence order (module 09). */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigError } from "../core/errors.js";
import {
  PERMISSION_MODES, PROVIDER_IDS, validateConfig,
  type ConfigWarning, type ProviderId, type PrivOSAgentConfig,
} from "./schema.js";

export type { ConfigWarning } from "./schema.js";

export interface LoadConfigOptions {
  cwd: string;
  /** Override the project config path. Default: ${cwd}/.privos-agent-sdk/config.json. */
  projectConfigPath?: string;
  /** Skip the user config file even if it exists. */
  ignoreUserConfig?: boolean;
  /**
   * Accept permissive permissions (any "allow" rule of any kind, or a mode of
   * "acceptEdits"/"yolo") found in the PROJECT config file. Default false.
   */
  acceptProjectConfig?: boolean;
  /** Programmatic overrides, already parsed into the PrivOSAgentConfig shape. */
  overrides?: Partial<PrivOSAgentConfig>;
  /** Environment snapshot, default process.env. */
  env?: Record<string, string | undefined>;
}

export interface LoadedConfig {
  config: PrivOSAgentConfig;
  sources: Array<{ source: "default" | "user" | "project" | "env" | "override"; path?: string }>;
  warnings: ConfigWarning[];
}

/** A provider object that may omit `id` (e.g. the env layer with only PRIVOS_AGENT_BASE_URL). */
type PartialProvider = { id?: ProviderId; apiKey?: string; baseURL?: string; options?: Record<string, unknown> };

export async function loadConfig(opts: LoadConfigOptions): Promise<LoadedConfig> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const warnings: ConfigWarning[] = [];
  const sources: LoadedConfig["sources"] = [{ source: "default" }];

  let merged: PrivOSAgentConfig = {};

  // 2. User config — trusted, never gated.
  if (!opts.ignoreUserConfig) {
    // Resolve the home directory from the env snapshot first (HOME / USERPROFILE),
    // falling back to os.homedir(). Under the default snapshot (process.env) these
    // are identical, so real usage is unchanged; the indirection keeps the loader
    // fully driven by its inputs and testable without mutating the global home.
    const homeDir = env.HOME ?? env.USERPROFILE ?? homedir();
    const userPath = path.join(homeDir, ".privos-agent-sdk", "config.json");
    const raw = await readConfigFile(userPath);
    if (raw !== undefined) {
      const cfg = validateConfig(raw, { file: userPath, warnings });
      warnApiKeyOnDisk(cfg, userPath, warnings);
      merged = mergeConfig(merged, resolveSystemPromptFile(cfg, path.dirname(userPath)));
      sources.push({ source: "user", path: userPath });
    }
  }

  // 3. Project config — untrusted, gated.
  const projectPath = path.resolve(opts.cwd, opts.projectConfigPath ?? env.PRIVOS_AGENT_CONFIG ?? path.join(opts.cwd, ".privos-agent-sdk", "config.json"));
  const projectRaw = await readConfigFile(projectPath);
  if (projectRaw !== undefined) {
    const cfg = validateConfig(projectRaw, { file: projectPath, warnings });
    enforceProjectGate(cfg, projectPath, opts.acceptProjectConfig === true);
    warnApiKeyOnDisk(cfg, projectPath, warnings);
    merged = mergeConfig(merged, resolveSystemPromptFile(cfg, path.dirname(projectPath)));
    sources.push({ source: "project", path: projectPath });
  }

  // 4. Environment variables — applied as a single trusted source.
  const envConfig = configFromEnv(env);
  if (Object.keys(envConfig).length > 0) {
    merged = mergeConfig(merged, resolveSystemPromptFile(envConfig, opts.cwd));
    sources.push({ source: "env" });
  }

  // 5. Programmatic overrides — trusted, the final word.
  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    const cfg = validateConfig(opts.overrides, { warnings });
    merged = mergeConfig(merged, resolveSystemPromptFile(cfg, opts.cwd));
    sources.push({ source: "override" });
  }

  if (merged.systemPrompt !== undefined && merged.systemPromptFile !== undefined) {
    warnings.push({
      pointer: "/systemPromptFile",
      message: `systemPrompt is set, so systemPromptFile (${merged.systemPromptFile}) is ignored`,
    });
  }

  return { config: merged, sources, warnings };
}

async function readConfigFile(absPath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`Cannot read config file ${absPath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in config file ${absPath}: ${(err as Error).message}`);
  }
}

function resolveSystemPromptFile(cfg: PrivOSAgentConfig, declaringDir: string): PrivOSAgentConfig {
  if (cfg.systemPromptFile === undefined || path.isAbsolute(cfg.systemPromptFile)) return cfg;
  return { ...cfg, systemPromptFile: path.resolve(declaringDir, cfg.systemPromptFile) };
}

function warnApiKeyOnDisk(cfg: PrivOSAgentConfig, file: string, warnings: ConfigWarning[]): void {
  if (cfg.provider?.apiKey !== undefined) {
    warnings.push({
      file,
      pointer: "/provider/apiKey",
      message: "provider.apiKey is set in a config file on disk; prefer an environment variable",
    });
  }
}

function enforceProjectGate(cfg: PrivOSAgentConfig, file: string, accept: boolean): void {
  if (accept) return;
  const offending: string[] = [];
  const mode = cfg.permissions?.mode;
  if (mode === "acceptEdits" || mode === "yolo") offending.push("/permissions/mode");
  cfg.permissions?.rules?.forEach((rule, i) => {
    if (rule.decision === "allow") offending.push(`/permissions/rules/${i}`);
  });
  if (offending.length > 0) {
    throw new ConfigError(
      `Project config ${file} requests permissive permissions at ${offending.join(", ")}; ` +
      `pass acceptProjectConfig: true to load it`,
    );
  }
}

function configFromEnv(env: Record<string, string | undefined>): PrivOSAgentConfig {
  const out: PrivOSAgentConfig = {};
  if (env.PRIVOS_AGENT_MODEL !== undefined) out.model = env.PRIVOS_AGENT_MODEL;

  const provider: PartialProvider = {};
  if (env.PRIVOS_AGENT_PROVIDER !== undefined) {
    if (!PROVIDER_IDS.includes(env.PRIVOS_AGENT_PROVIDER as ProviderId)) {
      throw new ConfigError(`Invalid PRIVOS_AGENT_PROVIDER "${env.PRIVOS_AGENT_PROVIDER}": must be one of ${PROVIDER_IDS.join(", ")}`);
    }
    provider.id = env.PRIVOS_AGENT_PROVIDER as ProviderId;
  }
  if (env.PRIVOS_AGENT_BASE_URL !== undefined) provider.baseURL = env.PRIVOS_AGENT_BASE_URL;
  if (Object.keys(provider).length > 0) out.provider = provider as PrivOSAgentConfig["provider"];

  if (env.PRIVOS_AGENT_PERMISSION_MODE !== undefined) {
    if (!PERMISSION_MODES.includes(env.PRIVOS_AGENT_PERMISSION_MODE as never)) {
      throw new ConfigError(`Invalid PRIVOS_AGENT_PERMISSION_MODE "${env.PRIVOS_AGENT_PERMISSION_MODE}": must be one of ${PERMISSION_MODES.join(", ")}`);
    }
    out.permissions = { mode: env.PRIVOS_AGENT_PERMISSION_MODE as never };
  }

  if (env.PRIVOS_AGENT_SYSTEM_PROMPT_FILE !== undefined) out.systemPromptFile = env.PRIVOS_AGENT_SYSTEM_PROMPT_FILE;

  if (env.PRIVOS_AGENT_MAX_TURNS !== undefined) {
    const n = Number(env.PRIVOS_AGENT_MAX_TURNS);
    if (!Number.isInteger(n) || n < 1) {
      throw new ConfigError(`Invalid PRIVOS_AGENT_MAX_TURNS "${env.PRIVOS_AGENT_MAX_TURNS}": must be an integer ≥ 1`);
    }
    out.limits = { maxTurns: n };
  }

  if (env.PRIVOS_AGENT_DB_PATH !== undefined) out.sessionStore = { kind: "sqlite", databasePath: env.PRIVOS_AGENT_DB_PATH };

  return out;
}

// --- merge ---

function mergeConfig(base: PrivOSAgentConfig, next: PrivOSAgentConfig): PrivOSAgentConfig {
  const out: PrivOSAgentConfig = { ...base };

  if (next.provider !== undefined || base.provider !== undefined) {
    out.provider = mergeDiscriminated(base.provider, next.provider, "id") as PrivOSAgentConfig["provider"];
  }
  if (next.sessionStore !== undefined || base.sessionStore !== undefined) {
    out.sessionStore = mergeDiscriminated(base.sessionStore, next.sessionStore, "kind") as PrivOSAgentConfig["sessionStore"];
  }
  if (next.model !== undefined) out.model = next.model;
  if (next.cwd !== undefined) out.cwd = next.cwd;
  if (next.systemPrompt !== undefined) out.systemPrompt = next.systemPrompt;
  if (next.systemPromptFile !== undefined) out.systemPromptFile = next.systemPromptFile;

  if (next.permissions !== undefined || base.permissions !== undefined) {
    const mode = next.permissions?.mode ?? base.permissions?.mode;
    const rules = [...(base.permissions?.rules ?? []), ...(next.permissions?.rules ?? [])];
    const permissions: NonNullable<PrivOSAgentConfig["permissions"]> = {};
    if (mode !== undefined) permissions.mode = mode;
    if (rules.length > 0) permissions.rules = rules;
    out.permissions = permissions;
  }

  if (next.limits !== undefined || base.limits !== undefined) {
    out.limits = { ...base.limits, ...next.limits };
  }

  return out;
}

/**
 * Merge two discriminated-union objects. When the higher source sets the
 * discriminant to a value different from the lower one, it replaces the object
 * whole (nothing carries over). When the discriminant matches or the higher
 * source omits it, shallow-merge.
 */
function mergeDiscriminated<T extends Record<string, unknown>>(
  base: T | undefined,
  next: T | undefined,
  key: keyof T,
): T | undefined {
  if (next === undefined) return base;
  if (base === undefined) return { ...next };
  if (next[key] !== undefined && next[key] !== base[key]) return { ...next };
  return { ...base, ...next };
}
