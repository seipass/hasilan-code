// Sample external theme plugin for Hasilan Code.
// Register in plugins.json: { "sample-dusk": "./examples/plugins/sample-theme/plugin.cjs" }
exports.apiVersion = 1;
exports.theme = {
	title: "Dusk (Sample)",
	dark: { background: "#102030", foreground: "#e9eef4", accent: "#9bc4ff", contrast: 55 },
	light: { background: "#faf3e8", foreground: "#23283d", accent: "#2f57a8", contrast: 50 },
};
