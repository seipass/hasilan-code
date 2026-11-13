import { ipcRenderer } from "electron";
import {
	BROWSER_ADJUSTMENT_PROPERTIES,
	browserPreviewStyles,
} from "../../../packages/web-harness/src/shared/browser-adjustments.ts";

type Mode = "element" | "text" | "region";
let mode: Mode | undefined;
let start: { x: number; y: number } | undefined;
let marker: HTMLDivElement | undefined;
let suppressClick = false;
let inspecting = false;
let textAnchor: Range | null = null;
let selected: { element: HTMLElement | SVGElement; id: number; url: string } | undefined;
let selectionId = 0;
const originalStyles = new Map<string, { value: string; priority: string }>();
const shorthandParts: Readonly<Record<string, readonly string[]>> = {
	"border-radius": [
		"border-top-left-radius",
		"border-top-right-radius",
		"border-bottom-right-radius",
		"border-bottom-left-radius",
	],
	"border-width": ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"],
	"border-color": ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"],
	"border-style": ["border-top-style", "border-right-style", "border-bottom-style", "border-left-style"],
	gap: ["row-gap", "column-gap"],
};

function resetStyles(): void {
	if (selected) {
		for (const [property, { value, priority }] of originalStyles)
			selected.element.style.setProperty(property, value, priority);
	}
	originalStyles.clear();
}

function clear(): void {
	resetStyles();
	selected = undefined;
	mode = undefined;
	inspecting = false;
	textAnchor = null;
	start = undefined;
	marker?.remove();
	marker = undefined;
}

function box(rect: DOMRect | { x: number; y: number; width: number; height: number }): void {
	if (!marker) {
		marker = document.createElement("div");
		Object.assign(marker.style, {
			position: "fixed",
			pointerEvents: "none",
			zIndex: "2147483647",
			border: "2px solid #1688ff",
			background: "#1688ff22",
			boxSizing: "border-box",
		});
		document.documentElement.append(marker);
	}
	Object.assign(marker.style, {
		left: `${rect.x}px`,
		top: `${rect.y}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`,
	});
}

function selector(element: Element): string {
	const parts: string[] = [];
	for (let current: Element | null = element; current && parts.length < 8; current = current.parentElement) {
		let part = current.localName;
		if (current.id) {
			parts.unshift(`#${CSS.escape(current.id)}`);
			break;
		}
		const siblings = current.parentElement
			? [...current.parentElement.children].filter((child) => child.localName === current?.localName)
			: [];
		if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
		parts.unshift(part);
	}
	return parts.join(" > ");
}

function finish(rect: { x: number; y: number; width: number; height: number }, element?: Element, text?: string): void {
	box(rect);
	if (mode === "element" && (element instanceof HTMLElement || element instanceof SVGElement))
		selected = { element, id: ++selectionId, url: location.href };
	const style = selected && getComputedStyle(selected.element);
	const parent = selected?.element.parentElement;
	ipcRenderer.sendToHost("hasilan:browser-selection", {
		kind: mode,
		url: location.href,
		title: document.title.slice(0, 500),
		viewport: { width: innerWidth, height: innerHeight },
		rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
		selector: element ? selector(element) : undefined,
		label: element
			? (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 500)
			: undefined,
		text: text?.slice(0, 4000),
		adjustmentId: selected?.id,
		styles:
			style &&
			Object.fromEntries(
				BROWSER_ADJUSTMENT_PROPERTIES.map((key) => [key, style.getPropertyValue(key).slice(0, 80)]),
			),
		tag: selected?.element.localName,
		parentLayout: parent && getComputedStyle(parent).display,
		children: selected?.element.childElementCount,
	});
	mode = undefined;
	inspecting = false;
}

