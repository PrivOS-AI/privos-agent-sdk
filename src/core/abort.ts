/** AbortSignal helpers. */

import { AbortError } from "./errors.js";

/**
 * Combine multiple AbortSignals. The result fires when any input fires.
 * Backed by AbortSignal.any (Bun 1.1+), which uses weak listeners internally —
 * so a long-lived caller signal reused across many runs accrues no lingering
 * listeners once each combined signal is unreferenced.
 */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

/**
 * A per-call child of `parent` to hand to a vendor SDK. Their stream helpers
 * add abort listeners they never remove; on the run's AbortSignal.any signal
 * Node keeps a signal with live abort listeners alive (gcPersistentSignals),
 * so every request body would stay reachable for the life of the process.
 * The vendor listeners land on the child instead; dispose() unlinks it.
 */
export function childSignal(parent: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const child = new AbortController();
  const onAbort = () => child.abort(parent.reason);
  if (parent.aborted) child.abort(parent.reason);
  else parent.addEventListener("abort", onAbort, { once: true });
  return { signal: child.signal, dispose: () => parent.removeEventListener("abort", onAbort) };
}

/** Throw AbortError if the signal has fired. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortError("aborted", { cause: signal.reason });
  }
}
