import { Check } from "typebox/value";
import type { TerminalSummary } from "../shared/terminal-protocol.ts";
import { type SavedDetailTabs, savedDetailTabsSchema } from "../shared/ui-preferences.ts";
import { type DetailTab, type DetailTabs, detailTabsReducer } from "./detail-tabs.ts";

export function saveDetailTabs(layout: DetailTabs): string {
	const saved: SavedDetailTabs = {
		...layout,
		selected: layout.selected.map((id) =>
			layout.tabs.find((tab) => tab.id === id)?.kind === "browser" ? null : (id ?? null),
		),
		tabs: layout.tabs
			.filter((tab) => tab.kind !== "browser")
			.map((tab) =>
				tab.kind === "terminal"
					? { id: tab.id, pane: tab.pane, kind: tab.kind, terminalId: tab.summary.terminalId, number: tab.number }
					: tab.kind === "file"
						? { id: tab.id, pane: tab.pane, kind: tab.kind, file: tab.file }
						: tab,
			),
	};
	return JSON.stringify(saved);
}

export function restoreDetailTabs(raw: string | null, terminals: TerminalSummary[]): DetailTabs {
	const initial: DetailTabs = {
		tabs: [{ id: "initial-files", kind: "file", pane: 0 }],
		selected: ["initial-files", undefined],
		focused: 0,
		mode: "single",
	};
	let parsed: unknown;
	try {
		parsed = raw === null ? null : JSON.parse(raw);
	} catch {
		parsed = null;
	}
	let layout = initial;
	if (Check(savedDetailTabsSchema, parsed) && new Set(parsed.tabs.map((tab) => tab.id)).size === parsed.tabs.length) {
		const tabs: DetailTab[] = parsed.tabs.flatMap((tab): DetailTab[] => {
			if (tab.kind !== "terminal") return [tab];
			const summary = terminals.find((item) => item.terminalId === tab.terminalId);
			return summary ? [{ id: tab.id, pane: tab.pane, kind: "terminal", number: tab.number, summary }] : [];
		});
		if (!tabs.length && parsed.tabs.length) tabs.push(initial.tabs[0]);
		const missingPane = !tabs.some((tab) => tab.pane === 0) || !tabs.some((tab) => tab.pane === 1);
		const mode = tabs.length !== parsed.tabs.length && missingPane ? "single" : parsed.mode;
		if (mode === "single") for (const tab of tabs) tab.pane = 0;
		layout = {
			tabs,
			mode,
			focused: mode === "single" ? 0 : parsed.focused,
			selected: ([0, 1] as const).map(
				(pane) =>
					tabs.find((tab) => tab.pane === pane && tab.id === parsed.selected[pane])?.id ??
					tabs.find((tab) => tab.pane === pane)?.id,
			) as DetailTabs["selected"],
		};
	}
	let number = Math.max(0, ...layout.tabs.map((tab) => (tab.kind === "terminal" ? tab.number : 0)));
	return detailTabsReducer(layout, {
		type: "restoreTerminals",
		tabs: terminals.map((summary) => ({
			id: `terminal-${summary.terminalId}`,
			pane: 0,
			kind: "terminal",
			summary,
			number: ++number,
		})),
	});
}
