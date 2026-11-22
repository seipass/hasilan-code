import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { ReactNode } from "react";

/**
 * One highlighter for the file viewer and every tool card. Two instances meant two
 * grammars for the same extension, so a file could be colored differently in the
 * editor and in the read card that produced it.
 */
const highlighter = hljs.newInstance();
for (const [name, language] of Object.entries({ bash, cpp, csharp, css, diff, go, ini, java, javascript, json, markdown, powershell, python, rust, sql, typescript, xml, yaml }))
	highlighter.registerLanguage(name, language);

const extensions: Record<string, string> = {
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	json: "json", jsonc: "json", css: "css", scss: "css", less: "css",
	html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
	py: "python", pyw: "python", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell",
	md: "markdown", markdown: "markdown", mdx: "markdown",
	yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini", env: "ini",
	c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
	java: "java", go: "go", rs: "rust", sql: "sql", diff: "diff", patch: "diff", gitignore: "bash",
};

/** Highlight.js language for a path, matched on the last extension or a bare filename. */
export function languageForPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	if (name === "dockerfile" || name === "makefile") return name === "makefile" ? "bash" : undefined;
	const extension = name.includes(".") ? name.split(".").at(-1) : name;
	return extension ? extensions[extension] : undefined;
}

/**
 * Split highlighted HTML into one fragment list per source line so callers can put a
 * gutter next to code or reuse the plain text. Only highlight.js's escaped output
 * enters the inert document; no parsed node is inserted into the live DOM.
 */
export function highlightLines(text: string, language?: string, auto = false): ReactNode[][] {
	// Without a DOM (server rendering, tests) the text still has to come back intact.
	if (typeof DOMParser === "undefined") return text.split("\n").map((line) => [line]);
	if ((!language || !highlighter.getLanguage(language)) && !auto) return text.split("\n").map((line) => [line]);
	const result = language && highlighter.getLanguage(language)
		? highlighter.highlight(text, { language, ignoreIllegals: true })
		: highlighter.highlightAuto(text, ["javascript", "typescript", "python", "json", "bash", "css", "xml", "sql"]);
	const document = new DOMParser().parseFromString(result.value, "text/html");
	const lines: ReactNode[][] = [[]];
	let key = 0;
	function collect(node: Node, classes: string[]) {
		if (node.nodeType === Node.TEXT_NODE) {
			const parts = (node.textContent ?? "").split("\n");
			for (let index = 0; index < parts.length; index++) {
				if (index > 0) lines.push([]);
				if (!parts[index]) continue;
				lines[lines.length - 1].push(classes.length > 0 ? <span key={key++} className={classes.join(" ")}>{parts[index]}</span> : parts[index]);
			}
			return;
		}
		const tokenClasses = node instanceof Element && node.tagName === "SPAN"
			? Array.from(node.classList).filter((name) => /^hljs-[a-z0-9_-]+$/i.test(name)) : [];
		for (const child of node.childNodes) collect(child, [...classes, ...tokenClasses]);
	}
	for (const node of document.body.childNodes) collect(node, []);
	return lines;
}
