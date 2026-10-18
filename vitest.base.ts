import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@hasilan-code\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@hasilan-code\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@hasilan-code\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@hasilan-code\/chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@hasilan-code\/pi-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@hasilan-code\/pi-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@hasilan-code\/pi-mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@hasilan-code\/pi-mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@hasilan-code\/pi-mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			{ find: /^@hasilan-code\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@hasilan-code\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@hasilan-code\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@hasilan-code\/pi-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@hasilan-code\/pi-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@hasilan-code\/pi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@hasilan-code\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@hasilan-code\/pi-codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{ find: /^@hasilan-code\/pi-codemode\/declarations$/, replacement: workspaceSourcePaths.codemodeDeclarations },
			{ find: /^@hasilan-code\/pi-codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			{ find: /^@hasilan-code\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
