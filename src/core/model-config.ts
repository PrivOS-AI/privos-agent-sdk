import { ConfigError } from "./errors.js";
import type { AgentInternal } from "./agent.js";
import type { RunOptions } from "./session.js";
import type { ModelId } from "./types.js";

/** Host-configured model identity, route capabilities and desired request budget. */
export interface ModelConfiguration {
  model: ModelId;
  /** Total context capacity of the effective model/route. */
  contextWindow?: number;
  /** Output capability, not a request to generate that many tokens. */
  maxOutputTokens?: number;
  /** Desired per-request output budget when Run/Agent options do not override it. */
  outputTokenBudget?: number;
}

/** One immutable selection used by preflight, the request and its context retry. */
export interface TurnModel {
  model: ModelId;
  contextWindow: number;
  configuredContextWindow?: number;
  maxOutputTokens?: number;
  maxOutputCapacity?: number;
}

function positiveTokens(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new ConfigError(`${label} must be a positive safe integer`);
  }
}

/** Select a request budget without treating capacity as intent or shrinking to fit context. */
export function resolveOutputTokenBudget(
  requested: number | undefined,
  capacity?: number,
  configuredContextWindow?: number,
): number | undefined {
  positiveTokens(requested, "Request maxOutputTokens");
  positiveTokens(capacity, "Model maxOutputTokens");
  positiveTokens(configuredContextWindow, "Model contextWindow");
  const budget = requested === undefined ? undefined
    : capacity === undefined ? requested : Math.min(requested, capacity);
  if (configuredContextWindow !== undefined && budget !== undefined && budget >= configuredContextWindow) {
    throw new ConfigError("Request output budget must be smaller than the configured contextWindow");
  }
  return budget;
}

export function resolveTurnModel(
  ai: AgentInternal,
  opts: RunOptions = {},
  modelOverride?: ModelId,
): TurnModel {
  const requested = modelOverride ?? ai.model;
  const configured = ai.resolveModel?.(requested);
  const model = configured?.model ?? requested;
  if (typeof model !== "string" || !model.trim()) throw new ConfigError("Resolved model must be a non-empty string");
  positiveTokens(configured?.outputTokenBudget, "Model outputTokenBudget");
  const requestedBudget = opts.maxOutputTokens ?? ai.maxOutputTokens
    ?? configured?.outputTokenBudget ?? ai.provider.defaultOutputTokens?.(model);
  const capacity = configured?.maxOutputTokens;
  const maxOutputTokens = resolveOutputTokenBudget(requestedBudget, capacity, configured?.contextWindow);
  return {
    model,
    contextWindow: configured?.contextWindow ?? ai.provider.contextWindow(model),
    ...(configured?.contextWindow !== undefined && { configuredContextWindow: configured.contextWindow }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    ...(capacity !== undefined && { maxOutputCapacity: capacity }),
  };
}
