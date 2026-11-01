import { expect, test } from "vitest";
import { restoreDetailTabs, saveDetailTabs } from "../src/client/detail-preferences.ts";
import type { DetailTabs } from "../src/client/detail-tabs.ts";
import type { TerminalSummary } from "../src/shared/terminal-protocol.ts";

const terminal: TerminalSummary = {
	terminalId: "pty-1",
	workspaceId: "workspace-1",
	generation: "live",
	cols: 80,
	rows: 24,
	status: "running",
};
const layout: DetailTabs = {
	mode: "rows",
	focused: 1,
	selected: ["file", "terminal"],
	tabs: [
		{ id: "file", kind: "file", pane: 0, file: { path: "README.md", offset: 201, mode: "source" } },
		{ id: "terminal", kind: "terminal", pane: 1, summary: terminal, number: 3 },
	],
};

test("restores file position, tab order, selection and split using live terminal summaries", () => {
	expect(restoreDetailTabs(saveDetailTabs(layout), [{ ...terminal, cols: 100 }])).toEqual({
		...layout,
		tabs: [layout.tabs[0], { ...layout.tabs[1], summary: { ...terminal, cols: 100 } }],
	});
});

test("does not resurrect a PTY after the backend restarts and reconciles the missing pane", () => {
	const restored = restoreDetailTabs(saveDetailTabs(layout), []);
	expect(restored.mode).toBe("single");
	expect(restored.tabs).toEqual([layout.tabs[0]]);
	expect(restored.selected).toEqual(["file", undefined]);
});

test("keeps intentionally empty tabs and panes, and rejects duplicate or invalid tab data", () => {
	const empty: DetailTabs = { tabs: [], selected: [undefined, undefined], focused: 0, mode: "columns" };
	expect(restoreDetailTabs(saveDetailTabs(empty), [])).toEqual(empty);
	expect(restoreDetailTabs("{}", []).tabs).toMatchObject([{ kind: "file" }]);
	const duplicate = saveDetailTabs({ ...layout, tabs: [layout.tabs[0], layout.tabs[0]] });
	expect(restoreDetailTabs(duplicate, []).tabs).toHaveLength(1);
});
