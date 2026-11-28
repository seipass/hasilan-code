import type { ThinkingLevel } from "@hasilan-code/pi-agent-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentUpload } from "../shared/attachments.ts";
import type { Goal, GoalAction } from "../shared/goals.ts";
import { GIT_REVIEW_ID, SESSION_IMPORT_ID, SESSION_SEARCH_ID, TERMINAL_ID, WORKSPACE_FILES_ID } from "../shared/plugin-profile.ts";
import type { WorkspaceGitSummary } from "../shared/pr-lifecycle.ts";
import type { SurfaceAction } from "../shared/surfaces.ts";
import type { ComposerDestination, ComposerSendResult } from "../shared/workspace-routing.ts";
import { api, command, errorMessage } from "./api.ts";
import { useAttention } from "./attention.ts";
import { Icon } from "./Icon.tsx";
import { userText } from "./MessageActions.tsx";
import { ChatPane } from "./ChatPane.tsx";
import { ChatStatusBar } from "./ChatStatusBar.tsx";
import { DetailPane, type DetailView } from "./DetailPane.tsx";
import type { FileTarget } from "./files/FilePane.tsx";
import { HomeBackdrop, useHomeBackground } from "./HomeAppearance.tsx";
import { HomeDashboard } from "./HomeDashboard.tsx";
import { nextClientId } from "./ids.ts";
import { ModelMenu } from "./ModelMenu.tsx";
import { MotionItems, Presence } from "./Motion.tsx";
import { MotionSwap } from "./MotionSwap.tsx";
import { MultiSessionTray } from "./MultiSessionTray.tsx";
import { PanelResize } from "./PanelResize.tsx";
import { preferences, usePreferenceState } from "./preferences.ts";
import { PreferenceStatus } from "./PreferenceStatus.tsx";
import { canvasPanel } from "./plugins/canvas.tsx";
import { externalPanel } from "./plugins/external-panel.tsx";
import { GoalControl } from "./plugins/goal.tsx";
import { HyakkiControl } from "./plugins/hyakki.tsx";
import { pluginManagerPanel } from "./plugins/manager.tsx";
import { usePluginProfile } from "./plugins/profile.tsx";
import type { WorkspacePanel } from "./plugins/workspace-panels.ts";
import { SessionActions, type SessionActionTarget } from "./SessionActions.tsx";
import { SessionImportDialog } from "./SessionImportDialog.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { useChannel } from "./subscriptions.ts";
import { COMPOSER_COMMANDS, parseComposerCommand } from "./slash-command.ts";
import { RUN_LABELS, TeamPane } from "./TeamPane.tsx";
import { ToolInspector } from "./ToolInspector.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { WorkOverview } from "./WorkOverview.tsx";
import { workspaceLabel } from "./workspace-label.ts";
import { sendWorkspacePrompt } from "./workspace-send.ts";
import type { Model, ModelCatalog, PendingInputAction, SessionDetail, SessionSummary, Workspace, WorkspaceProjection } from "./types.ts";
import "./WorkspaceModes.css";

const workspacePanels: readonly WorkspacePanel[] = [canvasPanel, pluginManagerPanel];

function sessionFromLocation(): string | undefined {
	if (typeof location === "undefined") return undefined;
	const match = /^\/s\/([0-9a-zA-Z-]{1,128})$/.exec(location.pathname);
	return match?.[1];
}

/** Keeps the address bar in sync so conversations can be reloaded, bookmarked and shared. */
function pushSessionUrl(sessionId: string | undefined): void {
	if (typeof history === "undefined") return;
	const target = sessionId ? `/s/${encodeURIComponent(sessionId)}` : "/";
	if (location.pathname === target) return;
	history.pushState({ sessionId }, "", target);
}

function WorkspaceFeed({ id, onUpdate, onFiles }: { id: string; onUpdate: (id: string, data: WorkspaceProjection) => void; onFiles: () => void }) {
	const channel = useChannel<WorkspaceProjection>("workspace", id, onFiles);
	useEffect(() => { if (channel.data) onUpdate(id, channel.data); }, [id, channel.data, onUpdate]);
	return null;
}

