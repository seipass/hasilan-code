import { useEffect, useMemo, useRef, useState } from "react";
import type {
	ActionPlanFileChange,
	ActionPlanSurface,
	ActionPlanTestSummary,
	SurfaceAction,
} from "../shared/surfaces.ts";
import { errorMessage } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { nextClientId } from "./ids.ts";
import { Presence } from "./Motion.tsx";
import "./ActionPlanCard.css";

interface DraftStep {
	id: string;
	title: string;
}

function fileExtensionBadge(path: string): { label: string; kind: string } {
	const name = path.split(/[\\/]/).at(-1) ?? path;
	const ext = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() ?? "" : "";
	if (ext === "ts" || ext === "tsx") return { label: "TS", kind: "ts" };
	if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return { label: "JS", kind: "js" };
	if (ext === "css" || ext === "scss") return { label: "CSS", kind: "css" };
	if (ext === "json") return { label: "JSON", kind: "json" };
	if (ext === "md") return { label: "MD", kind: "md" };
	if (ext === "py") return { label: "PY", kind: "py" };
	if (ext === "sql") return { label: "SQL", kind: "sql" };
	return { label: ext.toUpperCase().slice(0, 4) || "FILE", kind: "generic" };
}

function shortFileName(path: string): string {
	return path.split(/[\\/]/).at(-1) ?? path;
}

function renderDiffPreview(patch: string): { kind: "add" | "remove" | "meta" | "context"; text: string }[] {
	const lines = patch.split(/\r?\n/);
	const result: { kind: "add" | "remove" | "meta" | "context"; text: string }[] = [];
	for (const line of lines) {
		if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		if (line.startsWith("@@ ")) {
			result.push({ kind: "meta", text: line });
		} else if (line.startsWith("+")) {
			result.push({ kind: "add", text: line });
		} else if (line.startsWith("-")) {
			result.push({ kind: "remove", text: line });
		} else {
			result.push({ kind: "context", text: line });
		}
		if (result.length >= 22) break;
	}
	return result;
}

function PixelMatrix({ active }: { active: boolean }) {
	return (
		<span className={`ap-matrix${active ? " is-active" : ""}`} aria-hidden="true">
			{Array.from({ length: 9 }, (_, index) => (
				<i key={index} style={{ animationDelay: `${(index % 3) * 140 + Math.floor(index / 3) * 90}ms` }} />
			))}
		</span>
	);
}

function useElapsedSeconds(startedAt?: string, completedAt?: string, active?: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active || !startedAt) return;
		const timer = window.setInterval(() => setNow(Date.now()), 500);
		return () => window.clearInterval(timer);
	}, [active, startedAt]);
	if (!startedAt) return 0;
	const startMs = Date.parse(startedAt);
	const endMs = completedAt ? Date.parse(completedAt) : now;
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
	return Math.max(0, Math.round((endMs - startMs) / 1000));
}

