import type { TerminalSummary } from "../shared/terminal-protocol.ts";
import type { FileTab } from "./files/FilePreview.tsx";
import type { PaneIndex, SplitEdge, SplitMode } from "./SplitLayout.tsx";

export type DetailTab = { id: string; pane: PaneIndex } & (
	| { kind: "new" }
	| { kind: "file"; file?: FileTab; requestId?: string }
	| { kind: "terminal"; summary: TerminalSummary; number: number }
);
export interface DetailTabs {
	tabs: DetailTab[];
	selected: [string | undefined, string | undefined];
	focused: PaneIndex;
	mode: SplitMode;
}
export const emptyDetailTabs: DetailTabs = { tabs: [], selected: [undefined, undefined], focused: 0, mode: "single" };

export type DetailTabsAction =
	| { type: "add"; tab: DetailTab }
	| { type: "select"; id: string }
	| { type: "focus"; pane: PaneIndex }
	| { type: "remove"; id: string }
	| { type: "replace"; tab: DetailTab }
	| { type: "openFile"; path: string; line?: number; requestId: string; id: string }
	| { type: "patchFile"; id: string; patch: Partial<FileTab> }
	| { type: "terminalStatus"; id: string; status: TerminalSummary["status"]; exitCode?: number; signal?: number }
	| { type: "restoreTerminals"; tabs: DetailTab[] }
	| { type: "move"; id: string; pane: PaneIndex; before?: string; after?: boolean }
	| { type: "split"; mode: SplitMode }
	| { type: "edge"; id: string; edge: SplitEdge };

function selectTab(state: DetailTabs, tab: DetailTab): DetailTabs {
	const selected: DetailTabs["selected"] = [...state.selected];
	selected[tab.pane] = tab.id;
	return { ...state, selected, focused: tab.pane };
}

/** Closing or moving a pane's final tab merges the remaining panes. */
function reconcileTabs(state: DetailTabs): DetailTabs {
	if (state.mode !== "single" && ([0, 1] as const).some((pane) => !state.tabs.some((tab) => tab.pane === pane))) {
		const active = state.selected[state.focused];
		return {
			...state,
			tabs: state.tabs.map((tab) => ({ ...tab, pane: 0 })),
			selected: [state.tabs.find((tab) => tab.id === active)?.id ?? state.tabs[0]?.id, undefined],
			mode: "single",
			focused: 0,
		};
	}
	return {
		...state,
		selected: state.selected.map(
			(id, pane) =>
				state.tabs.find((tab) => tab.pane === pane && tab.id === id)?.id ??
				state.tabs.find((tab) => tab.pane === pane)?.id,
		) as DetailTabs["selected"],
	};
}

