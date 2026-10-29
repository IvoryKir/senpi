import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentConformance = fileURLToPath(new URL("../../agent/src/conformance/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-agent-core\/conformance$/, replacement: agentConformance }],
	},
});
