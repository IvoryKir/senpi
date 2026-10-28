import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type JobWidgetAuthor,
	type JobWidgetEntryState,
	JobWidgetRegistry,
	type JobWidgetState,
	TextTap,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { UNMATCHED_SPEC } from "./author-support.ts";

// Security contract: clients persist job_widget_state, so no credential a job prints may reach it.
const TOKENS: readonly (readonly [string, string, string])[] = [
	["GitHub token", `ghp_${"A1b2C3d4E5".repeat(4)}`, "deploy with"],
	["OpenAI project key", `sk-proj-${"Zx9Yw8Vu7T".repeat(4)}`, "using key"],
	["AWS access key id", "AKIAIOSFODNN7EXAMPLE", "aws id"],
	["bearer token", "abcDEF1234567890xyzTOKEN", "Authorization: Bearer"],
];

/** Every line is the newest at some point, so it reaches the stage and the text block. */
const LINE_SPEC = {
	title: "deploy",
	rules: [{ from: "out", match: "^(?P<line>.+)$", text: "line" }],
	blocks: [{ kind: "text", field: "line" }],
	stage: "line",
};

const AUTHORS: readonly (readonly [JobWidgetEntryState, () => JobWidgetAuthor])[] = [
	["pending", () => () => new Promise<unknown>(() => {})],
	["fallback", () => async () => UNMATCHED_SPEC],
	["live", () => async () => LINE_SPEC],
];

describe("job widget views are redacted before they are published", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe.each(AUTHORS)("%s", (state, makeAuthor) => {
		it.each(TOKENS)("never carries a printed %s", async (_name, token, prefix) => {
			const sent: JobWidgetState[] = [];
			const registry = new JobWidgetRegistry({
				sessionId: "session_1",
				author: makeAuthor(),
				publish: (published) => sent.push(published),
				limits: { authorAfterMs: 0 },
			});
			const tap = new TextTap("out", "command output");
			const handle = registry.add({
				id: "bash_1",
				kind: "bash",
				sources: [tap],
				brief: { command: `./deploy.sh ${prefix} ${token}` },
				startedAtMs: Date.now(),
			});
			tap.append(`step 1 rps=40\nstep 2 rps=44\nstep 3 rps=51\n${prefix} ${token}\n`);
			handle.notify();
			await vi.advanceTimersByTimeAsync(3000);

			const last = sent.at(-1)?.jobs[0];
			expect(last?.state).toBe(state);
			const published = JSON.stringify([...sent, registry.state()]);
			expect(published).not.toContain(token);
			expect(last?.view?.stage).toBe(`${prefix} [REDACTED]`);
			if (state === "live") expect(last?.view?.blocks).toEqual([{ kind: "text", text: `${prefix} [REDACTED]` }]);
			else expect(last?.view?.title).toContain("[REDACTED]");
			registry.dispose();
		});
	});
});
