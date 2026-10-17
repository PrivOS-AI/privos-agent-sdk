import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/sdk.js";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "privos-agent-config-env-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const load = (env: Record<string, string>) => loadConfig({ cwd: root, env: { HOME: root, ...env } });

describe("config environment and directory", () => {
  it("reads PRIVOS_AGENT_* variables", async () => {
    const { config } = await load({ PRIVOS_AGENT_MODEL: "m-new", PRIVOS_AGENT_MAX_TURNS: "1" });
    expect(config.model).toBe("m-new");
    expect(config.limits?.maxTurns).toBe(1);
  });

  it("ignores the removed SKAWLD_* variables", async () => {
    const { config, sources } = await load({ SKAWLD_MODEL: "m-old", SKAWLD_MAX_TURNS: "1" });
    expect(config.model).toBeUndefined();
    expect(config.limits?.maxTurns).toBeUndefined();
    expect(sources.some((s) => s.source === "env")).toBe(false);
  });

  it("loads .privos-agent-sdk/config.json and not .skawld/config.json", async () => {
    for (const [dir, model] of [[".skawld", "m-old"], [".privos-agent-sdk", "m-new"]]) {
      mkdirSync(path.join(root, dir), { recursive: true });
      writeFileSync(path.join(root, dir, "config.json"), JSON.stringify({ model }));
    }
    const { config } = await loadConfig({ cwd: root, env: {}, ignoreUserConfig: true });
    expect(config.model).toBe("m-new");
    rmSync(path.join(root, ".privos-agent-sdk"), { recursive: true });
    const { config: oldOnly } = await loadConfig({ cwd: root, env: {}, ignoreUserConfig: true });
    expect(oldOnly.model).toBeUndefined();
  });
});
