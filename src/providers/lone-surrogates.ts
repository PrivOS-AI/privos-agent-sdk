/**
 * Lone-surrogate sanitizer for outgoing provider requests.
 *
 * A string cut mid-emoji (`slice` through 📱) ends in a lone UTF-16 surrogate. JSON.stringify
 * writes it as a `\ud83d` escape, the gateway decodes that back into a lone surrogate and cannot
 * re-encode the prompt as UTF-8, so it rejects the whole request (Z.ai: HTTP 500 "surrogates not
 * allowed") and LiteLLM then benches the deployment for every tenant.
 */

// A high surrogate with no low one after it, or a low surrogate with no high one before it. No `u`
// flag on purpose: the pattern has to see UTF-16 code units, not code points.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Remove unpaired UTF-16 surrogates. Valid surrogate pairs (emoji) and all other text are kept. */
export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, "");
}

/**
 * Deep-copy `value` with every string sanitized, object keys included. Strings, arrays and plain
 * objects are walked; every other value (numbers, booleans, null, Buffers and typed arrays, class
 * instances such as AbortSignal) is returned by reference. The input is never mutated.
 */
export function sanitizeLoneSurrogates<T>(value: T): T {
  if (typeof value === "string") return stripLoneSurrogates(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeLoneSurrogates) as T;
  if (isPlainObject(value)) {
    // fromEntries defines own data properties. Assigning `out[key] = ...` would instead run the
    // prototype setter for a `__proto__` key and silently drop it from the copy.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        stripLoneSurrogates(key),
        sanitizeLoneSurrogates(item),
      ]),
    ) as T;
  }
  return value;
}

/** Object literals, JSON.parse output and `Object.create(null)` dictionaries; not class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