export function App() {
	const { background, changeBackground } = useHomeBackground();
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [mode, setMode] = useState("chat");
	const [dirtyPanels, setDirtyPanels] = useState<readonly string[]>([]);
	const [openedPanels, setOpenedPanels] = useState<readonly string[]>([]);
	const profile = usePluginProfile();
	const filesEnabled = profile?.activeIds.includes(WORKSPACE_FILES_ID) ?? false;
	const terminalEnabled = profile?.activeIds.includes(TERMINAL_ID) ?? false;
	const searchEnabled = profile?.activeIds.includes(SESSION_SEARCH_ID) ?? false;
	const importEnabled = !!profile?.persistentSessions && profile.activeIds.includes(SESSION_IMPORT_ID);
	const gitReviewEnabled = profile?.activeIds.includes(GIT_REVIEW_ID) ?? true;
	const activePanels = useMemo(() => {
		if (!profile) return undefined;
		const external = new Map(profile.panels.filter((entry) => entry.scope !== "application").map((entry) => [entry.id, externalPanel(entry)]));
		const builtins = new Map(workspacePanels.map((panel) => [panel.id, panel]));
		return profile.activeIds.flatMap((id) => {
			const panel = external.get(id) ?? builtins.get(id);
			return panel ? [panel] : [];
		});
	}, [profile]);
	const activePanel = activePanels?.find(({ id }) => id === mode);
	const goalEnabled = profile?.activeIds.includes("goal") ?? false;
	const swarmEnabled = profile?.activeIds.includes("hyakki") ?? false;
	const canvasEnabled = activePanels?.some(({ id }) => id === canvasPanel.id) ?? false;
	const commands = COMPOSER_COMMANDS.filter(({ command }) =>
		(command !== "/canvas" || canvasEnabled) && (command !== "/goal" || goalEnabled) &&
		(command !== "/hyakki" || swarmEnabled));
	const [draftInsertion, setDraftInsertion] = useState<{ id: string; text: string }>();
	const [workspaceId, setWorkspaceId] = useState<string>();
	const [sessionId, setSessionId] = useState<string | undefined>(() => preferences.getItem("pi-web-selected-session") || undefined);
	const [projections, setProjections] = useState<Record<string, WorkspaceProjection>>({});
	const [initialSessions, setInitialSessions] = useState<SessionSummary[]>([]);
	const [error, setError] = useState<string>();
	const [catalog, setCatalog] = useState<ModelCatalog>();
	const [catalogVersion, setCatalogVersion] = useState(0);
	const [draftSelection, setDraftSelection] = usePreferenceState<{ model?: Model; thinkingLevel?: ThinkingLevel }>("pi-web-model-selection", {});
	const draftModel = draftSelection.model;
	const draftThinking = draftSelection.thinkingLevel;
	function setDraftModel(model: Model | undefined) { setDraftSelection((previous) => ({ ...previous, model: model ? { provider: model.provider, id: model.id } : undefined })); }
	function setDraftThinking(thinkingLevel: ThinkingLevel | undefined) { setDraftSelection((previous) => ({ ...previous, thinkingLevel })); }
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [workOpen, setWorkOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [sessionAction, setSessionAction] = useState<SessionActionTarget>();
	const closeSessionAction = useCallback(() => setSessionAction(undefined), []);
	const [modelOpen, setModelOpen] = useState(false);
	const [addingWorkspace, setAddingWorkspace] = useState(false);
	const [sessionOrder, setSessionOrder] = usePreferenceState<Record<string, string[]>>("pi-web-session-order", {});
	const [expandedWorkspaces, setExpandedWorkspaces] = usePreferenceState<Record<string, boolean>>("pi-web-expanded-workspaces", {});
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const narrowViewport = viewport.width <= 900;
	const [desktopSidebarOpen, setDesktopSidebarOpen] = usePreferenceState("pi-web-sidebar-open", () => window.innerWidth >= 900);
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
	const [historyQuery, setHistoryQuery] = useState("");
	const [bodyMatches, setBodyMatches] = useState<{ sessionId: string; snippet: string; role: string }[]>([]);
	const [rightTab, setRightTab] = usePreferenceState<DetailView>("pi-web-right-tab", "tabs");
	const [desktopRightOpen, setDesktopRightOpen] = usePreferenceState("pi-web-right-open", false);
	const [mobileRightOpen, setMobileRightOpen] = useState(false);
	const sidebarOpen = narrowViewport ? mobileSidebarOpen : desktopSidebarOpen;
	const rightOpen = narrowViewport ? mobileRightOpen : desktopRightOpen;
	const setSidebarOpen = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
		if (narrowViewport) {
			setMobileSidebarOpen((previous) => {
				const value = typeof next === "function" ? next(previous) : next;
				if (value) setMobileRightOpen(false);
				return value;
			});
			return;
		}
		setDesktopSidebarOpen(next);
	}, [narrowViewport, setDesktopSidebarOpen]);
	const setRightOpen = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
		if (narrowViewport) {
			setMobileRightOpen((previous) => {
				const value = typeof next === "function" ? next(previous) : next;
				if (value) setMobileSidebarOpen(false);
				return value;
			});
			return;
		}
		setDesktopRightOpen(next);
	}, [narrowViewport, setDesktopRightOpen]);
	const [rightResizing, setRightResizing] = useState(false);
	const [rightSettledClosed, setRightSettledClosed] = useState(() => !rightOpen);
	const [notificationsEnabled, setNotificationsEnabled] = usePreferenceState("pi-web-notifications", false);
	const [homeDashboardEnabled] = usePreferenceState("pi-web-home-dashboard", true);
	const [rightWidth, setRightWidth] = usePreferenceState("pi-web-right-width", 660);
	const [mainWidth, setMainWidth] = useState(0);
	const [fileTarget, setFileTarget] = useState<FileTarget>();
	const [browserTarget, setBrowserTarget] = useState<{ id: string; url: string }>();
	const [teamBoardRequest, setTeamBoardRequest] = useState(0);
	const [filesVersion, setFilesVersion] = useState(0);
	const [gitSummary, setGitSummary] = useState<WorkspaceGitSummary>();
	const draftSession = useRef<string | undefined>(undefined);
	const searchInput = useRef<HTMLInputElement>(null);
	const commandPending = useRef(false);
	const clearDraftInsertion = useCallback(() => setDraftInsertion(undefined), []);
	const sidebarRef = useRef<HTMLElement>(null);
	const sidebarOpener = useRef<HTMLButtonElement>(null);
	const mainLayoutRef = useRef<HTMLDivElement>(null);
	const rightPanelRef = useRef<HTMLElement>(null);
	const rightPanelToggle = useRef<HTMLButtonElement>(null);
	const workspaceChannel = useChannel<WorkspaceProjection>("workspace", workspaceId, () => setFilesVersion((value) => value + 1));
	const sessionChannel = useChannel<SessionDetail>("session", sessionId, undefined, () => newConversation());
	const session = sessionChannel.data;
	const gitSessionId = session?.sessionId;
	const gitSessionAvailability = session?.availability;
	const gitLatestSettledAt = session?.latestRun?.settledAt;
	const gitCurrentRunId = session?.currentRun?.runId;
	useEffect(() => {
		if (mode !== "chat") return;
		const endpoint =
			gitSessionId && gitSessionAvailability === "ready"
				? `/api/sessions/${encodeURIComponent(gitSessionId)}/git-status`
				: workspaceId
					? `/api/workspaces/${encodeURIComponent(workspaceId)}/git-status`
					: undefined;
		if (!endpoint) {
			setGitSummary(undefined);
			return;
		}
		const controller = new AbortController();
		void api<WorkspaceGitSummary>(endpoint, { signal: controller.signal })
			.then((summary) => {
				if (!controller.signal.aborted) setGitSummary(summary);
			})
			.catch(() => {
				if (!controller.signal.aborted) setGitSummary(undefined);
			});
		return () => controller.abort();
	}, [mode, gitSessionId, gitSessionAvailability, gitLatestSettledAt, gitCurrentRunId, workspaceId, filesVersion]);
	const model = session?.model ?? draftModel;
	const catalogModel = catalog?.models.find((entry) => entry.provider === model?.provider && entry.id === model.id);
	const selectedModel = catalogModel ?? model;
	const modelNeedsAuthentication = model
		? catalog?.providers.find((entry) => entry.id === model.provider)?.configured === false
		: !!catalog?.providers.length && catalog.providers.every((entry) => entry.configured === false);
	const modelSetup = modelNeedsAuthentication ? "authentication" : !model ? "selection" : undefined;
	const workspace = workspaces.find((entry) => entry.workspaceId === workspaceId);
	const summaries = [...initialSessions.filter((entry) => !projections[entry.workspaceId]), ...Object.values(projections).flatMap((projection) => projection.sessions)];
	const team = workspaceChannel.data?.teams;
	const selectedAgent = team?.agents.find((agent) => agent.sessionId === sessionId);
	const workspaceTeam = team?.teams.find((entry) => entry.scope === "workspace");
	const runningCount = summaries.filter((entry) => entry.workspaceId === workspaceId && !!entry.currentRun).length;
	const roots = summaries.filter((entry) => !entry.parentSessionId);
	// Sidebar search matches titles and workspace paths without scanning message bodies on each keystroke.
	useEffect(() => {
		const query = historyQuery.trim();
		if (!searchEnabled || query.length < 2) { setBodyMatches([]); return; }
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			void api<{ sessionId: string; snippet: string; role: string }[]>(`/api/sessions/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
				.then((value) => { if (!controller.signal.aborted) setBodyMatches(value); })
				.catch(() => { if (!controller.signal.aborted) setBodyMatches([]); });
		}, 250);
		return () => { window.clearTimeout(timer); controller.abort(); };
	}, [historyQuery, searchEnabled]);
	const bodyMatchIds = new Set(bodyMatches.map((match) => match.sessionId));
	const orderedRoots = [...roots].sort((a, b) => {
		if (a.workspaceId !== b.workspaceId) return a.workspaceId.localeCompare(b.workspaceId);
		const order = sessionOrder[a.workspaceId];
		const customOrder = (order?.indexOf(a.sessionId) ?? -1) - (order?.indexOf(b.sessionId) ?? -1);
		if (customOrder) return customOrder;
		return Number(!!b.currentRun) - Number(!!a.currentRun) || String(b.latestRun?.startedAt ?? "").localeCompare(String(a.latestRun?.startedAt ?? ""));
	});
	const history = orderedRoots.filter((entry) => bodyMatchIds.has(entry.sessionId) || `${entry.title ?? ""} ${workspaces.find((item) => item.workspaceId === entry.workspaceId)?.path ?? ""}`.toLowerCase().includes(historyQuery.toLowerCase()));
	const actionSession = sessionAction?.session;
	const actionOrder = actionSession ? orderedRoots.filter((entry) => entry.workspaceId === actionSession.workspaceId).map((entry) => entry.sessionId) : [];
	const actionIndex = actionOrder.indexOf(actionSession?.sessionId ?? "");
	useAttention({
		sessions: summaries,
		selectedSessionId: sessionId,
		selectedTitle: session?.title,
		notificationsEnabled,
		onSelect: (id) => selectSession(id),
	});
	const updateProjection = useCallback((id: string, data: WorkspaceProjection) => setProjections((previous) => ({ ...previous, [id]: data })), []);
	const filesChanged = useCallback(() => setFilesVersion((value) => value + 1), []);
	useEffect(() => {
		const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useEffect(() => {
		const element = mainLayoutRef.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setMainWidth(element.clientWidth));
		observer.observe(element);
		setMainWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (rightOpen) { setRightSettledClosed(false); return; }
		const timer = window.setTimeout(() => setRightSettledClosed(true), 260);
		return () => window.clearTimeout(timer);
	}, [rightOpen]);
	useEffect(() => {
		const open = (event: MessageEvent<unknown>) => {
			if (!document.documentElement.dataset.desktopPlatform || event.source !== window || event.origin !== location.origin || !event.data || typeof event.data !== "object" || !("type" in event.data) || event.data.type !== "hasilan:open-browser" || !("url" in event.data) || typeof event.data.url !== "string") return;
			try {
				const url = new URL(event.data.url);
				if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
				if (!workspaceId) { setError("内蔵ブラウザを開くにはワークスペースを選択してください。"); return; }
				setBrowserTarget({ id: nextClientId(), url: url.href }); setRightTab("tabs"); setRightOpen(true);
			} catch { /* Invalid links cannot be opened. */ }
		};
		window.addEventListener("message", open);
		return () => window.removeEventListener("message", open);
	}, [workspaceId]);
	useEffect(() => {
		if (!sidebarOpen && sidebarRef.current?.contains(document.activeElement)) sidebarOpener.current?.focus();
	}, [sidebarOpen]);
	useEffect(() => {
		if (!rightOpen && rightPanelRef.current?.contains(document.activeElement)) rightPanelToggle.current?.focus();
	}, [rightOpen]);
	useEffect(() => { if (workspaceId && workspaceChannel.data) updateProjection(workspaceId, workspaceChannel.data); }, [workspaceId, workspaceChannel.data, updateProjection]);
	useEffect(() => {
		const controller = new AbortController();
		Promise.all([api<Workspace[]>("/api/workspaces", { signal: controller.signal }), api<SessionSummary[]>("/api/sessions", { signal: controller.signal })]).then(([folders, sessions]) => {
			setWorkspaces(folders); setInitialSessions(sessions);
			const previousSession = preferences.getItem("pi-web-selected-session"); const previousWorkspace = preferences.getItem("pi-web-workspace");
			// A pasted conversation URL wins over the last browser selection.
			const urlSession = sessionFromLocation();
			const restored = sessions.find((entry) => entry.sessionId === (urlSession ?? previousSession));
			setSessionId(restored?.sessionId);
			setMode("chat");
			setWorkspaceId(restored?.workspaceId ?? folders.find((entry) => entry.workspaceId === previousWorkspace)?.workspaceId ?? folders[0]?.workspaceId);
			setBootstrapped(true);
		}).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(reason)); setBootstrapped(true); } });
		return () => controller.abort();
	}, []);
	useEffect(() => {
		if (!workspaceId) return;
		const controller = new AbortController();
		api<ModelCatalog>("/api/models", { signal: controller.signal }).then(setCatalog).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
		return () => controller.abort();
	}, [catalogVersion, workspaceId]);
	useEffect(() => {
		if (!workspaceId) return;
		if (sessionId) preferences.setItem("pi-web-selected-session", sessionId); else preferences.removeItem("pi-web-selected-session");
		preferences.setItem("pi-web-workspace", workspaceId);
	}, [sessionId, workspaceId]);
	// Only rewrite the address bar after the first restore, otherwise a deep link is replaced
	// by "/" before the session is known.
	const [bootstrapped, setBootstrapped] = useState(false);
	useEffect(() => { if (bootstrapped) pushSessionUrl(sessionId); }, [sessionId, bootstrapped]);
	const sessionForBack = useRef(sessionId);
	sessionForBack.current = sessionId;
	useEffect(() => {
		// Browser back/forward restores the conversation named by the URL instead of leaving the app.
		const restore = () => {
			const id = sessionFromLocation();
			if (!id) { draftSession.current = undefined; setSessionId(undefined); return; }
			// An overlay guard pops an entry with the same URL; keep canvas and scroll state.
			if (id === sessionForBack.current) return;
			const summary = initialSessions.find((entry) => entry.sessionId === id) ?? Object.values(projections).flatMap((projection) => projection.sessions).find((entry) => entry.sessionId === id);
			if (!summary) return;
			setWorkspaceId(summary.workspaceId);
			setSessionId(summary.sessionId);
			setMode("chat");
			setError(undefined);
		};
		window.addEventListener("popstate", restore);
		return () => window.removeEventListener("popstate", restore);
	}, [initialSessions, projections]);
	useEffect(() => {
		const keydown = (event: KeyboardEvent) => {
			if (searchEnabled && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }
			if (filesEnabled && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") { event.preventDefault(); setRightTab("tabs"); setRightOpen(true); window.dispatchEvent(new Event("hasilan:quick-open")); }
			if (event.key !== "Escape") return;
			if (modelOpen) setModelOpen(false);
			// Overlays cover the page below 900px, so Escape is the only pointer-free way out.
			else if (rightOpen && window.innerWidth < 900) setRightOpen(false);
			else if (sidebarOpen && window.innerWidth < 900) setSidebarOpen(false);
		};
		window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
	}, [modelOpen, rightOpen, sidebarOpen, searchEnabled, filesEnabled]);
	// Android's back button must close one overlay instead of leaving the app. While any
	// overlay is open we hold one extra history entry with the same URL; popping it closes
	// the top overlay (settings, a dialog, the model sheet, then the panel and the drawer).
	// The entry is dropped again when the last overlay closes through the UI, so a normal
	// back press still leaves the conversation exactly once.
	const overlayCount = (sessionAction ? 1 : 0) + (importOpen ? 1 : 0) + (settingsOpen ? 1 : 0) + (workOpen ? 1 : 0) + (modelOpen ? 1 : 0) + (narrowViewport && rightOpen ? 1 : 0) + (narrowViewport && sidebarOpen ? 1 : 0);
	const backGuard = useRef(false);
	const overlayOpen = useRef(false);
	overlayOpen.current = overlayCount > 0;
	const closeTopOverlay = useRef<() => boolean>(() => false);
	useEffect(() => {
		closeTopOverlay.current = () => {
			if (sessionAction) { closeSessionAction(); return true; }
			if (importOpen) { setImportOpen(false); return true; }
			if (settingsOpen) { setSettingsOpen(false); return true; }
			if (workOpen) { setWorkOpen(false); return true; }
			if (modelOpen) { setModelOpen(false); return true; }
			if (narrowViewport && rightOpen) { setRightOpen(false); return true; }
			if (narrowViewport && sidebarOpen) { setSidebarOpen(false); return true; }
			return false;
		};
	});
	useEffect(() => {
		const rearm = () => {
			if (backGuard.current) return;
			if (overlayOpen.current || document.querySelector("dialog[open]")) {
				window.history.pushState({ ...window.history.state, piOverlay: true }, "");
				backGuard.current = true;
			}
		};
		const onPop = () => {
			if (!backGuard.current) return;
			backGuard.current = false;
			// A sheet in the top layer sits above the panel or drawer that owns it, so it
			// closes first and the guard stays armed for whatever is still open below.
			const sheet = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].pop();
			if (sheet) {
				sheet.dispatchEvent(new Event("cancel", { cancelable: true }));
				requestAnimationFrame(rearm);
				return;
			}
			closeTopOverlay.current();
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);
	useEffect(() => {
		if (overlayCount > 0 && !backGuard.current) {
			window.history.pushState({ ...window.history.state, piOverlay: true }, "");
			backGuard.current = true;
		} else if (overlayCount === 0 && backGuard.current) {
			backGuard.current = false;
			if (window.history.state?.piOverlay) window.history.back();
		}
	}, [overlayCount]);
	function selectSession(id: string, knownWorkspaceId?: string) {
		if (commandPending.current) return;
		const targetWorkspaceId = knownWorkspaceId ?? summaries.find((entry) => entry.sessionId === id)?.workspaceId;
		const changingWorkspace = targetWorkspaceId && targetWorkspaceId !== workspaceId;
		if (changingWorkspace && dirtyPanels.length > 0 && !window.confirm("プラグイン画面の未保存の変更を破棄して移動しますか？")) return;
		setDraftInsertion(undefined);
		if (changingWorkspace) { setDirtyPanels([]); setOpenedPanels([]); }
		draftSession.current = undefined;
		if (targetWorkspaceId) setWorkspaceId(targetWorkspaceId);
		if (targetWorkspaceId) setExpandedWorkspaces((previous) => ({ ...previous, [targetWorkspaceId]: true }));
		setMode("chat");
		setSessionId(id); setError(undefined); setFileTarget(undefined); setModelOpen(false);
		if (window.innerWidth < 900) setSidebarOpen(false);
		return true;
	}
	function selectWorkspace(id: string) {
		if (commandPending.current) return;
		if (id !== workspaceId && dirtyPanels.length > 0 && !window.confirm("プラグイン画面の未保存の変更を破棄して移動しますか？")) return;
		setDraftInsertion(undefined);
		setExpandedWorkspaces((previous) => ({ ...previous, [id]: true }));
		if (id === workspaceId) return;
		setWorkspaceId(id); setSessionId(undefined); draftSession.current = undefined; setFileTarget(undefined); setModelOpen(false); setError(undefined); setDirtyPanels([]); setOpenedPanels([]); setMode("chat");
	}
	function newConversation(targetWorkspaceId = workspaceId) {
		if (commandPending.current) return;
		if (targetWorkspaceId !== workspaceId && dirtyPanels.length > 0 && !window.confirm("プラグイン画面の未保存の変更を破棄して移動しますか？")) return;
		if (targetWorkspaceId !== workspaceId) { setDirtyPanels([]); setOpenedPanels([]); }
		setWorkspaceId(targetWorkspaceId);
		setExpandedWorkspaces((previous) => Object.fromEntries(workspaces.map((entry) => [entry.workspaceId, previous[entry.workspaceId] ?? entry.workspaceId === workspaceId])));
		setHistoryQuery(""); setMode("chat"); setSessionId(undefined); draftSession.current = undefined; setDraftInsertion(undefined); setDraftModel(model); setDraftThinking(session?.thinkingLevel ?? draftThinking); setRightOpen(false); setFileTarget(undefined); setError(undefined);
		if (window.innerWidth < 900) setSidebarOpen(false);
	}
	async function renameSession(id: string, title: string) {
		await command(`/api/sessions/${encodeURIComponent(id)}`, { title }, "PATCH");
		setInitialSessions((previous) => previous.map((entry) => entry.sessionId === id ? { ...entry, title } : entry));
		setProjections((previous) => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, { ...value, sessions: value.sessions.map((entry) => entry.sessionId === id ? { ...entry, title } : entry) }])));
	}
	async function removeWorkspace(id: string) {
		const target = workspaces.find((entry) => entry.workspaceId === id);
		if (!target) return;
		if (summaries.some((entry) => entry.workspaceId === id)) {
			setError("会話が残っているワークスペースは一覧から外せません。先に会話を削除してください。");
			return;
		}
		if (!window.confirm(`${target.path} を一覧から外しますか？ファイルは削除しません。`)) return;
		try {
			await command(`/api/workspaces/${encodeURIComponent(id)}`, {}, "DELETE");
			const remaining = workspaces.filter((entry) => entry.workspaceId !== id);
			setWorkspaces(remaining);
			if (workspaceId === id) { setWorkspaceId(remaining[0]?.workspaceId); setSessionId(undefined); }
		} catch (reason) { setError(errorMessage(reason)); }
	}
	async function deleteSession(id: string) {
		const { deletedSessionIds } = await api<{ deletedSessionIds: string[] }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
		const deleted = new Set(deletedSessionIds);
		setInitialSessions((previous) => previous.filter((entry) => !deleted.has(entry.sessionId)));
		setProjections((previous) => Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, { ...value, sessions: value.sessions.filter((entry) => !deleted.has(entry.sessionId)) }])));
		if (sessionId && deleted.has(sessionId)) newConversation();
	}
	function openFile(path: string, line?: number) { if (!filesEnabled) return; setFileTarget({ path, line, requestId: nextClientId() }); setRightTab("tabs"); setRightOpen(true); }
	async function addWorkspace() {
		if (addingWorkspace) return;
		setAddingWorkspace(true); setError(undefined);
		try {
			let added: Workspace;
			if (window.location.hostname !== "127.0.0.1") {
				const path = window.prompt("サーバー上の作業フォルダーの絶対パス", workspace?.path ?? "");
				if (!path?.trim()) return;
				added = await command<Workspace>("/api/workspaces", { path });
			} else {
				const picked = await command<{ workspace: Workspace | null }>("/api/workspaces/pick", {});
				if (!picked.workspace) return;
				added = picked.workspace;
			}
			setWorkspaces((previous) => previous.some((entry) => entry.workspaceId === added.workspaceId) ? previous : [...previous, added]);
			selectWorkspace(added.workspaceId);
			setHistoryQuery("");
		} catch (reason) { setError(errorMessage(reason)); } finally { setAddingWorkspace(false); }
	}
	async function inputSession(): Promise<string> {
		if (!workspaceId) throw new Error("作業フォルダーを準備できません。フォルダーを選択してください。");
		if (modelNeedsAuthentication) { setSettingsOpen(true); throw new Error("プロバイダーの認証を設定してください。"); }
		if (!model) { setModelOpen(true); throw new Error("送信するモデルを選択してください。"); }
		let target = sessionId ?? draftSession.current;
		if (!target) { const created = await command<SessionSummary>("/api/sessions", { workspaceId, model: { provider: model.provider, id: model.id }, ...(draftThinking ? { thinkingLevel: draftThinking } : {}) }); target = created.sessionId; draftSession.current = target; }
		return target;
	}
	async function send(text: string, executionMode: "prompt" | "steer" | "followUp", attachments: AttachmentUpload[], destination?: ComposerDestination): Promise<ComposerSendResult> {
		if (commandPending.current) throw new Error("送信処理中です。完了してから送信してください。");
		commandPending.current = true;
		try {
			const parsed = parseComposerCommand(text);
			if (destination && (sessionId || mode !== "chat" || parsed.kind !== "prompt")) throw new Error("判断モデルによる選択はホームの通常メッセージで利用できます。");
			if (attachments.length && parsed.kind !== "prompt") throw new Error("添付ファイルは通常のメッセージとして送信してください。");
			if (
				parsed.kind === "hyakki" ||
				parsed.kind === "hyakki-continue" ||
				parsed.kind === "hyakki-pause" ||
				parsed.kind === "hyakki-status"
			) {
				if (!profile) throw new Error("プラグインの読み込みが完了してから操作してください。");
				if (!swarmEnabled) throw new Error("Hyakki-Yako が無効です。");
			}
			if (parsed.kind === "canvas") {
				if (!activePanels) throw new Error("プラグインの読み込みが完了してから開いてください。");
				if (!canvasEnabled) throw new Error("設計キャンバスが無効です。");
				if (!workspaceId) throw new Error("ワークスペースを選択してください。");
				openPanel(canvasPanel.id);
				return {};
			}
			if (parsed.kind === "chat") { setMode("chat"); setModelOpen(false); return {}; }
			if (sessionId ? sessionChannel.connection !== "connected" : workspaceChannel.connection !== "connected") throw new Error("接続が完了してから送信してください。");
			if (session?.availability === "missing") throw new Error("保存された会話が見つかりません。新しい会話を開始してください。");
			let result: ComposerSendResult;
			if (destination && parsed.kind === "prompt") {
				const routed = await sendWorkspacePrompt({
					text: parsed.text, attachments, destination, workspaces, model, thinkingLevel: draftThinking,
					beforeStart: (folder, target) => {
						if (target.kind === "new") {
							if (modelNeedsAuthentication) { setSettingsOpen(true); throw new Error("プロバイダーの認証を設定してください。"); }
							if (!model) { setModelOpen(true); throw new Error("送信するモデルを選択してください。"); }
						}
						if (folder.workspaceId !== workspaceId && dirtyPanels.length > 0 && !window.confirm("プラグイン画面の未保存の変更を破棄して移動しますか？")) throw new Error("送信をキャンセルしました。");
					},
				});
				if (routed.kind === "candidates") return { destinationCandidates: routed.candidates };
				if (routed.workspace.workspaceId !== workspaceId) { setDirtyPanels([]); setOpenedPanels([]); }
				draftSession.current = undefined;
				setWorkspaceId(routed.workspace.workspaceId); setSessionId(routed.sessionId);
				setExpandedWorkspaces((previous) => ({ ...previous, [routed.workspace.workspaceId]: true }));
				setFileTarget(undefined); setDraftInsertion(undefined); setHistoryQuery(""); setModelOpen(false);
				if (window.innerWidth < 900) setSidebarOpen(false);
				result = { disposition: routed.disposition };
			} else if (parsed.kind === "hyakki") {
				await startSwarm(parsed.objective);
				result = { notice: "スウォームを開始しました。追加指示はこの入力欄から送れます。" };
			} else if (parsed.kind === "hyakki-continue") {
				const manager = team?.agents.find((agent) => agent.agentId === workspaceTeam?.rootAgentId);
				const target = manager?.sessionId ?? sessionId;
				if (!target) throw new Error("再開するスウォームがありません。");
				await continueSwarm(target);
				setSessionId(target); setMode("chat"); setRightTab("team"); setRightOpen(true);
				result = { notice: "スウォームを再開しました。" };
			} else if (parsed.kind === "hyakki-pause") {
				const manager = team?.agents.find((agent) => agent.agentId === workspaceTeam?.rootAgentId);
				const target = manager?.sessionId ?? sessionId;
				if (!target) throw new Error("一時停止するスウォームがありません。");
				await pauseSwarm(target);
				result = { notice: "スウォームを一時停止しました。" };
			} else if (parsed.kind === "hyakki-status") {
				const manager = team?.agents.find((agent) => agent.agentId === workspaceTeam?.rootAgentId);
				const target = manager?.sessionId ?? sessionId;
				if (target && target !== sessionId) setSessionId(target);
				setMode("chat");
				setRightTab("team");
				setRightOpen(true);
				setTeamBoardRequest((value) => value + 1);
				result = { notice: "Hyakki-Yako の状況を開きました。" };
			} else if (parsed.kind === "goal") {
				const goal = await goalAction(parsed.action);
				result = { notice: goal ? `Goal: ${goal.objective}` : "Goal は設定されていません。" };
			} else if (parsed.kind === "plan") {
				const target = await inputSession();
				const planPrompt = `${parsed.task}\n\nまず関連ファイルを調査し、変更を加える前に action_plan ツールの propose で編集・承認可能なステップ一覧を提示してください。承認後は各ステップの前後で action_plan の start_step / complete_step を呼び出して進捗を記録してください。`;
				result = await command<{ runId: string; disposition: "queued" | "started" }>(`/api/sessions/${encodeURIComponent(target)}/prompt`, { text: planPrompt, mode: executionMode });
				setSessionId(target);
			} else if (parsed.kind === "split") {
				const target = await inputSession();
				const created = await command<{ session: SessionDetail }>(`/api/sessions/${encodeURIComponent(target)}/split`, { text: parsed.task });
				setSessionId(created.session.sessionId);
				result = { notice: "新しいワークツリーセッションを開始しました。" };
			} else if (parsed.kind === "pr") {
				const target = await inputSession();
				await command(`/api/sessions/${encodeURIComponent(target)}/pr`, parsed.title ? { title: parsed.title } : {});
				setSessionId(target);
				result = { notice: "PR ライフサイクルを開始しました。" };
			} else {
				const target = await inputSession();
				result = await command<{ runId: string; disposition: "queued" | "started" }>(`/api/sessions/${encodeURIComponent(target)}/prompt`, { text: parsed.text, mode: executionMode, ...(attachments.length ? { attachments } : {}) });
				setSessionId(target);
			}
			return result;
		} finally { commandPending.current = false; }
	}
	async function stop(id: string) { try { await command(`/api/sessions/${encodeURIComponent(id)}/abort`, {}); } catch (reason) { setError(errorMessage(reason)); } }
	/** Stops every running conversation shown for the current workspace. */
	async function stopAll(): Promise<void> {
		const running = summaries.filter((entry) => entry.workspaceId === workspaceId && (entry.currentRun || entry.latestRun?.status === "running"));
		if (!running.length) return;
		if (!window.confirm(`実行中の会話 ${running.length}件を停止しますか？`)) return;
		await Promise.allSettled(running.map((entry) => command(`/api/sessions/${encodeURIComponent(entry.sessionId)}/abort`, {})));
	}
	/** Re-sends the newest user request as a new turn; the previous reply stays in history. */
	async function retryLast(): Promise<void> {
		if (!session || session.currentRun) return;
		const lastUser = [...session.messages].reverse().find((message) => userText(message));
		const text = lastUser ? userText(lastUser) : undefined;
		if (!text) { setError("再送する依頼が見つかりません。"); return; }
		await command(`/api/sessions/${encodeURIComponent(session.sessionId)}/prompt`, { text, mode: "prompt" });
	}
	async function goalAction(action: GoalAction): Promise<Goal | null> {
		if (!profile) throw new Error("プラグインの読み込みが完了してから操作してください。");
		if (!goalEnabled) throw new Error("Goal が無効です。");
		const target = action.op === "create" ? await inputSession() : sessionId;
		if (!target) {
			if (action.op === "get") return null;
			throw new Error("会話を選択してください。");
		}
		const result = await command<Goal | null>(`/api/sessions/${encodeURIComponent(target)}/goal`, action);
		if (action.op === "create") setSessionId(target);
		return result;
	}
	async function pauseSwarm(targetSessionId: string): Promise<void> {
		if (!profile) throw new Error("プラグインの読み込みが完了してから操作してください。");
		if (!swarmEnabled) throw new Error("Hyakki-Yako が無効です。");
		await command(`/api/sessions/${encodeURIComponent(targetSessionId)}/swarm/pause`, {});
	}
	async function continueSwarm(targetSessionId: string): Promise<void> {
		if (!profile) throw new Error("プラグインの読み込みが完了してから操作してください。");
		if (!swarmEnabled) throw new Error("Hyakki-Yako が無効です。");
		await command(`/api/sessions/${encodeURIComponent(targetSessionId)}/swarm/continue`, {});
	}
	async function startSwarm(objective: string): Promise<void> {
		if (!workspaceId) throw new Error("ワークスペースを選択してください。");
		const manager = team?.agents.find((agent) => agent.agentId === workspaceTeam?.rootAgentId);
		if (!manager && modelSetup) {
			if (modelSetup === "authentication") setSettingsOpen(true); else setModelOpen(true);
			throw new Error(modelSetup === "authentication" ? "プロバイダーの認証を設定してください。" : "送信するモデルを選択してください。");
		}
		const result = await command<{ sessionId: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/swarm`, {
			objective,
			...(!manager ? {
				...(sessionId && !session?.parentSessionId ? { sessionId } : {}),
				model: model && { provider: model.provider, id: model.id },
				...(draftThinking ? { thinkingLevel: draftThinking } : {}),
			} : {}),
		});
		draftSession.current = undefined;
		setSessionId(result.sessionId);
		setMode("chat");
		setRightTab("team");
		setRightOpen(true);
	}
	function openPanel(id: string): void {
		setOpenedPanels((previous) => previous.includes(id) ? previous : [...previous, id]);
		setMode(id);
		setModelOpen(false);
	}

	function insertPanelDraft(text: string): void {
		if (commandPending.current) throw new Error("送信が完了してから設計を入力欄に追加してください。");
		setDraftInsertion({ id: nextClientId(), text });
		setMode("chat");
	}

	async function mutatePendingInput(inputId: string, action: PendingInputAction): Promise<void> {
		if (!sessionId) throw new Error("会話を選択してください。");
		await command(
			`/api/sessions/${encodeURIComponent(sessionId)}/pending-inputs/${encodeURIComponent(inputId)}`,
			action,
			"PATCH",
		);
	}
	async function actOnSurface(surfaceId: string, action: SurfaceAction): Promise<void> {
		if (!sessionId) throw new Error("会話を選択してください。");
		await command(
			`/api/sessions/${encodeURIComponent(sessionId)}/surfaces/${encodeURIComponent(surfaceId)}/action`,
			action,
			"POST",
		);
	}
	async function createPr(title?: string): Promise<void> {
		if (!sessionId) throw new Error("会話を選択してください。");
		await command(
			`/api/sessions/${encodeURIComponent(sessionId)}/pr`,
			title ? { title } : {},
			"POST",
		);
	}
	async function changeModel(selection: { provider: string; id: string }) {
		const updated = sessionId ? await command<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, selection) : undefined;
		setDraftModel(selection);
		draftSession.current = undefined;
		const levels = catalog?.models.find((entry) => entry.provider === selection.provider && entry.id === selection.id)?.thinkingLevels;
		const thinking = updated?.thinkingLevel ?? draftThinking;
		setDraftThinking(thinking && levels?.includes(thinking) ? thinking : undefined);
	}
	async function changeThinking(level: ThinkingLevel) {
		if (sessionId) await command(`/api/sessions/${encodeURIComponent(sessionId)}/thinking`, { level }, "PATCH");
		setDraftThinking(level);
		if (session?.model) setDraftModel(session.model);
		draftSession.current = undefined;
	}
	const thinking = session?.thinkingLevel ?? draftThinking;
	const thinkingLabel = thinking ?? "自動";
	const modelControl = <div className="model-control">
		<button className="composer-chip model-trigger" type="button" aria-haspopup="dialog" aria-expanded={modelOpen} disabled={!!session?.currentRun} aria-label={`モデル・Thinkingを選択: ${selectedModel?.name ?? selectedModel?.id ?? "未選択"} · ${thinkingLabel}`} title={`${selectedModel?.name ?? selectedModel?.id ?? "モデルを選択"} · ${thinkingLabel}`} onClick={() => setModelOpen((value) => !value)}>
			<Icon name="graph" className="model-trigger-icon" />
			<span className="model-trigger-name">{selectedModel?.name ?? selectedModel?.id ?? "モデルを選択"}</span>
			<span className="model-trigger-thinking">{thinkingLabel}</span>
			<Icon name="chevronDown" className="model-trigger-chevron" size="inline" />
		</button>
	</div>;
	const fallbackMainWidth = viewport.width - (sidebarOpen ? viewport.width <= 1100 ? 230 : 300 : 0);
	const effectiveMainWidth = mainWidth > 0 ? mainWidth : fallbackMainWidth;
	const rightMaximum = Math.max(480, effectiveMainWidth - 320);
	const actualRightWidth = Math.min(rightWidth, rightMaximum);
	const panelWidth = `min(${rightWidth}px, max(480px, calc(100cqw - 320px)))`;
	const canvasMode = mode === canvasPanel.id;
	const pluginManagerMode = mode === pluginManagerPanel.id;
	const hideComposer = canvasMode || pluginManagerMode;
	const homeBackgroundVisible = !!background && !sessionId && mode === "chat";
	const traySessions = useMemo(() => {
		if (!sessionId || !workspaceId) return [];
		const workspaceRoots = summaries.filter((entry) => entry.workspaceId === workspaceId && !entry.parentSessionId);
		const currentSummary = workspaceRoots.find((entry) => entry.sessionId === sessionId);
		const rootFamilyId = currentSummary?.splitFromSessionId ?? sessionId;
		const related = workspaceRoots.filter(
			(entry) =>
				entry.sessionId === rootFamilyId ||
				entry.splitFromSessionId === rootFamilyId ||
				entry.sessionId === sessionId ||
				!!entry.currentRun,
		);
		return related.length >= 2 ? related : [];
	}, [summaries, sessionId, workspaceId]);
	const composerDock = traySessions.length >= 2
		? <MultiSessionTray sessions={traySessions} activeSessionId={sessionId} onSelect={selectSession} />
		: undefined;
	const activeConversationReady = mode === "chat" && !!session && session.availability === "ready" && (session.messages.length > 0 || (session.latestRun !== undefined && session.latestRun.inputKind !== "context"));
	const showStatusBar = mode === "chat";
	return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${rightOpen ? "inspector-open" : ""}${showStatusBar ? " has-status-bar" : ""}`} data-home-background={homeBackgroundVisible || undefined}>
		<div className="app-body">
		{workspaces.filter((entry) => entry.workspaceId !== workspaceId && (expandedWorkspaces[entry.workspaceId] ?? false)).map((entry) => <WorkspaceFeed key={entry.workspaceId} id={entry.workspaceId} onUpdate={updateProjection} onFiles={filesChanged} />)}
		<Tooltip label={sidebarOpen ? "履歴を閉じる" : "履歴を開く"}><button ref={sidebarOpener} className="icon-button sidebar-toggle" aria-label={sidebarOpen ? "履歴を閉じる" : "履歴を開く"} aria-controls="conversation-history" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((value) => !value)}><Icon name={sidebarOpen ? "chevronLeft" : "menu"} size="chrome" /></button></Tooltip>
		<button className="navigation-scrim" aria-label="履歴を閉じる" title="履歴を閉じる" aria-hidden={!sidebarOpen} inert={!sidebarOpen} tabIndex={-1} onClick={() => setSidebarOpen(false)} />
		<aside ref={sidebarRef} id="conversation-history" className="sidebar" aria-label="会話の履歴" aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
			<div className="sidebar-brand"><button className="brand" aria-label="新しい会話" onClick={() => newConversation()}><img className="brand-symbol" src="/code-logo.svg" alt="" /></button></div>
			<div className="sidebar-conversation-actions"><button className="new-conversation" onClick={() => newConversation()}><Icon name="plus" size="control" />新しい会話</button>
			{importEnabled && <Tooltip label="セッションを引き継ぐ"><button type="button" className="session-import-trigger" aria-label="セッションを引き継ぐ" disabled={!workspace} onClick={() => { if (narrowViewport) setSidebarOpen(false); setImportOpen(true); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5M3 12h12m-4-4 4 4-4 4" /></svg></button></Tooltip>}</div>
			{activePanels && activePanels.length > 0 && <nav className="sidebar-plugin-panels" aria-label="プラグイン">
				{activePanels.map(({ id, title, icon, requiresWorkspace = true }) => <button type="button" key={id} aria-current={mode === id ? "page" : undefined} disabled={requiresWorkspace && !workspaceId} onClick={() => {
					if (commandPending.current) return;
					openPanel(id);
					if (narrowViewport) setSidebarOpen(false);
				}}><Icon name={icon} />{title}</button>)}
			</nav>}
			{searchEnabled && <label className="history-search"><span className="sr-only">会話を検索</span><input ref={searchInput} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="会話を検索" /><kbd>⌘ / Ctrl K</kbd></label>}
			<div className="history-heading"><span>会話</span><span className="history-heading-actions"><Presence show={runningCount > 0}><button className="icon-button history-stop-all" aria-label="実行中の会話をすべて停止" title="実行中の会話をすべて停止" onClick={() => { void stopAll(); }}><Icon name="stop" size="inline" /></button></Presence><button className="icon-button workspace-add-button" aria-label="ワークスペースを追加" title="フォルダーを選択してワークスペースを追加" disabled={addingWorkspace} onClick={() => { void addWorkspace(); }}>{addingWorkspace ? "…" : <Icon name="plus" size="control" />}</button></span></div>
			<nav className="history-navigation" aria-label="ワークスペースと会話">
				<MotionItems items={workspaces.filter((entry) => !historyQuery.trim() || entry.path.toLowerCase().includes(historyQuery.toLowerCase()) || history.some((item) => item.workspaceId === entry.workspaceId))} itemKey={(entry) => entry.workspaceId}>{(entry) => {
					const conversations = history.filter((item) => item.workspaceId === entry.workspaceId);
					const open = !!historyQuery.trim() || (expandedWorkspaces[entry.workspaceId] ?? workspaceId === entry.workspaceId);
					return <details className="workspace-accordion" key={entry.workspaceId} data-workspace-id={entry.workspaceId} data-selected={workspaceId === entry.workspaceId} open={open}>
						<summary title={entry.path} onClick={(event) => {
							event.preventDefault();
							if (!historyQuery.trim()) setExpandedWorkspaces((previous) => ({ ...previous, [entry.workspaceId]: !open }));
						}}><span className="workspace-name">{workspaceLabel(entry.path, workspaces.map((item) => item.path))}</span><button type="button" className="workspace-remove" aria-label="一覧から外す" title="一覧から外す（ファイルは残ります）" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void removeWorkspace(entry.workspaceId); }}><Icon name="minus" size="inline" /></button><button type="button" className="workspace-new-conversation" aria-label={`${entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path}で新しい会話`} title="このワークスペースで新しい会話" onClick={(event) => { event.preventDefault(); event.stopPropagation(); newConversation(entry.workspaceId); }}><Icon name="plus" size="inline" /></button></summary>
						<ul className="session-list"><MotionItems items={conversations} itemKey={(summary) => summary.sessionId}>{(summary) => {
							const title = (summary.title ?? "新しい会話").replace(/\s+/g, " ").slice(0, 90);
							const status = summary.availability === "missing" ? "missing" : summary.currentRun?.status ?? (summary.latestRun?.status === "failed" || summary.latestRun?.status === "interrupted" ? summary.latestRun.status : "idle");
							const openActions = (button: HTMLButtonElement, x?: number, y?: number) => {
								const bounds = button.getBoundingClientRect();
								setSessionAction({ session: summary, opener: button, x: x ?? bounds.right - 8, y: y ?? bounds.bottom });
							};
							return <li key={summary.sessionId} className="history-session-row"><button className={`session-button ${mode === "chat" && summary.sessionId === sessionId ? "selected" : ""}`} aria-current={mode === "chat" && summary.sessionId === sessionId ? "page" : undefined} onClick={() => selectSession(summary.sessionId)} onContextMenu={(event) => { event.preventDefault(); openActions(event.currentTarget, event.clientX || undefined, event.clientY || undefined); }} onKeyDown={(event) => { if (event.key === "F10" && event.shiftKey) { event.preventDefault(); openActions(event.currentTarget); } }} title={title}><span className={`status-dot status-${status}`} aria-label={status === "missing" ? "履歴が見つかりません" : status === "idle" ? "待機中" : RUN_LABELS[status]} /><span className="session-title">{title}</span></button><button type="button" className="session-menu-button" aria-label={`${title}の操作`} title="会話の操作" aria-haspopup="menu" aria-expanded={sessionAction?.session.sessionId === summary.sessionId} onClick={(event) => openActions(event.currentTarget)}><Icon name="more" size="control" /></button></li>;
						}}</MotionItems></ul><Presence show={conversations.length === 0}><p className="history-empty">{historyQuery ? "一致する会話がありません" : "会話はありません。"}</p></Presence>
						{bodyMatches.filter((match) => conversations.some((entry) => entry.sessionId === match.sessionId)).slice(0, 6).map((match, index) => <button key={`${match.sessionId}-${index}`} type="button" className="history-body-match" onClick={() => selectSession(match.sessionId)} title={match.snippet}><span className="history-body-role">{match.role === "user" ? "あなた" : "AI"}</span>{match.snippet}</button>)}
					</details>;
				}}</MotionItems>
			</nav>
			<div className="sidebar-bottom"><button onClick={() => { if (narrowViewport) setSidebarOpen(false); setSettingsOpen(true); }}><Icon name="settings" size="control" />設定</button></div>
		</aside>
		<div className="workspace-surface"><header className="topbar"><div className="topbar-leading"><span className="page-title">{activePanel ? activePanel.title : selectedAgent && workspaceTeam?.teamId === selectedAgent.teamId ? selectedAgent.parentAgentId ? selectedAgent.name : "マネージャー" : session?.parentSessionId ? "エージェントの会話" : session?.title?.replace(/\s+/g, " ").slice(0, 70) ?? "新しい会話"}</span></div><div className="topbar-actions">{hideComposer && <button type="button" className="quiet-button" onClick={() => setMode("chat")}><Icon name="chevronLeft" size="inline" />会話に戻る</button>}{narrowViewport && activeConversationReady && !rightOpen && <><button type="button" className="quiet-button detail-toggle" aria-label="会話内を検索" onClick={() => window.dispatchEvent(new Event("hasilan:conversation-find"))}><Icon name="search" size="control" /></button>{gitReviewEnabled && <button type="button" className="quiet-button detail-toggle" aria-label="変更をレビュー" onClick={() => window.dispatchEvent(new Event("hasilan:git-review"))}><Icon name="pencil" size="control" /></button>}</>}{!canvasMode && <Tooltip label="作業一覧"><button type="button" className="quiet-button detail-toggle" aria-label="作業一覧" onClick={() => setWorkOpen(true)}><Icon name="list" size="control" /></button></Tooltip>}<Tooltip label={rightOpen ? "詳細パネルを閉じる" : "詳細パネルを開く"}><button ref={rightPanelToggle} className="quiet-button detail-toggle" aria-label="詳細" aria-controls="detail-sidebar" aria-expanded={rightOpen} onClick={() => setRightOpen((value) => !value)}><Icon name="panel" size="control" /></button></Tooltip></div></header>
			<div className="home-backdrop-anchor"><HomeBackdrop background={homeBackgroundVisible ? background : undefined} /></div>
			<PreferenceStatus />
			<Presence show={!!(error || workspaceChannel.error || sessionChannel.error)} collapse><div className="global-error" role="alert"><span>{error ?? workspaceChannel.error ?? sessionChannel.error}</span><button onClick={() => { setError(undefined); workspaceChannel.dismissError(); sessionChannel.dismissError(); }}>閉じる</button></div></Presence>
			<div ref={mainLayoutRef} className="main-layout"><main className="chat-column" inert={(rightOpen || sidebarOpen) && viewport.width <= 900}><Presence show={!hideComposer && !!sessionId && sessionChannel.connection !== "connected"}><p className="connection-warning">{sessionChannel.connection === "connecting" ? "会話を読み込んでいます…" : "再接続中です。サーバーの実行は継続しています。"}</p></Presence>
				{activePanels?.map(({ id, View }) => <Presence key={id} show={mode === id} keepMounted><div className="mode-page" inert={mode !== id}>
					<View workspaceId={workspaceId} opened={openedPanels.includes(id)} onDraft={insertPanelDraft} onDirtyChange={(dirty) => setDirtyPanels((previous) => dirty === previous.includes(id) ? previous : dirty ? [...previous, id] : previous.filter((entry) => entry !== id))} />
				</div></Presence>)}
				<MotionSwap identity={`${workspaceId}:${sessionId ?? "new"}:${mode}`} ready={!sessionId || !!session} hidden={hideComposer} className={`chat-page-transition${activePanel ? " is-surface" : ""}`}><ChatPane commands={commands} loading={!!sessionId && !session} key={sessionId ?? `new:${workspaceId ?? "loading"}`} draftKey={sessionId ?? `new:${workspaceId ?? "loading"}`} workspacePath={workspace?.path} session={session} parentSessionTitle={session?.parentSessionId ? summaries.find((entry) => entry.sessionId === session.parentSessionId)?.title : undefined} team={team} surface={mode !== "chat"} suppressFloatingActions={narrowViewport} gitRefreshToken={filesVersion} gitSummary={gitSummary} gitSummaryManaged draftInsertion={draftInsertion} onDraftInserted={clearDraftInsertion} contextWindow={catalog?.models.find((entry) => entry.provider === model?.provider && entry.id === model.id)?.contextWindow} connected={sessionId ? sessionChannel.connection === "connected" : workspaceChannel.connection === "connected"} modelSetup={modelSetup} modelControl={modelControl} composerDock={composerDock} homeDashboard={homeDashboardEnabled && !sessionId && mode === "chat" ? <HomeDashboard sessions={summaries} workspaces={workspaces} onSession={selectSession} /> : undefined} goalControl={goalEnabled && session?.goal && !session.parentSessionId && <GoalControl session={session} connected={sessionChannel.connection === "connected"} onAction={async (action) => { await goalAction(action); }} />} swarmControl={swarmEnabled && session?.swarm && !session.parentSessionId && <HyakkiControl session={session} team={team} connected={sessionChannel.connection === "connected"} onPause={() => pauseSwarm(session.sessionId)} onContinue={() => continueSwarm(session.sessionId)} onOpenBoard={() => { setRightTab("team"); setRightOpen(true); setTeamBoardRequest((value) => value + 1); }} />} onSend={send} onPendingInputAction={mutatePendingInput} onSurfaceAction={actOnSurface} onCreatePr={createPr} onFile={openFile} onStop={() => { if (sessionId) void stop(sessionId); }} onParent={selectSession} onModelSelect={() => setModelOpen(true)} onProviderSettings={() => setSettingsOpen(true)} onLoadOlder={sessionChannel.loadOlder} historyLoading={sessionChannel.historyLoading} historyError={sessionChannel.historyError} onRetry={() => { void retryLast().catch((reason: unknown) => setError(errorMessage(reason))); }} /></MotionSwap>
				<Presence show={!hideComposer && modelOpen}><div className="motion-contents"><ModelMenu catalog={catalog} value={model} thinkingLevel={session?.thinkingLevel ?? draftThinking} onChange={changeModel} onThinkingChange={changeThinking} onSettings={() => { setModelOpen(false); setSettingsOpen(true); }} onClose={() => setModelOpen(false)} disabled={!!session?.currentRun} /></div></Presence>
			</main><div className="detail-resize-slot" aria-hidden={!rightOpen} inert={!rightOpen}><PanelResize value={actualRightWidth} minimum={480} maximum={rightMaximum} label="詳細パネルの幅" onChange={setRightWidth} onResizingChange={setRightResizing} /></div>
				<aside ref={rightPanelRef} id="detail-sidebar" className="right-panel" aria-hidden={!rightOpen} inert={!rightOpen} data-resizing={rightResizing || undefined} data-settled-closed={(!rightOpen && rightSettledClosed) || undefined} style={{ width: viewport.width > 900 ? panelWidth : undefined, marginRight: viewport.width > 900 ? rightOpen ? 0 : `calc(-1 * ${panelWidth})` : undefined }}>
					<div className="right-panel-body detail-panel-body">
						<MotionSwap identity={workspaceId ?? "loading"} className="detail-content-transition">{workspaceId && <DetailPane key={workspaceId} workspaceId={workspaceId} filesEnabled={filesEnabled} terminalEnabled={terminalEnabled} target={fileTarget} browserTarget={browserTarget} refreshToken={filesVersion} visible={rightOpen} view={rightTab} onViewChange={setRightTab}
							browserModel={model} team={<TeamPane snapshot={team} sessions={swarmEnabled ? summaries : summaries.map((summary) => summary.swarm ? { ...summary, swarm: undefined } : summary)} selectedSessionId={sessionId} visible={rightOpen && rightTab === "team"} onSelect={selectSession} onStop={(id) => { void stop(id); }} onFile={openFile} onPauseSwarm={swarmEnabled ? pauseSwarm : undefined} onContinueSwarm={swarmEnabled ? continueSwarm : undefined} boardRequest={teamBoardRequest} />}
							tools={<ToolInspector tools={session?.toolCalls ?? []} onFile={openFile} />} />}</MotionSwap>
					</div>
				</aside>
			</div>
		</div>
		</div>
		{showStatusBar && <ChatStatusBar
			session={session}
			summaries={summaries}
			workspaceId={workspaceId}
			gitSummary={gitSummary}
			preferredProvider={model?.provider}
			connection={sessionId ? sessionChannel.connection : workspaceChannel.connection}
			canOpenReview={gitReviewEnabled && activeConversationReady}
			onOpenReview={() => window.dispatchEvent(new Event("hasilan:git-review"))}
			onOpenWorkOverview={() => setWorkOpen(true)}
			onOpenSettings={() => setSettingsOpen(true)}
		/>}
		{settingsOpen && <SettingsDialog homeBackground={background} onHomeBackgroundChange={changeBackground} onClose={() => setSettingsOpen(false)} onSaved={() => { setCatalogVersion((value) => value + 1); }} onSessionRestored={async () => {
			const [folders, sessions] = await Promise.all([api<Workspace[]>("/api/workspaces"), api<SessionSummary[]>("/api/sessions")]);
			setWorkspaces(folders);
			setInitialSessions(sessions);
		}} />}
		{workOpen && <WorkOverview onClose={() => setWorkOpen(false)} onSession={(id, folder) => { if (selectSession(id, folder)) setWorkOpen(false); }} />}
		<Presence show={!!sessionAction}><div className="motion-contents">{sessionAction && <SessionActions key={sessionAction.session.sessionId} target={sessionAction} onClose={closeSessionAction} onRename={renameSession} onDelete={deleteSession} canMoveUp={actionIndex > 0} canMoveDown={actionIndex >= 0 && actionIndex < actionOrder.length - 1} onMove={(direction) => {
			const destination = actionIndex + direction;
			if (!actionSession || actionIndex < 0 || destination < 0 || destination >= actionOrder.length) return;
			const nextOrder = [...actionOrder];
			nextOrder.splice(actionIndex, 1);
			nextOrder.splice(destination, 0, actionSession.sessionId);
			setSessionOrder((previous) => ({ ...previous, [actionSession.workspaceId]: nextOrder }));
			closeSessionAction();
		}} />}</div></Presence>
		{importEnabled && <Presence show={importOpen && !!workspace}><div className="motion-contents">{workspace && <SessionImportDialog key={workspace.workspaceId} workspace={workspace} model={model} thinkingLevel={session?.thinkingLevel ?? draftThinking} onFile={openFile} onClose={() => setImportOpen(false)} onImported={(imported, folder) => {
			setWorkspaces((previous) => previous.some((entry) => entry.workspaceId === folder.workspaceId) ? previous : [...previous, folder]);
			setInitialSessions((previous) => [...previous.filter((entry) => entry.sessionId !== imported.sessionId), imported]);
			setExpandedWorkspaces((previous) => ({ ...previous, [folder.workspaceId]: true }));
			draftSession.current = undefined; setDraftInsertion(undefined); setWorkspaceId(folder.workspaceId); setSessionId(imported.sessionId); setMode("chat"); setHistoryQuery(""); setFileTarget(undefined); setError(undefined); setModelOpen(false); setImportOpen(false);
			if (folder.workspaceId !== workspaceId) { setDirtyPanels([]); setOpenedPanels([]); }
			if (window.innerWidth < 900) setSidebarOpen(false);
		}} />}</div></Presence>}
	</div>;
}
