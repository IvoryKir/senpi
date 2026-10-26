import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { showPermissionPrompt } from "../../src/core/extensions/builtin/permission-system/prompt.ts";
import type { Request } from "../../src/core/extensions/builtin/permission-system/types.ts";

function directoryShownFor(request: Request): Promise<string | undefined> {
	let shown: string | undefined;
	const ctx = {
		ui: {
			select: async (title: string) => {
				shown = title
					.split("\n")
					.find((line) => line.startsWith("Directory: "))
					?.slice("Directory: ".length);
				return "Deny";
			},
			input: async () => undefined,
		},
	} as unknown as ExtensionContext;
	return showPermissionPrompt(ctx, request).then(() => shown);
}

describe("external_directory prompt target (senpi#4311)", () => {
	it("names the resolved path the tool opens, not the call's raw spelling", async () => {
		// given: a write of `@/tmp/outside.txt`, whose resolved external_directory pattern is `/tmp/outside.txt`
		const request: Request = {
			id: "req-1",
			sessionID: "session-1",
			permission: "external_directory",
			patterns: ["/tmp/outside.txt"],
			always: ["/tmp/*"],
			metadata: { filepath: "@/tmp/outside.txt" },
		};

		// when / then: the Directory the user approves is the file that will be touched
		expect(await directoryShownFor(request)).toBe("/tmp/outside.txt");
	});
});