ipcRenderer.on("hasilan:browser-select", (_event, value: unknown) => {
	clear();
	if (value === "inspect") {
		inspecting = true;
		mode = "element";
	}
	if (value === "element" || value === "text" || value === "region") mode = value;
});
ipcRenderer.on("hasilan:browser-clear", clear);
ipcRenderer.on("hasilan:browser-adjustment", (_event, id: unknown, input: unknown) => {
	if (!selected || selected.id !== id || selected.url !== location.href || !selected.element.isConnected) {
		if (selected?.id !== id) return;
		clear();
		ipcRenderer.sendToHost("hasilan:browser-adjustment-stale");
		return;
	}
	if (input === null) resetStyles();
	else {
		const declarations = browserPreviewStyles(input);
		if (!declarations) return;
		const style = selected.element.style;
		for (const property of Object.keys(declarations)) {
			for (const part of shorthandParts[property] ?? [property]) {
				if (!originalStyles.has(part))
					originalStyles.set(part, {
						value: style.getPropertyValue(part),
						priority: style.getPropertyPriority(part),
					});
			}
		}
		for (const [property, value] of Object.entries(declarations)) style.setProperty(property, value, "important");
	}
	box(selected.element.getBoundingClientRect());
});
let edited = false;
window.addEventListener(
	"input",
	(event) => {
		if (event.isTrusted) edited = true;
	},
	true,
);
ipcRenderer.on("hasilan:browser-suspend", async () => {
	if (edited || mode || document.querySelector("iframe, frame, audio, video, [contenteditable]")) return;
	try {
		const url = location.href;
		const encoded: string | undefined = await ipcRenderer.invoke("hasilan:browser-history-snapshot");
		if (encoded && url === location.href && !edited && !mode)
			ipcRenderer.sendToHost("hasilan:browser-snapshot", encoded, url, scrollX, scrollY);
	} catch {
		/* Leave the live page in place if the snapshot is unavailable. */
	}
});
window.addEventListener(
	"keydown",
	(event) => {
		if (event.isTrusted && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
			event.preventDefault();
			event.stopImmediatePropagation();
			ipcRenderer.sendToHost("hasilan:browser-focus-address");
		}
		if (event.isTrusted && mode && event.key === "Escape") {
			clear();
			ipcRenderer.sendToHost("hasilan:browser-cancel");
		}
	},
	true,
);
window.addEventListener(
	"pointermove",
	(event) => {
		if (!event.isTrusted) return;
		if (mode === "element") {
			const target = document.elementFromPoint(event.clientX, event.clientY);
			if (target) box(target.getBoundingClientRect());
		} else if (mode === "text" && textAnchor) {
			const end = document.caretRangeFromPoint(event.clientX, event.clientY);
			if (end)
				window
					.getSelection()
					?.setBaseAndExtent(
						textAnchor.startContainer,
						textAnchor.startOffset,
						end.startContainer,
						end.startOffset,
					);
		} else if (mode === "region" && start)
			box({
				x: Math.min(start.x, event.clientX),
				y: Math.min(start.y, event.clientY),
				width: Math.abs(start.x - event.clientX),
				height: Math.abs(start.y - event.clientY),
			});
	},
	true,
);
window.addEventListener(
	"pointerdown",
	(event) => {
		if (!event.isTrusted) return;
		if (inspecting && event.button === 0) {
			mode = event.shiftKey ? "text" : "region";
			if (mode === "text") {
				textAnchor = document.caretRangeFromPoint(event.clientX, event.clientY);
				window.getSelection()?.removeAllRanges();
				suppressClick = true;
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		}
		if ((mode === "region" || mode === "element") && event.button === 0) {
			suppressClick = true;
			if (mode === "region") start = { x: event.clientX, y: event.clientY };
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	},
	true,
);
window.addEventListener(
	"pointerup",
	(event) => {
		if (!event.isTrusted || !mode || event.button !== 0) return;
		if (mode === "element") {
			event.preventDefault();
			event.stopImmediatePropagation();
			const target = document.elementFromPoint(event.clientX, event.clientY);
			if (target) finish(target.getBoundingClientRect(), target);
		} else if (mode === "region" && start) {
			event.preventDefault();
			event.stopImmediatePropagation();
			const rect = {
				x: Math.min(start.x, event.clientX),
				y: Math.min(start.y, event.clientY),
				width: Math.abs(start.x - event.clientX),
				height: Math.abs(start.y - event.clientY),
			};
			if (rect.width >= 4 && rect.height >= 4) finish(rect);
			else if (inspecting) {
				const target = document.elementFromPoint(event.clientX, event.clientY);
				if (target) {
					mode = "element";
					finish(target.getBoundingClientRect(), target);
				} else {
					clear();
					ipcRenderer.sendToHost("hasilan:browser-cancel");
				}
			} else {
				clear();
				ipcRenderer.sendToHost("hasilan:browser-cancel");
			}
		} else if (mode === "text") {
			textAnchor = null;
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || !selection.rangeCount) {
				if (inspecting) mode = "element";
				return;
			}
			const range = selection.getRangeAt(0);
			const node = range.commonAncestorContainer;
			finish(
				range.getBoundingClientRect(),
				node instanceof Element ? node : (node.parentElement ?? undefined),
				selection.toString(),
			);
		}
	},
	true,
);
window.addEventListener(
	"click",
	(event) => {
		if (suppressClick) {
			suppressClick = false;
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	},
	true,
);
