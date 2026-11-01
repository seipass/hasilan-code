import { ipcRenderer, webFrame } from "electron";
import chromeStyles from "../assets/chrome.css";
import closeIcon from "../assets/codicons/chrome-close.svg";
import maximizeIcon from "../assets/codicons/chrome-maximize.svg";
import minimizeIcon from "../assets/codicons/chrome-minimize.svg";
import restoreIcon from "../assets/codicons/chrome-restore.svg";
import type { DesktopWindowState } from "./protocol.ts";

// Window controls follow VS Code's NativeTitlebarPart custom-controls implementation.
// IPC stays in the isolated preload; no Electron API is exposed to page JavaScript.
if (process.isMainFrame) {
	webFrame.insertCSS(chromeStyles);
	window.addEventListener("DOMContentLoaded", () => {
		const root = document.documentElement;
		root.dataset.desktopPlatform = process.platform;
		let linkMenu: HTMLDivElement | undefined;
		const closeLinkMenu = () => {
			linkMenu?.remove();
			linkMenu = undefined;
		};
		document.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Escape") closeLinkMenu();
			},
			true,
		);
		const showLinkMenu = (url: URL, left: number, bottom: number, parent: Element) => {
			closeLinkMenu();
			const menu = document.createElement("div");
			menu.className = "desktop-link-menu";
			menu.setAttribute("role", "group");
			menu.setAttribute("aria-label", "リンクの開き方");
			menu.style.left = `${Math.max(8, Math.min(left, innerWidth - 260))}px`;
			menu.style.top = `${Math.min(bottom + 5, innerHeight - 55)}px`;
			const addLinkChoice = (label: string, action: () => void, disabled = false) => {
				const button = document.createElement("button");
				button.type = "button";
				button.textContent = label;
				button.disabled = disabled;
				button.addEventListener("click", () => {
					closeLinkMenu();
					action();
				});
				menu.append(button);
			};
			addLinkChoice(
				"内蔵ブラウザ",
				() => window.postMessage({ type: "hasilan:open-browser", url: url.href }, location.origin),
				url.protocol === "mailto:",
			);
			addLinkChoice("システムブラウザ", () => ipcRenderer.send("hasilan:open-external", url.href));
			parent.append(menu);
			linkMenu = menu;
			menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
		};
		document.addEventListener(
			"click",
			(event) => {
				if (!event.isTrusted || event.button !== 0 || event.defaultPrevented) return;
				if (linkMenu?.contains(event.target as Node)) return;
				closeLinkMenu();
				const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
				if (!(target instanceof HTMLAnchorElement) || target.hasAttribute("download")) return;
				let url: URL;
				try {
					url = new URL(target.href);
				} catch {
					return;
				}
				if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.origin === location.origin) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				const bounds = target.getBoundingClientRect();
				showLinkMenu(url, bounds.left, bounds.bottom, target.closest("dialog[open]") ?? document.body);
			},
			true,
		);
		window.addEventListener("message", (event: MessageEvent<unknown>) => {
			if (
				event.source !== window ||
				event.origin !== location.origin ||
				!event.data ||
				typeof event.data !== "object" ||
				!("type" in event.data) ||
				event.data.type !== "hasilan:choose-link" ||
				!("url" in event.data) ||
				typeof event.data.url !== "string" ||
				!("x" in event.data) ||
				typeof event.data.x !== "number" ||
				!("y" in event.data) ||
				typeof event.data.y !== "number" ||
				!Number.isFinite(event.data.x) ||
				!Number.isFinite(event.data.y)
			)
				return;
			try {
				const url = new URL(event.data.url);
				if (["http:", "https:"].includes(url.protocol))
					showLinkMenu(url, event.data.x, event.data.y, document.body);
			} catch {
				/* Ignore invalid links. */
			}
		});
		const titlebar = document.createElement("header");
		titlebar.className = "desktop-titlebar";
		titlebar.setAttribute("aria-label", "タイトルバー");
		const appIcon = document.createElement("img");
		appIcon.className = "desktop-titlebar-icon";
		appIcon.src = "/icon.svg";
		appIcon.alt = "";
		appIcon.draggable = false;
		titlebar.append(appIcon);
		const controls = document.createElement("div");
		controls.className = "desktop-window-controls";
		controls.setAttribute("role", "group");
		controls.setAttribute("aria-label", "ウィンドウ操作");
		const addButton = (action: string, label: string, icon: string) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = `window-icon window-${action}`;
			button.setAttribute("aria-label", label);
			button.title = label;
			button.innerHTML = icon;
			button.firstElementChild?.setAttribute("aria-hidden", "true");
			button.addEventListener("click", () => ipcRenderer.send("hasilan:window-action", action));
			controls.append(button);
			return button;
		};
		addButton("minimize", "最小化", minimizeIcon);
		const maximize = addButton("toggle-maximize", "最大化", maximizeIcon);
		addButton("close", "ウィンドウを閉じる", closeIcon);
		if (process.platform !== "darwin") titlebar.append(controls);
		document.body.append(titlebar);
		let fullscreen = false;
		const updateGeometry = (nextFullscreen = fullscreen) => {
			fullscreen = nextFullscreen;
			const zoom = webFrame.getZoomFactor();
			root.style.setProperty("--desktop-zoom", String(zoom));
			root.style.setProperty("--desktop-titlebar-height", `${fullscreen ? 0 : 35 / zoom}px`);
		};
		const applyState = (state: DesktopWindowState) => {
			titlebar.hidden = state.fullscreen;
			controls.dataset.focused = String(state.focused);
			controls.dataset.maximized = String(state.maximized);
			maximize.setAttribute("aria-label", state.maximized ? "元のサイズに戻す" : "最大化");
			maximize.title = state.maximized ? "元のサイズに戻す" : "最大化";
			maximize.innerHTML = state.maximized ? restoreIcon : maximizeIcon;
			maximize.firstElementChild?.setAttribute("aria-hidden", "true");
			updateGeometry(state.fullscreen);
		};
		ipcRenderer.on("hasilan:window-state", (_event, state: DesktopWindowState) => applyState(state));
		void ipcRenderer
			.invoke("hasilan:window-state")
			.then(applyState)
			.catch(() => undefined);
		window.addEventListener("resize", () => updateGeometry());
		updateGeometry();
	});
}
