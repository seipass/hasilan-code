import type { Element, ElementContent, Root, RootContent } from "hast";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import "./ColorPreview.css";

const colorPattern = /(?<![\w#-])(?:#[\da-f]{8}(?![\w-])|#[\da-f]{6}(?![\w-])|#[\da-f]{4}(?![\w-])|#[\da-f]{3}(?![\w-])|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()\r\n]{1,100}\))/gi;

function validColor(value: string): boolean {
	if (value.startsWith("#")) return true;
	if (typeof CSS !== "undefined" && typeof CSS.supports === "function") return CSS.supports("color", value);
	return /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([\d\s.,%+\-/]+\)$/i.test(value);
}

/** Splits text into plain segments and inline color preview chips. */
export function splitColorPreview(text: string, keyPrefix = "cp"): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let index = 0;
	for (const match of text.matchAll(colorPattern)) {
		if (!validColor(match[0])) continue;
		if (match.index > last) out.push(text.slice(last, match.index));
		out.push(
			<span key={`${keyPrefix}-${index++}`} className="color-preview">
				{match[0]}
				<span aria-hidden="true" className="color-preview-swatch" style={{ backgroundColor: match[0] }} />
			</span>,
		);
		last = match.index + match[0].length;
	}
	if (last === 0) return [text];
	if (last < text.length) out.push(text.slice(last));
	return out;
}

/** Add a visual marker only to rendered text, never to link targets. */
export function rehypeColorPreview() {
	return (root: Root) => {
		function visit(parent: Root | Element): void {
			if (parent.type === "element" && parent.tagName === "a") return;
			const children: RootContent[] = [];
			for (const child of parent.children) {
				if (child.type === "element") visit(child);
				if (child.type !== "text") { children.push(child); continue; }
				let last = 0;
				for (const match of child.value.matchAll(colorPattern)) {
					if (!validColor(match[0])) continue;
					if (match.index > last) children.push({ type: "text", value: child.value.slice(last, match.index) });
					children.push({
						type: "element",
						tagName: "span",
						properties: { dataColorPreview: match[0] },
						children: [{ type: "text", value: match[0] }],
					});
					last = match.index + match[0].length;
				}
				if (last === 0) children.push(child);
				else if (last < child.value.length) children.push({ type: "text", value: child.value.slice(last) });
			}
			if (parent.type === "root") parent.children = children;
			else parent.children = children.filter((child): child is ElementContent => child.type !== "doctype");
		}
		visit(root);
	};
}

export function ColorPreviewSpan({ node, children, ...props }: ComponentPropsWithoutRef<"span"> & ExtraProps) {
	const color = node?.properties?.dataColorPreview;
	if (typeof color !== "string") return <span {...props}>{children}</span>;
	return <span className="color-preview">{children}<span aria-hidden="true" className="color-preview-swatch" style={{ backgroundColor: color }} /></span>;
}
