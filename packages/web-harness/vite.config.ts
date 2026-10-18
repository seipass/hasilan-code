import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react()],
	build: {
		outDir: "dist/client",
		emptyOutDir: true,
		sourcemap: true,
		license: { fileName: "THIRD_PARTY_LICENSES.txt" },
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{ name: "react", test: /node_modules[\\/](?:react|react-dom|scheduler)(?:[\\/]|$)/ },
						{ name: "terminal", test: /node_modules[\\/]@xterm[\\/]/ },
						{ name: "markdown", test: /node_modules[\\/](?:react-markdown|remark|rehype|micromark|mdast|hast|unist)/ },
					],
				},
			},
		},
	},
});
