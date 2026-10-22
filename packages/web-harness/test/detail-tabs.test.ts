import { describe, expect, it } from "vitest";
import { type DetailTab, type DetailTabs, detailTabsReducer, emptyDetailTabs } from "../src/client/detail-tabs.ts";

const file: DetailTab = { id: "file", pane: 0, kind: "file", file: { path: "README.md", offset: 201, mode: "source" } };
const terminal: DetailTab = {
	id: "terminal",
	pane: 0,
	kind: "terminal",
	number: 1,
	summary: {
		terminalId: "pty-1",
		workspaceId: "workspace",
		generation: "generation",
		cols: 80,
		rows: 24,
		status: "running",
	},
};
const state: DetailTabs = { ...emptyDetailTabs, tabs: [file, terminal], selected: ["file", undefined] };

describe("shared file and terminal tabs", () => {
	it("opens a file in a new tab without losing the terminal or duplicating existing files", () => {
		const draft: DetailTab = { id: "draft", pane: 0, kind: "new" };
		const withDraft = detailTabsReducer(state, { type: "add", tab: draft });
		const opened = detailTabsReducer(withDraft, {
			type: "openFile",
			path: "notes.md",
			id: "unused",
			requestId: "request",
		});
		expect(opened.tabs.find((tab) => tab.id === "draft")).toMatchObject({ kind: "file", file: { path: "notes.md" } });
		expect(opened.tabs.find((tab) => tab.kind === "terminal")).toBe(terminal);
		const existing = detailTabsReducer(opened, {
			type: "openFile",
			path: "README.md",
			line: 45,
			id: "duplicate",
			requestId: "line-link",
		});
		expect(existing.tabs).toHaveLength(3);
		expect(existing.tabs[0]).toMatchObject({ file: { offset: 25, line: 45, mode: "source" } });
		expect(existing.selected[0]).toBe("file");
	});

	it("reorders mixed tabs without selecting them or replacing the terminal summary", () => {
		const next = detailTabsReducer(state, { type: "move", id: "terminal", pane: 0, before: "file" });
		expect(next.tabs.map((tab) => tab.id)).toEqual(["terminal", "file"]);
		expect(next.selected).toEqual(state.selected);
		expect(next.tabs[0]).toMatchObject({ summary: terminal.summary });
		const reopened = detailTabsReducer(next, {
			type: "openFile",
			path: "README.md",
			id: "ignored",
			requestId: "refresh",
		});
		expect(reopened.tabs[1]).toMatchObject({ file: { offset: 201, mode: "source" } });
	});

	it("splits files and terminals together and keeps their resource identities on merge", () => {
		const split = detailTabsReducer(state, { type: "edge", id: "terminal", edge: "bottom" });
		expect(split.mode).toBe("rows");
		expect(split.selected).toEqual(["file", "terminal"]);
		expect(split.tabs).toMatchObject([
			{ pane: 0, file: file.file },
			{ pane: 1, summary: terminal.summary },
		]);
		const merged = detailTabsReducer(split, { type: "split", mode: "single" });
		expect(merged.tabs.every((tab) => tab.pane === 0)).toBe(true);
		expect(merged.selected).toEqual(["terminal", undefined]);
		expect(merged.tabs[1]).toMatchObject({ summary: terminal.summary });
	});

	it("merges a pane when its last tab moves or closes, preserving the other resource", () => {
		const split = detailTabsReducer(state, { type: "split", mode: "columns" });
		const moved = detailTabsReducer(split, { type: "move", id: "file", pane: 0 });
		expect(moved.mode).toBe("single");
		expect(moved.tabs).toHaveLength(2);
		expect(moved.tabs.find((tab) => tab.kind === "terminal")).toMatchObject({ summary: terminal.summary });
		const closed = detailTabsReducer(split, { type: "remove", id: "file" });
		expect(closed.mode).toBe("single");
		expect(closed.selected).toEqual(["terminal", undefined]);
	});

	it("reconciles terminal creation racing the initial list without duplicating its PTY", () => {
		const placeholder: DetailTab = { id: "placeholder", pane: 0, kind: "new" };
		const pending = detailTabsReducer(emptyDetailTabs, { type: "add", tab: placeholder });
		const restored = detailTabsReducer(pending, { type: "restoreTerminals", tabs: [terminal] });
		const created = detailTabsReducer(restored, { type: "replace", tab: { ...terminal, id: "placeholder" } });
		expect(created.tabs).toHaveLength(1);
		expect(created.tabs[0]).toMatchObject({ id: "placeholder", summary: terminal.summary });
		expect(detailTabsReducer(created, { type: "restoreTerminals", tabs: [terminal] }).tabs).toHaveLength(1);
	});

	it("keeps an explicitly opened empty pane when the terminal list finishes loading", () => {
		const split = detailTabsReducer(
			{ ...emptyDetailTabs, tabs: [file], selected: [file.id, undefined] },
			{ type: "split", mode: "columns" },
		);
		expect(detailTabsReducer(split, { type: "restoreTerminals", tabs: [] }).mode).toBe("columns");
	});
});
