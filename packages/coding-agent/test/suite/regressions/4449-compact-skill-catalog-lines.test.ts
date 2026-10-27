import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "../../../src/core/skills.ts";
import { isLargeSkillCatalog } from "../../../src/core/skills-prompt.ts";

// Regression for code-yeongyu/senpi#4449: a large skill catalog is one line per skill, and every listed skill's
// file still resolves from its line plus the roots table.
const DESCRIPTION =
	"Runs the release train end to end across the packages, the changelog audit, the tag, the publish workflow and the binary builds. Use when the user says release, cut a release, or hotfix, and also when a publish failed and needs a retry from the existing tag without re-running the script.";

function skill(root: string, name: string, file = `${name}/SKILL.md`): Skill {
	return {
		name,
		description: DESCRIPTION,
		filePath: `${root}/${file}`,
		baseDir: `${root}/${file.split("/").slice(0, -1).join("/")}`,
		sourceInfo: { path: `${root}/${file}`, source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
		requiresArguments: false,
	} as Skill;
}

function resolveLine(prompt: string, line: string): string {
	const match = line.match(/^- ([^ ]+) \[([^\]]+)\]/);
	if (!match) throw new Error(`not a catalog line: ${line}`);
	const [, name, location] = match;
	const [alias, ...rest] = location.split("/");
	const root = prompt.match(new RegExp(`<${alias}>([^<]+)</${alias}>`))?.[1];
	return rest.length === 0 ? `${root}/${name}/SKILL.md` : `${root}/${rest.join("/")}`;
}

describe("regression senpi#4449: a large skill catalog is listed one line per skill", () => {
	const skills = [
		...Array.from({ length: 96 }, (_, index) => skill("/home/u/.agents/skills", `skill-${index}`)),
		skill("/opt/runtime/dist", "bundled-guide", "bundle/SKILL-3R5ZD4J5.md"),
		skill("/opt/plugin/skills", "plugin-skill"),
	];

	it("treats 98 skills with ~300-character descriptions as large", () => {
		expect(skills.length).toBeLessThanOrEqual(100);
		expect(isLargeSkillCatalog(skills)).toBe(true);
	});

	it("renders name, shortest resolvable location and a short when-to-use line", () => {
		const prompt = formatSkillsForPrompt(skills);
		const lines = prompt.split("\n").filter((line) => line.startsWith("- "));

		expect(lines).toHaveLength(skills.length);
		expect(prompt).not.toContain("<description>");
		expect(prompt).toContain("</available_skills>");
		for (const line of lines) expect(line.slice(line.indexOf("]: ") + 3).length).toBeLessThanOrEqual(100);
		expect(lines[0]).toMatch(/^- skill-0 \[r0\]: Runs the release train end to end/);
		expect(lines[0]).toMatch(/…$/);
		for (const [index, line] of lines.entries()) expect(resolveLine(prompt, line)).toBe(skills[index]?.filePath);
	});
});
