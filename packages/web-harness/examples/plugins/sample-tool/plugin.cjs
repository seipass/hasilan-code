// Sample external tool plugin for Hasilan Code.
// Register in plugins.json: { "sample-tool": "./examples/plugins/sample-tool/plugin.cjs" }
exports.apiVersion = 1;

exports.tools = (session) => [
	{
		name: "workspace_info",
		label: "Workspace Info",
		description: "Returns the active workspace ID and working directory.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			return {
				content: [{ type: "text", text: `workspace=${session.workspaceId} cwd=${session.cwd}` }],
				details: { workspaceId: session.workspaceId, cwd: session.cwd },
			};
		},
	},
];
