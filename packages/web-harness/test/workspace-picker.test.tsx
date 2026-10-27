import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { matchesAppKeybinding } from "../src/client/app-keybindings.ts";
import { CommandPicker } from "../src/client/CommandPicker.tsx";
import { COMPOSER_COMMANDS } from "../src/client/slash-command.ts";

afterEach(() => { vi.unstubAllGlobals(); });

it("keeps routing and ordinary send distinct on Windows and macOS, with configurable overrides", () => {
	const event = { key: "Enter", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
	expect(matchesAppKeybinding(event, "composer.routeWorkspace")).toBe(true);
	expect(matchesAppKeybinding(event, "composer.send")).toBe(false);
	expect(matchesAppKeybinding({ ...event, ctrlKey: false, metaKey: true }, "composer.routeWorkspace")).toBe(true);
	expect(matchesAppKeybinding({ ...event, shiftKey: false }, "composer.send")).toBe(true);
	expect(matchesAppKeybinding({ ...event, altKey: true }, "composer.routeWorkspace")).toBe(false);
	vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ "composer.routeWorkspace": ["alt+r"] }) });
	expect(matchesAppKeybinding(event, "composer.routeWorkspace")).toBe(false);
	expect(matchesAppKeybinding({ ...event, key: "r", ctrlKey: false, altKey: true, shiftKey: false }, "composer.routeWorkspace")).toBe(true);
	vi.stubGlobal("localStorage", { getItem: () => "invalid-json" });
	expect(matchesAppKeybinding(event, "composer.routeWorkspace")).toBe(true);
});

it("reuses the slash picker for existing and new conversations below the composer", () => {
	const props = { id: "workspaces", activeIndex: 1, onActive: vi.fn(), onChoose: vi.fn() };
	const markup = renderToStaticMarkup(createElement(CommandPicker, {
		...props, below: true, label: "送信先の会話", commands: [
			{ command: "session:music", label: "音楽プレイヤーの音量調節", description: "app · 10/26 09:05 · /projects/music/app" },
			{ command: "new:music", label: "＋ 新しい会話で開始", description: "app · /projects/music/app" },
			{ command: "new:web", label: "＋ 新しい会話で開始", description: "app · /projects/web/app" },
		],
	}));
	expect(markup).toContain('class="command-picker is-below"');
	expect(markup).toContain('aria-label="送信先の会話"');
	expect(markup).toContain('id="workspaces-1" type="button" role="option" aria-selected="true"');
	expect(markup).toContain("/projects/web/app");
	expect(markup).toContain("/projects/music/app");
	expect(markup).toContain("音楽プレイヤーの音量調節");
	expect(markup).toContain("＋ 新しい会話で開始");
	expect(markup).toContain("10/26 09:05");
	const slash = renderToStaticMarkup(createElement(CommandPicker, { ...props, commands: COMPOSER_COMMANDS }));
	expect(slash).toContain('aria-label="スラッシュコマンド"');
	expect(slash).not.toContain("is-below");
	expect(slash).toContain("/hyakki");
});
