import { ipcRenderer } from "electron";
import { browserPreviewStyles } from "../../../packages/web-harness/src/shared/browser-adjustments.ts";

type Mode = "element" | "text" | "region";
type MarkerRect = { x: number; y: number; width: number; height: number };
let mode: Mode | undefined;
let start: { x: number; y: number } | undefined;
let marker: HTMLDivElement | undefined;
let markerBounds: (() => MarkerRect | undefined) | undefined;
let markerFrame: number | undefined;
let suppressClick = false;
let inspecting = false;
let textAnchor: Range | null = null;
let selected:
	| { element: HTMLElement | SVGElement; id: number; url: string; originalStyle: string | null; previewing: boolean }
	| undefined;
let selectionId = 0;
function resetStyles(): void {
	if (!selected?.previewing) return;
	const { element, originalStyle } = selected;
	if (originalStyle === null) element.removeAttribute("style");
	else element.setAttribute("style", originalStyle);
	selected.previewing = false;
}

function clear(): void {
	resetStyles();
	selected = undefined;
	mode = undefined;
	inspecting = false;
	textAnchor = null;
	start = undefined;
	markerBounds = undefined;
	if (markerFrame !== undefined) cancelAnimationFrame(markerFrame);
	markerFrame = undefined;
	marker?.remove();
	marker = undefined;
}

function box(rect: MarkerRect): void {
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
	marker.hidden = false;
	Object.assign(marker.style, {
		left: `${rect.x}px`,
		top: `${rect.y}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`,
	});
}

function scheduleMarkerUpdate(): void {
	if (!markerBounds || markerFrame !== undefined) return;
	markerFrame = requestAnimationFrame(() => {
		markerFrame = undefined;
		const rect = markerBounds?.();
		if (rect) box(rect);
		else if (marker) marker.hidden = true;
	});
}

// Scroll events from nested containers do not bubble.
window.addEventListener("scroll", scheduleMarkerUpdate, { capture: true, passive: true });
window.addEventListener("resize", scheduleMarkerUpdate);

function regionBounds(rect: MarkerRect): () => MarkerRect {
	const pageX = scrollX;
	const pageY = scrollY;
	const ancestors: { element: Element; x: number; y: number }[] = [];
	let element = start && document.elementFromPoint(start.x, start.y);
	while (element) {
		if (element !== document.scrollingElement)
			ancestors.push({ element, x: element.scrollLeft, y: element.scrollTop });
		element = element.parentElement;
	}
	return () => {
		let x = rect.x + pageX - scrollX;
		let y = rect.y + pageY - scrollY;
		for (const anchor of ancestors) {
			x += anchor.x - anchor.element.scrollLeft;
			y += anchor.y - anchor.element.scrollTop;
		}
		return { ...rect, x, y };
	};
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

function finish(rect: MarkerRect, element?: Element, range?: Range, text?: string): void {
	if (range)
		markerBounds = () =>
			range.startContainer.isConnected && !range.collapsed ? range.getBoundingClientRect() : undefined;
	else if (element)
		markerBounds = () =>
			element.isConnected && element.getClientRects().length ? element.getBoundingClientRect() : undefined;
	else markerBounds = regionBounds(rect);
	box(rect);
	if (mode === "element" && (element instanceof HTMLElement || element instanceof SVGElement))
		selected = { element, id: ++selectionId, url: location.href, originalStyle: null, previewing: false };
	const style = selected && getComputedStyle(selected.element);
	const inline = selected?.element.style;
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
		styles: style && Object.fromEntries(Array.from(style, (key) => [key, style.getPropertyValue(key)])),
		inlineStyles: inline && Object.fromEntries(Array.from(inline, (key) => [key, inline.getPropertyValue(key)])),
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
	const declarations = browserPreviewStyles(input);
	if (
		!declarations ||
		Object.entries(declarations).some(([property, value]) => value !== null && !CSS.supports(property, value))
	)
		return;
	resetStyles();
	if (Object.keys(declarations).length) {
		const { element } = selected;
		selected.originalStyle = element.getAttribute("style");
		selected.previewing = true;
		for (const [property, value] of Object.entries(declarations)) {
			if (value === null) element.style.removeProperty(property);
			else element.style.setProperty(property, value, "important");
		}
	}
	scheduleMarkerUpdate();
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
				range.cloneRange(),
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
