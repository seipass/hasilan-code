import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	formatRateLimitReset,
	pickRateLimitMetrics,
	type ProviderAccountUsageView,
	type RateLimitSelection,
} from "../shared/account-usage.ts";
import type { CompactionSummaryResponse, ContextBreakdown } from "../shared/context-window.ts";
import { ACCOUNT_USAGE_ID } from "../shared/plugin-profile.ts";
import type { ModelUsage, UsageAttribution } from "../shared/usage.ts";
import { api, command, errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { usePluginProfile } from "./plugins/profile.tsx";
import type { SessionDetail } from "./types.ts";
import { UsagePanel } from "./UsagePanel.tsx";
import "./ContextWindowPopover.css";

type ContextCategory = "system" | "mcp" | "skills" | "messages" | "free" | "reserved";

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return Math.round(value).toLocaleString("ja-JP");
}

function shortModelName(model: string): string {
	const tail = model.split("/").at(-1) ?? model;
	return tail.length > 22 ? `${tail.slice(0, 21)}…` : tail;
}

export function ContextWindowPopover({
	session,
	contextWindow,
}: {
	session?: SessionDetail;
	contextWindow?: number;
}) {
	const accountUsageEnabled = usePluginProfile()?.activeIds.includes(ACCOUNT_USAGE_ID) ?? false;
	const rootRef = useRef<HTMLDivElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const popoverId = useId();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<{ left: number; bottom: number; maxHeight: number; flyoutSide: "right" | "left" | "inline" }>();
	const [hoveredCategory, setHoveredCategory] = useState<ContextCategory | null>(null);
	const [hoveredLimit, setHoveredLimit] = useState<"session" | "weekly" | null>(null);
	const [rateLimits, setRateLimits] = useState<RateLimitSelection>({});
	const [attribution, setAttribution] = useState<UsageAttribution>();
	const [compacting, setCompacting] = useState(false);
	const [compactProgress, setCompactProgress] = useState(0);
	const [compactResult, setCompactResult] = useState<{ freedTokens: number; messageCountAtCompact: number }>();
	const [compactError, setCompactError] = useState<string>();
	const [quotaVersion, setQuotaVersion] = useState(0);

	const limit = session?.contextUsage?.contextWindow ?? session?.contextBreakdown?.contextWindow ?? contextWindow ?? 0;
	const breakdown: ContextBreakdown = useMemo(() => {
		if (session?.contextBreakdown) return session.contextBreakdown;
		const total = Math.max(0, session?.contextUsage?.tokens ?? 0);
		const safeLimit = Math.max(1, limit);
		const reserved = Math.min(safeLimit, 16_384);
		const free = Math.max(0, safeLimit - total - reserved);
		return {
			contextWindow: safeLimit,
			autoCompactThreshold: Math.max(0, safeLimit - reserved),
			totalTokens: total,
			percent: Math.min(100, (total / safeLimit) * 100),
			systemTokens: 0,
			mcpTokens: 0,
			mcpServers: [],
			mcpInstructionsTokens: 0,
			skillsTokens: 0,
			skillsCount: 0,
			messagesTokens: total,
			messageCount: session?.messages.length ?? 0,
			messageSegments: total > 0 ? [total] : [],
			reservedTokens: reserved,
			freeTokens: free,
			untilAutoCompact: free,
		};
	}, [session?.contextBreakdown, session?.contextUsage?.tokens, session?.messages.length, limit]);

	const serverCompacting =
		typeof session?.activity.compaction === "object" &&
		session.activity.compaction !== null &&
		"type" in session.activity.compaction &&
		session.activity.compaction.type === "compaction_start";
	const isCompacting = compacting || serverCompacting;

	useEffect(() => {
		if (!isCompacting) {
			setCompactProgress(0);
			return;
		}
		const started = performance.now();
		let frame = 0;
		const tick = (now: number) => {
			const elapsed = now - started;
			// Smooth asymptotic progress up to 0.92 while waiting for summarization to settle.
			const progress = 0.92 * (1 - Math.exp(-elapsed / 1600));
			setCompactProgress(progress);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [isCompacting]);

	useLayoutEffect(() => {
		if (!open) return;
		const trigger = rootRef.current?.querySelector<HTMLButtonElement>(".cw-trigger");
		if (!trigger) return;
		function updatePosition() {
			const bounds = trigger!.getBoundingClientRect();
			const vw = window.visualViewport?.width ?? window.innerWidth;
			const vh = window.visualViewport?.height ?? window.innerHeight;
			const width = Math.min(352, vw - 24);
			const left = Math.max(12, Math.min(bounds.right - width, vw - width - 12));
			const flyoutSide = left + width + 228 <= vw ? "right" : left - 228 >= 8 ? "left" : "inline";
			setPosition({
				left,
				bottom: window.innerHeight - bounds.top + 10,
				maxHeight: Math.max(220, Math.min(580, vh * 0.72, bounds.top - 20)),
				flyoutSide,
			});
		}
		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [open]);

	useEffect(() => {
		function onToggle() {
			setOpen((value) => !value);
		}
		window.addEventListener("hasilan:toggle-context-popover", onToggle);
		return () => window.removeEventListener("hasilan:toggle-context-popover", onToggle);
	}, []);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			const target = event.target as Element | null;
			if (target?.closest("[data-context-popover-toggle]")) return;
			if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
				setOpen(false);
				setHoveredCategory(null);
				setHoveredLimit(null);
			}
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			setOpen(false);
			setHoveredCategory(null);
			setHoveredLimit(null);
			rootRef.current?.querySelector<HTMLButtonElement>(".cw-trigger")?.focus();
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	useEffect(() => {
		if (!open || !session?.sessionId) return;
		const controller = new AbortController();
		void api<UsageAttribution>(`/api/sessions/${encodeURIComponent(session.sessionId)}/usage-attribution`, {
			signal: controller.signal,
		})
			.then((value) => {
				if (!controller.signal.aborted) setAttribution(value);
			})
			.catch(() => undefined);
		if (accountUsageEnabled) {
			void api<ProviderAccountUsageView[]>("/api/account-usage", { signal: controller.signal })
				.then((views) => {
					if (!controller.signal.aborted) setRateLimits(pickRateLimitMetrics(views, session.model?.provider));
				})
				.catch(() => undefined);
		}
		return () => controller.abort();
	}, [open, session?.sessionId, session?.model?.provider, accountUsageEnabled, quotaVersion]);

	useEffect(() => {
		if (compactResult && breakdown.messageCount !== compactResult.messageCountAtCompact) {
			setCompactResult(undefined);
		}
	}, [breakdown.messageCount, compactResult]);

	async function runCompact() {
		if (!session?.sessionId || isCompacting || session.currentRun) return;
		setCompacting(true);
		setCompactError(undefined);
		setCompactResult(undefined);
		try {
			const response = await command<CompactionSummaryResponse>(
				`/api/sessions/${encodeURIComponent(session.sessionId)}/compact`,
				{},
			);
			setCompactResult({ freedTokens: response.freedTokens, messageCountAtCompact: breakdown.messageCount });
			setQuotaVersion((value) => value + 1);
		} catch (reason) {
			setCompactError(errorMessage(reason));
		} finally {
			setCompacting(false);
		}
	}

	const animatedMessagesTokens = isCompacting
		? Math.max(0, Math.round(breakdown.messagesTokens * (1 - compactProgress * 0.78)))
		: breakdown.messagesTokens;
	const fixedTokens = breakdown.systemTokens + breakdown.mcpTokens + breakdown.skillsTokens;
	const displayTotalTokens = isCompacting ? fixedTokens + animatedMessagesTokens : breakdown.totalTokens;
	const displayFreeTokens = Math.max(0, breakdown.contextWindow - displayTotalTokens - breakdown.reservedTokens);
	const displayPercent = Math.min(100, Math.max(0, (displayTotalTokens / Math.max(1, breakdown.contextWindow)) * 100));
	const hasMeasuredTokens = session?.contextUsage?.tokens != null || breakdown.totalTokens > 0;
	const roundedPercent = Math.round(displayPercent);

	const segmentRatio = (tokens: number) => Math.max(0, (tokens / Math.max(1, breakdown.contextWindow)) * 100);
	const categories: { key: ContextCategory; label: string; tokens: number }[] = [
		{ key: "system", label: "System", tokens: breakdown.systemTokens },
		{ key: "mcp", label: "MCP", tokens: breakdown.mcpTokens },
		{ key: "skills", label: "Skills", tokens: breakdown.skillsTokens },
		{ key: "messages", label: "Messages", tokens: animatedMessagesTokens },
		{ key: "free", label: "Free", tokens: displayFreeTokens },
		{ key: "reserved", label: "Reserved", tokens: breakdown.reservedTokens },
	];

	const sessionLimitPct = rateLimits.session?.usedPercent ?? 0;
	const weeklyLimitPct = rateLimits.weekly?.usedPercent ?? 0;
	const sessionWindowTotal = (attribution?.window5h.thisChatTokens ?? 0) + (attribution?.window5h.otherChatsTokens ?? 0);
	const thisChatShare = sessionWindowTotal > 0 ? (attribution!.window5h.thisChatTokens / sessionWindowTotal) : 1;
	const thisChatPct = Math.round(sessionLimitPct * thisChatShare);
	const otherChatsPct = Math.max(0, Math.round(sessionLimitPct) - thisChatPct);

	const topModels = attribution?.window7d.models.slice(0, 2) ?? [];
	const weeklyModelTotal = attribution?.window7d.totalTokens ?? 0;
	const model1Pct =
		topModels[0] && weeklyModelTotal > 0 ? Math.round(weeklyLimitPct * (topModels[0].tokens / weeklyModelTotal)) : Math.round(weeklyLimitPct);
	const model2Pct = topModels[1] ? Math.max(0, Math.round(weeklyLimitPct) - model1Pct) : 0;

	const canCompact = !!session?.sessionId && !session.currentRun && !isCompacting && breakdown.messageCount >= 2;
	const usageGroups: { id: string; label: string; usage?: ModelUsage[] }[] = session
		? [{ id: session.sessionId, label: session.parentSessionId ? "子AI" : "親AI", usage: session.usage }]
		: [];

	const flyout = hoveredCategory && (
		<div className={`cw-flyout is-${position?.flyoutSide ?? "right"}`} role="tooltip">
			<header>
				<span><i className={`cw-dot is-${hoveredCategory}`} />{categories.find((entry) => entry.key === hoveredCategory)?.label}</span>
				<span className="cw-flyout-nums">
					<strong>{formatTokens(categories.find((entry) => entry.key === hoveredCategory)?.tokens ?? 0)}</strong>
					<small>{Math.round(segmentRatio(categories.find((entry) => entry.key === hoveredCategory)?.tokens ?? 0))}%</small>
				</span>
			</header>
			{hoveredCategory === "system" && <p>システムプロンプト、プロジェクト指示、組み込みツール定義の合計です。</p>}
			{hoveredCategory === "mcp" && (
				breakdown.mcpServers.length > 0 || breakdown.mcpInstructionsTokens > 0 ? (
					<dl className="cw-flyout-list">
						{breakdown.mcpServers.length > 0 && (
							<div>
								<dt>{breakdown.mcpServers.map((server) => server.name).join(", ")}</dt>
								<dd>{formatTokens(breakdown.mcpServers.reduce((sum, server) => sum + server.tokens, 0))}</dd>
							</div>
						)}
						{breakdown.mcpInstructionsTokens > 0 && (
							<div><dt>Instructions</dt><dd>{formatTokens(breakdown.mcpInstructionsTokens)}</dd></div>
						)}
					</dl>
				) : <p>接続中の MCP ツールはありません。</p>
			)}
			{hoveredCategory === "skills" && (
				<p>{breakdown.skillsCount > 0 ? `${breakdown.skillsCount} 件のスキル定義が読み込まれています。` : "読み込み済みのスキル定義はありません。"}</p>
			)}
			{hoveredCategory === "messages" && (
				<p>{breakdown.messageCount.toLocaleString("ja-JP")} 件のメッセージとツール結果</p>
			)}
			{hoveredCategory === "free" && (
				<p>自動圧縮まで残り {formatTokens(breakdown.untilAutoCompact)} トークンの余裕があります。</p>
			)}
			{hoveredCategory === "reserved" && (
				<p>自動圧縮の要約処理を実行するために確保されている空き領域です。</p>
			)}
		</div>
	);

	return (
		<div className="cw-root" ref={rootRef}>
			<button
				type="button"
				className={`cw-trigger${open ? " is-open" : ""}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={popoverId}
				aria-label={
					hasMeasuredTokens
						? `コンテキスト ${roundedPercent}% (${formatTokens(displayTotalTokens)} / ${formatTokens(breakdown.contextWindow)})`
						: `コンテキスト — / ${formatTokens(breakdown.contextWindow)}`
				}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="context-usage">
					<svg className="context-usage-ring" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
						<circle cx="10" cy="10" r="7" />
						<circle
							cx="10"
							cy="10"
							r="7"
							pathLength="100"
							strokeDasharray={`${hasMeasuredTokens ? displayPercent : 0} 100`}
						/>
					</svg>
					<span className="context-usage-tooltip" role="tooltip">
						コンテキスト <strong>{hasMeasuredTokens ? `${roundedPercent}%` : "—"}</strong> ·{" "}
						{hasMeasuredTokens ? formatTokens(displayTotalTokens) : "—"} / {formatTokens(breakdown.contextWindow)}
					</span>
				</span>
			</button>
			{typeof document !== "undefined" &&
				createPortal(
					<div
						ref={popoverRef}
						id={popoverId}
						className={`cw-popover${position?.flyoutSide === "inline" ? " is-compact" : ""}`}
						role="dialog"
						aria-label="コンテキストウィンドウ"
						style={
							position
								? { left: position.left, bottom: position.bottom, maxHeight: position.maxHeight }
								: undefined
						}
						hidden={!open}
						inert={!open}
					>
						<section className="cw-section">
							<div className="cw-header">
								<span className="cw-title">
									コンテキスト <strong>{hasMeasuredTokens ? `${roundedPercent}%` : "—"}</strong>
								</span>
								<span className="cw-total">
									{hasMeasuredTokens ? formatTokens(displayTotalTokens) : "—"} / {formatTokens(breakdown.contextWindow)}
								</span>
								<button
									type="button"
									className="cw-close"
									aria-label="コンテキストパネルを閉じる"
									onClick={() => {
										setOpen(false);
										rootRef.current?.querySelector<HTMLButtonElement>(".cw-trigger")?.focus();
									}}
								>
									<Icon name="close" size="inline" />
								</button>
							</div>
							<div
								className={`cw-bar${isCompacting ? " is-compacting" : ""}`}
								data-hovered={hoveredCategory ?? undefined}
								aria-hidden="true"
							>
								{breakdown.systemTokens > 0 && (
									<span
										className={`cw-seg is-system${hoveredCategory && hoveredCategory !== "system" ? " is-dimmed" : ""}`}
										style={{ flexGrow: breakdown.systemTokens }}
									/>
								)}
								{breakdown.mcpTokens > 0 && (
									<span
										className={`cw-seg is-mcp${hoveredCategory && hoveredCategory !== "mcp" ? " is-dimmed" : ""}`}
										style={{ flexGrow: breakdown.mcpTokens }}
									/>
								)}
								{breakdown.skillsTokens > 0 && (
									<span
										className={`cw-seg is-skills${hoveredCategory && hoveredCategory !== "skills" ? " is-dimmed" : ""}`}
										style={{ flexGrow: breakdown.skillsTokens }}
									/>
								)}
								{animatedMessagesTokens > 0 && (
									isCompacting && breakdown.messageSegments.length > 1 ? (
										<span
											className="cw-seg-group is-messages"
											style={{ flexGrow: animatedMessagesTokens }}
										>
											{breakdown.messageSegments.map((weight, index) => (
												<span key={index} className="cw-msg-slice" style={{ flexGrow: weight }} />
											))}
											<span
												className="cw-compressor-line"
												style={{ left: `${Math.max(4, (1 - compactProgress) * 100)}%` }}
											/>
										</span>
									) : (
										<span
											className={`cw-seg is-messages${hoveredCategory && hoveredCategory !== "messages" ? " is-dimmed" : ""}`}
											style={{ flexGrow: animatedMessagesTokens }}
										/>
									)
								)}
								{displayFreeTokens > 0 && (
									<span
										className={`cw-seg is-free${hoveredCategory && hoveredCategory !== "free" ? " is-dimmed" : ""}`}
										style={{ flexGrow: displayFreeTokens }}
									/>
								)}
								{breakdown.reservedTokens > 0 && (
									<span
										className={`cw-seg is-reserved${hoveredCategory && hoveredCategory !== "reserved" ? " is-dimmed" : ""}`}
										style={{ flexGrow: breakdown.reservedTokens }}
									/>
								)}
							</div>
							<div
								className="cw-legend-grid"
								onPointerLeave={(event) => {
									if (event.pointerType !== "touch" && position?.flyoutSide !== "inline") setHoveredCategory(null);
								}}
							>
								{categories.map((category) => (
									<button
										key={category.key}
										type="button"
										className={`cw-legend-item${hoveredCategory && hoveredCategory !== category.key ? " is-dimmed" : ""}`}
										aria-pressed={position?.flyoutSide === "inline" ? hoveredCategory === category.key : undefined}
										onPointerEnter={(event) => {
											if (event.pointerType !== "touch" && position?.flyoutSide !== "inline") setHoveredCategory(category.key);
										}}
										onClick={() => {
											if (position?.flyoutSide === "inline") {
												setHoveredCategory((current) => (current === category.key ? null : category.key));
											}
										}}
										onFocus={(event) => {
											if (position?.flyoutSide !== "inline" && event.currentTarget.matches(":focus-visible")) {
												setHoveredCategory(category.key);
											}
										}}
										onBlur={() => {
											if (position?.flyoutSide !== "inline") {
												setHoveredCategory((current) => (current === category.key ? null : current));
											}
										}}
									>
										<span><i className={`cw-dot is-${category.key}`} />{category.label}</span>
										<span>{formatTokens(category.tokens)}</span>
									</button>
								))}
							</div>
							{flyout}
						</section>

						{(rateLimits.session || rateLimits.weekly) && (
							<section className="cw-section cw-limits" onPointerLeave={() => setHoveredLimit(null)}>
								{rateLimits.session && (
									<div
										className={`cw-limit-row${hoveredLimit === "weekly" ? " is-dimmed" : ""}`}
										onPointerEnter={() => setHoveredLimit("session")}
									>
										{hoveredLimit === "session" ? (
											<div className="cw-limit-header is-breakdown">
												<span><i className="cw-dash is-primary" />この会話 <strong>{thisChatPct}%</strong></span>
												<span><i className="cw-dash is-secondary" />他の会話 <strong>{otherChatsPct}%</strong></span>
											</div>
										) : (
											<div className="cw-limit-header">
												<span>セッション枠 <strong>{Math.round(sessionLimitPct)}%</strong></span>
												<span className="cw-limit-reset">{formatRateLimitReset(rateLimits.session.resetsAt) ?? rateLimits.session.label}</span>
											</div>
										)}
										<div className="cw-limit-track">
											{hoveredLimit === "session" ? (
												<>
													<span className="cw-limit-fill is-primary" style={{ width: `${Math.min(100, thisChatPct)}%` }} />
													<span className="cw-limit-fill is-secondary" style={{ width: `${Math.min(100 - thisChatPct, otherChatsPct)}%` }} />
												</>
											) : (
												<span className="cw-limit-fill is-primary" style={{ width: `${Math.min(100, sessionLimitPct)}%` }} />
											)}
										</div>
									</div>
								)}
								{rateLimits.weekly && (
									<div
										className={`cw-limit-row${hoveredLimit === "session" ? " is-dimmed" : ""}`}
										onPointerEnter={() => setHoveredLimit("weekly")}
									>
										{hoveredLimit === "weekly" && topModels.length > 0 ? (
											<div className="cw-limit-header is-breakdown">
												<span><i className="cw-dash is-primary" />{shortModelName(topModels[0].model)} <strong>{model1Pct}%</strong></span>
												{topModels[1] && (
													<span><i className="cw-dash is-secondary" />{shortModelName(topModels[1].model)} <strong>{model2Pct}%</strong></span>
												)}
											</div>
										) : (
											<div className="cw-limit-header">
												<span>週次枠 <strong>{Math.round(weeklyLimitPct)}%</strong></span>
												<span className="cw-limit-reset">{formatRateLimitReset(rateLimits.weekly.resetsAt) ?? rateLimits.weekly.label}</span>
											</div>
										)}
										<div className="cw-limit-track">
											{hoveredLimit === "weekly" && topModels.length > 1 ? (
												<>
													<span className="cw-limit-fill is-primary" style={{ width: `${Math.min(100, model1Pct)}%` }} />
													<span className="cw-limit-fill is-secondary" style={{ width: `${Math.min(100 - model1Pct, model2Pct)}%` }} />
												</>
											) : (
												<span className="cw-limit-fill is-primary" style={{ width: `${Math.min(100, weeklyLimitPct)}%` }} />
											)}
										</div>
									</div>
								)}
							</section>
						)}

						<section className="cw-section cw-compact-footer">
							<span className={`cw-compact-status${compactResult ? " is-done" : compactError ? " is-error" : ""}`}>
								{isCompacting ? (
									"メッセージを要約中…"
								) : compactError ? (
									compactError
								) : compactResult ? (
									<><Icon name="check" size="inline" />{formatTokens(compactResult.freedTokens)} トークンを解放</>
								) : (
									`自動圧縮まで残り ${formatTokens(breakdown.untilAutoCompact)}`
								)}
							</span>
							<button
								type="button"
								className={`cw-compact-button${compactResult ? " is-done" : ""}`}
								disabled={!canCompact || !!compactResult}
								onClick={() => {
									void runCompact();
								}}
							>
								{isCompacting ? "圧縮中…" : compactResult ? "圧縮済み" : "今すぐ圧縮"}
							</button>
						</section>

						{usageGroups.length > 0 && (
							<section className="cw-section cw-billing-section">
								<UsagePanel title="モデル別の使用量・費用" groups={usageGroups} />
							</section>
						)}
					</div>,
					document.body,
				)}
		</div>
	);
}