export function detailTabsReducer(state: DetailTabs, action: DetailTabsAction): DetailTabs {
	switch (action.type) {
		case "add":
			return selectTab({ ...state, tabs: [...state.tabs, action.tab] }, action.tab);
		case "select": {
			const tab = state.tabs.find((tab) => tab.id === action.id);
			return tab ? selectTab(state, tab) : state;
		}
		case "focus":
			return state.focused === action.pane ? state : { ...state, focused: action.pane };
		case "remove": {
			const removed = state.tabs.find((tab) => tab.id === action.id);
			if (!removed) return state;
			const tabs = state.tabs.filter((tab) => tab.id !== action.id);
			const siblings = state.tabs.filter((tab) => tab.pane === removed.pane);
			const remaining = tabs.filter((tab) => tab.pane === removed.pane);
			const selected: DetailTabs["selected"] = [...state.selected];
			if (selected[removed.pane] === removed.id)
				selected[removed.pane] = remaining[Math.min(siblings.indexOf(removed), remaining.length - 1)]?.id;
			return reconcileTabs({ ...state, tabs, selected });
		}
		case "replace": {
			const tabs = state.tabs
				.filter(
					(tab) =>
						!(
							action.tab.kind === "terminal" &&
							tab.kind === "terminal" &&
							tab.id !== action.tab.id &&
							tab.summary.terminalId === action.tab.summary.terminalId
						),
				)
				.map((tab) => (tab.id === action.tab.id ? action.tab : tab));
			return selectTab({ ...state, tabs }, action.tab);
		}
		case "openFile": {
			const existing = state.tabs.find((tab) => tab.kind === "file" && tab.file?.path === action.path);
			const placeholder = state.tabs.find(
				(tab) =>
					tab.id === state.selected[state.focused] && (tab.kind === "new" || (tab.kind === "file" && !tab.file)),
			);
			const old = existing?.kind === "file" ? existing.file : undefined;
			const tab: DetailTab = {
				id: existing?.id ?? placeholder?.id ?? action.id,
				pane: existing?.pane ?? state.focused,
				kind: "file",
				requestId: action.requestId,
				file: {
					path: action.path,
					line: action.line,
					offset: action.line === undefined ? (old?.offset ?? 1) : Math.max(1, action.line - 20),
					mode: action.line === undefined ? old?.mode : "source",
				},
			};
			return selectTab(
				{
					...state,
					tabs:
						existing || placeholder
							? state.tabs.map((entry) => (entry.id === tab.id ? tab : entry))
							: [...state.tabs, tab],
				},
				tab,
			);
		}
		case "patchFile":
			return {
				...state,
				tabs: state.tabs.map((tab) =>
					tab.id === action.id && tab.kind === "file" && tab.file
						? { ...tab, file: { ...tab.file, ...action.patch } }
						: tab,
				),
			};
		case "terminalStatus":
			return {
				...state,
				tabs: state.tabs.map((tab) =>
					tab.kind === "terminal" && tab.summary.terminalId === action.id
						? {
								...tab,
								summary: {
									...tab.summary,
									status: action.status,
									exitCode: action.exitCode,
									signal: action.signal,
								},
							}
						: tab,
				),
			};
		case "restoreTerminals": {
			const additions = action.tabs.filter(
				(tab) =>
					tab.kind === "terminal" &&
					!state.tabs.some(
						(entry) => entry.kind === "terminal" && entry.summary.terminalId === tab.summary.terminalId,
					),
			);
			if (!additions.length) return state;
			const tabs = [...state.tabs, ...additions];
			return {
				...state,
				tabs,
				selected: state.selected.map(
					(id, pane) => id ?? tabs.find((tab) => tab.pane === pane)?.id,
				) as DetailTabs["selected"],
			};
		}
		case "move": {
			const tab = state.tabs.find((tab) => tab.id === action.id);
			if (!tab) return state;
			const moved = { ...tab, pane: action.pane };
			const tabs = state.tabs.filter((tab) => tab.id !== action.id);
			const position = action.before ? tabs.findIndex((tab) => tab.id === action.before) : -1;
			tabs.splice(position < 0 ? tabs.length : position + (action.after ? 1 : 0), 0, moved);
			// A reorder must preserve the selected tab and terminal focus.
			return tab.pane === action.pane ? { ...state, tabs } : reconcileTabs(selectTab({ ...state, tabs }, moved));
		}
		case "split": {
			if (action.mode === "single")
				return {
					...state,
					mode: "single",
					tabs: state.tabs.map((tab) => ({ ...tab, pane: 0 })),
					selected: [state.selected[state.focused] ?? state.selected[0], undefined],
					focused: 0,
				};
			if (state.mode !== "single" || state.tabs.length < 2) return { ...state, mode: action.mode };
			const active = state.selected[0];
			return {
				...state,
				mode: action.mode,
				tabs: state.tabs.map((tab) => ({ ...tab, pane: tab.id === active ? 1 : 0 })),
				selected: [state.tabs.find((tab) => tab.id !== active)?.id, active],
				focused: 1,
			};
		}
		case "edge": {
			if (state.tabs.length < 2 || !state.tabs.some((tab) => tab.id === action.id)) return state;
			const pane: PaneIndex = action.edge === "left" || action.edge === "top" ? 0 : 1;
			const other = state.selected[pane === 0 ? 1 : 0];
			const remaining =
				state.tabs.find((tab) => tab.id === other && tab.id !== action.id)?.id ??
				state.tabs.find((tab) => tab.id !== action.id)?.id;
			return {
				...state,
				mode: action.edge === "left" || action.edge === "right" ? "columns" : "rows",
				tabs: state.tabs.map((tab) => ({ ...tab, pane: tab.id === action.id ? pane : pane === 0 ? 1 : 0 })),
				selected: pane === 0 ? [action.id, remaining] : [remaining, action.id],
				focused: pane,
			};
		}
	}
}
