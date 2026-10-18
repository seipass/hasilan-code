import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		},
		resolve: {
			conditions: ["source"],
			alias: [{ find: /^@hasilan-code\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
		ssr: { resolve: { conditions: ["source"] } },
	}),
);
