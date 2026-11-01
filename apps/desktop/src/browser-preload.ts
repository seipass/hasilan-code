import { ipcRenderer } from "electron";

type Mode = "element" | "text" | "region";
let mode: Mode | undefined;
let start: { x: number; y: number } | undefined;
let marker: HTMLDivElement | undefined;
let suppressClick = false;

function clear(): void {
	mode = undefined;
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
	});
	mode = undefined;
}

ipcRenderer.on("hasilan:browser-select", (_event, value: unknown) => {
	clear();
	if (value === "element" || value === "text" || value === "region") mode = value;
});
ipcRenderer.on("hasilan:browser-clear", clear);
window.addEventListener(
	"keydown",
	(event) => {
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
			else {
				clear();
				ipcRenderer.sendToHost("hasilan:browser-cancel");
			}
		} else if (mode === "text") {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || !selection.rangeCount) return;
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
