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
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{ name: "terminal", test: /node_modules[\\/]@xterm[\\/]/ },
						{ name: "markdown", test: /node_modules[\\/](?:react-markdown|remark|rehype|micromark|mdast|hast|unist)/ },
					],
				},
			},
		},
	},
});
