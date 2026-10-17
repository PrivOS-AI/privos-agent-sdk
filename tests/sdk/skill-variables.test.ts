import { describe, expect, it } from "bun:test";
import { substituteSkillBody } from "../../src/skills/substitute.js";
import type { Skill } from "../../src/skills/types.js";

const skill = (body: string): Skill => ({
  name: "s",
  dir: "/abs/skills/s",
  frontmatter: { name: "s", description: "d", disableModelInvocation: false },
  body,
});

describe("skill body variables", () => {
  it("substitutes ${PRIVOS_SKILL_DIR} and ${PRIVOS_SESSION_ID}", () => {
    const out = substituteSkillBody({
      skill: skill("bash ${PRIVOS_SKILL_DIR}/run.sh ${PRIVOS_SESSION_ID}"),
      args: "",
      sessionId: "sid-1",
    });
    expect(out).toContain("bash /abs/skills/s/run.sh sid-1");
  });

  it("leaves the removed upstream variables verbatim", () => {
    const body = "bash ${SKAWLD_SKILL_DIR}/run.sh ${SKAWLD_SESSION_ID}";
    const out = substituteSkillBody({ skill: skill(body), args: "", sessionId: "sid-1" });
    expect(out).toContain(body);
  });
});