export function ActionPlanCard({
	surface,
	onAction,
	onFile,
}: {
	surface: ActionPlanSurface;
	onAction: (surfaceId: string, action: SurfaceAction) => Promise<void>;
	onFile: (path: string, line?: number) => void;
}) {
	const [draftSteps, setDraftSteps] = useState<DraftStep[]>(() =>
		surface.steps.map((step) => ({ id: step.id, title: step.title })),
	);
	const [adding, setAdding] = useState(false);
	const [newStepText, setNewStepText] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [dragIndex, setDragIndex] = useState<number | null>(null);
	const [overIndex, setOverIndex] = useState<number | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string>();
	const [hoveredChip, setHoveredChip] = useState<
		| { key: string; kind: "file"; file: ActionPlanFileChange }
		| { key: string; kind: "tests"; tests: ActionPlanTestSummary }
		| null
	>(null);
	const addInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (surface.phase !== "draft") {
			setDraftSteps(surface.steps.map((step) => ({ id: step.id, title: step.title })));
		}
	}, [surface.phase, surface.steps]);

	useEffect(() => {
		if (adding) addInputRef.current?.focus();
	}, [adding]);

	const isDraft = surface.phase === "draft";
	const isExecuting = surface.phase === "executing";
	const isCompleted = surface.phase === "completed";
	const isCancelled = surface.phase === "cancelled";

	const elapsed = useElapsedSeconds(surface.startedAt, surface.completedAt, isExecuting);

	const activeStep = useMemo(
		() => surface.steps.find((step) => step.id === surface.activeStepId) ?? surface.steps.find((step) => step.status === "active"),
		[surface.steps, surface.activeStepId],
	);
	const activeTrace = activeStep?.tools.findLast((tool) => tool.status === "running") ?? activeStep?.tools.at(-1);

	function commitNewStep() {
		const trimmed = newStepText.trim();
		if (trimmed) {
			setDraftSteps((current) => [...current, { id: nextClientId(), title: trimmed }]);
		}
		setNewStepText("");
		setAdding(false);
	}

	function moveStep(from: number, to: number) {
		if (from === to || from < 0 || to < 0 || from >= draftSteps.length || to >= draftSteps.length) return;
		setDraftSteps((current) => {
			const next = current.slice();
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved);
			return next;
		});
	}

	async function approve() {
		const validSteps = draftSteps
			.map((step) => ({ id: step.id, title: step.title.trim() }))
			.filter((step) => step.title.length > 0);
		if (!validSteps.length || submitting) return;
		setSubmitting(true);
		setError(undefined);
		try {
			await onAction(surface.surfaceId, { type: "approve_plan", steps: validSteps });
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setSubmitting(false);
		}
	}

	async function cancel() {
		if (submitting) return;
		setSubmitting(true);
		setError(undefined);
		try {
			await onAction(surface.surfaceId, { type: "cancel_plan" });
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setSubmitting(false);
		}
	}

	const visibleSteps = isDraft
		? draftSteps.map((step) => ({
				id: step.id,
				title: step.title,
				status: "pending" as const,
				note: undefined,
				tools: [],
				files: [],
				tests: undefined,
			}))
		: surface.steps;

	const statusSummary = isExecuting
		? activeTrace
			? `${activeTrace.label}${activeTrace.target ? ` ${activeTrace.target}` : ""}`
			: activeStep
				? activeStep.title
				: "プランを実行中…"
		: isCompleted
			? `Worked for ${elapsed}s`
			: isCancelled
				? "プランはキャンセルされました"
				: undefined;

	return (
		<div className={`ap-wrap is-${surface.phase}`}>
			<section className="ap-card" aria-label={surface.title ?? "実行プラン"}>
				{surface.title && <header className="ap-header"><strong>{surface.title}</strong></header>}
				<ol className="ap-steps">
					{visibleSteps.map((step, index) => {
						const isDragging = isDraft && dragIndex === index;
						const isDropTarget = isDraft && overIndex === index && dragIndex !== null && dragIndex !== index;
						const isEditing = isDraft && editingId === step.id;
						return (
							<li
								key={step.id}
								className={`ap-step is-${step.status}${isDragging ? " is-dragging" : ""}${isDropTarget ? " is-drop-target" : ""}`}
								draggable={isDraft && !isEditing}
								onDragStart={(event) => {
									if (!isDraft) return;
									setDragIndex(index);
									setOverIndex(index);
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData("text/plain", String(index));
								}}
								onDragOver={(event) => {
									if (!isDraft || dragIndex === null) return;
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
									if (overIndex !== index) setOverIndex(index);
								}}
								onDrop={(event) => {
									if (!isDraft) return;
									event.preventDefault();
									if (dragIndex !== null) moveStep(dragIndex, index);
									setDragIndex(null);
									setOverIndex(null);
								}}
								onDragEnd={() => {
									setDragIndex(null);
									setOverIndex(null);
								}}
							>
								<div className="ap-step-row">
									<span className={`ap-step-icon is-${step.status}`} aria-hidden="true">
										{step.status === "completed" ? (
											<Icon name="check" size="inline" />
										) : step.status === "active" ? (
											<span className="ap-spinner" />
										) : (
											<span className="ap-circle-dashed" />
										)}
									</span>

									<div className="ap-step-main">
										{isEditing ? (
											<input
												type="text"
												className="ap-step-edit-input"
												aria-label="ステップを編集"
												autoFocus
												value={step.title}
												onChange={(event) => {
													const value = event.target.value;
													setDraftSteps((current) =>
														current.map((item) => (item.id === step.id ? { ...item, title: value } : item)),
													);
												}}
												onBlur={() => setEditingId(null)}
												onKeyDown={(event) => {
													if (event.key === "Enter" || event.key === "Escape") {
														event.preventDefault();
														setEditingId(null);
													}
												}}
											/>
										) : isDraft ? (
											<button
												type="button"
												className="ap-step-title-button"
												onClick={() => setEditingId(step.id)}
												onKeyDown={(event) => {
													if (event.altKey && event.key === "ArrowUp") {
														event.preventDefault();
														moveStep(index, index - 1);
													} else if (event.altKey && event.key === "ArrowDown") {
														event.preventDefault();
														moveStep(index, index + 1);
													}
												}}
											>
												{step.title}
											</button>
										) : (
											<span className="ap-step-title">{step.title}</span>
										)}

										{step.status === "active" && step.tools.length > 0 && (
											<ul className="ap-tool-timeline">
												{step.tools.map((tool, toolIndex) => {
													const isLatest = toolIndex === step.tools.length - 1;
													return (
														<li key={tool.callId} className={`ap-tool-item is-${tool.status}${isLatest ? " is-latest" : ""}`}>
															<span className="ap-tool-dot" aria-hidden="true" />
															<span className="ap-tool-text">
																{tool.label}
																{tool.target && (
																	<>
																		{" "}
																		<span className="ap-tool-target">{tool.target}</span>
																	</>
																)}
																{(tool.added !== undefined || tool.removed !== undefined) && (
																	<span className="ap-chip-counts">
																		{tool.added ? <span className="is-add">+{tool.added}</span> : null}
																		{tool.removed ? <span className="is-remove">-{tool.removed}</span> : null}
																	</span>
																)}
															</span>
														</li>
													);
												})}
											</ul>
										)}

										{step.status === "completed" && step.note && <p className="ap-step-note">{step.note}</p>}

										{step.status === "completed" && (step.files.length > 0 || step.tests) && (
											<div className="ap-chips" onPointerLeave={() => setHoveredChip(null)}>
												{step.files.map((file) => {
													const badge = fileExtensionBadge(file.path);
													const chipKey = `${step.id}:file:${file.path}`;
													const isHovered = hoveredChip?.key === chipKey;
													return (
														<span
															key={file.path}
															className="ap-chip-anchor"
															onPointerEnter={() => setHoveredChip({ key: chipKey, kind: "file", file })}
														>
															<button
																type="button"
																className="ap-chip"
																onFocus={() => setHoveredChip({ key: chipKey, kind: "file", file })}
																onBlur={() => setHoveredChip((current) => (current?.key === chipKey ? null : current))}
																onClick={() => onFile(file.path)}
															>
																<span className={`ap-ext is-${badge.kind}`}>{badge.label}</span>
																<span className="ap-chip-name">{shortFileName(file.path)}</span>
																<span className="ap-chip-counts">
																	{file.added > 0 && <span className="is-add">+{file.added}</span>}
																	{file.removed > 0 && <span className="is-remove">-{file.removed}</span>}
																</span>
															</button>
															{isHovered && (
																<div className="ap-popover" role="tooltip">
																	<header className="ap-popover-header">
																		<code>{file.path}</code>
																		{file.isNew && <span className="ap-new-tag">new file</span>}
																	</header>
																	<pre className="ap-popover-diff">
																		{renderDiffPreview(file.patch).map((row, rowIndex) => (
																			<span key={rowIndex} data-kind={row.kind}>
																				{row.text}
																				{"\n"}
																			</span>
																		))}
																	</pre>
																</div>
															)}
														</span>
													);
												})}
												{step.tests && (() => {
													const tests = step.tests;
													const chipKey = `${step.id}:tests`;
													const isHovered = hoveredChip?.key === chipKey;
													return (
														<span
															className="ap-chip-anchor"
															onPointerEnter={() => setHoveredChip({ key: chipKey, kind: "tests", tests })}
														>
															<button
																type="button"
																className={`ap-chip is-tests${tests.failed > 0 ? " is-failed" : ""}`}
																onFocus={() => setHoveredChip({ key: chipKey, kind: "tests", tests })}
																onBlur={() => setHoveredChip((current) => (current?.key === chipKey ? null : current))}
															>
																<Icon name={tests.failed > 0 ? "close" : "check"} size="inline" />
																<span>
																	Tests {tests.passed} passed ({tests.total})
																</span>
															</button>
															{isHovered && (
																<div className="ap-popover" role="tooltip">
																	<header className="ap-popover-header">
																		<strong>
																			Tests: {tests.passed} passed
																			{tests.failed > 0 ? `, ${tests.failed} failed` : ""}
																		</strong>
																	</header>
																	{tests.cases?.length ? (
																		<ul className="ap-popover-tests">
																			{tests.cases.slice(0, 10).map((item, caseIndex) => (
																				<li key={caseIndex} className={`is-${item.status}`}>
																					<Icon name={item.status === "passed" ? "check" : "close"} size="inline" />
																					<span>{item.name}</span>
																				</li>
																			))}
																		</ul>
																	) : (
																		<p className="ap-popover-empty">合計 {tests.total} 件のテストを実行しました。</p>
																	)}
																</div>
															)}
														</span>
													);
												})()}
											</div>
										)}
									</div>

									{isDraft && (
										<span className="ap-step-controls">
											<span className="ap-drag-handle" title="ドラッグして並べ替え（Alt+↑↓ でも移動）" aria-hidden="true">
												<Icon name="grip" size="inline" />
											</span>
											<button
												type="button"
												className="ap-step-remove"
												aria-label={`「${step.title}」を削除`}
												disabled={draftSteps.length <= 1}
												onClick={() => setDraftSteps((current) => current.filter((item) => item.id !== step.id))}
											>
												<Icon name="close" size="inline" />
											</button>
										</span>
									)}
								</div>
							</li>
						);
					})}
				</ol>

				<Presence show={isDraft} collapse>
					<div className="ap-draft-chrome">
						<div className="ap-add-row">
							{adding ? (
								<div className="ap-add-input-wrap">
									<span className="ap-circle-dashed" aria-hidden="true" />
									<input
										ref={addInputRef}
										type="text"
										className="ap-add-input"
										placeholder="ステップを入力"
										aria-label="新しいステップを入力"
										value={newStepText}
										onChange={(event) => setNewStepText(event.target.value)}
										onBlur={commitNewStep}
										onKeyDown={(event) => {
											if (event.key === "Enter" && !event.nativeEvent.isComposing) {
												event.preventDefault();
												commitNewStep();
											} else if (event.key === "Escape") {
												event.preventDefault();
												setNewStepText("");
												setAdding(false);
											}
										}}
									/>
								</div>
							) : (
								<button type="button" className="ap-add-button" onClick={() => setAdding(true)}>
									<Icon name="plus" size="inline" />
									<span>ステップを追加</span>
								</button>
							)}
						</div>
						<footer className="ap-footer">
							<span className="ap-footer-meta">
								{draftSteps.length} ステップ{surface.estimatedFiles > 0 ? ` · ${surface.estimatedFiles} ファイル` : ""}
							</span>
							<div className="ap-footer-actions">
								<button type="button" className="ap-cancel-button" disabled={submitting} onClick={() => { void cancel(); }}>
									キャンセル
								</button>
								<button
									type="button"
									className="ap-approve-button"
									disabled={submitting || draftSteps.every((step) => !step.title.trim())}
									onClick={() => { void approve(); }}
								>
									{submitting ? "送信中…" : "プランを承認"}
								</button>
							</div>
						</footer>
						{error && <p className="ap-error" role="alert">{error}</p>}
					</div>
				</Presence>
			</section>

			{statusSummary && (
				<div className={`ap-status-line${isExecuting ? " is-running" : ""}`} role={isExecuting ? "status" : undefined}>
					<PixelMatrix active={isExecuting} />
					<span className="ap-status-text">{statusSummary}</span>
					{isExecuting && <span className="ap-status-elapsed">{elapsed}s</span>}
				</div>
			)}
		</div>
	);
}
