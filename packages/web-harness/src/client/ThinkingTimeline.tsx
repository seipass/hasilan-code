import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { buildThinkingGraph, type ThinkingCitation, type ThinkingGraphNode } from "./thinking-graph.ts";
import type { TurnActivity } from "./turn-activity.ts";
import "./ThinkingTimeline.css";

const MAIN_X = 9;
const BRANCH_X = 23;
const MAX_VISIBLE_CITATIONS = 4;

interface EdgeSegment {
	key: string;
	d: string;
	dashed?: boolean;
	branch?: boolean;
}

function CitationPill({
	citation,
	onFile,
}: {
	citation: ThinkingCitation;
	onFile: (path: string, line?: number) => void;
}) {
	if (citation.kind === "file" && citation.path) {
		const path = citation.path;
		return (
			<button type="button" className="tt-pill" title={path} onClick={() => onFile(path)}>
				{citation.ext && <span className={`tt-pill-ext is-${citation.ext.toLowerCase()}`}>{citation.ext}</span>}
				<span>{citation.label}</span>
			</button>
		);
	}
	if (citation.url) {
		return (
			<a className="tt-pill is-web" href={citation.url} target="_blank" rel="noopener noreferrer" title={citation.url}>
				<Icon name="external" size="inline" />
				<span>{citation.label}</span>
			</a>
		);
	}
	return <span className="tt-pill">{citation.label}</span>;
}

function NodeGlyph({ node }: { node: ThinkingGraphNode }) {
	if (node.kind === "finish") {
		return (
			<span className="tt-glyph is-finish" aria-hidden="true">
				<Icon name="check" size="inline" />
			</span>
		);
	}
	if (node.kind === "dead_end") {
		return (
			<span className="tt-glyph is-dead-end" aria-hidden="true">
				<Icon name="close" size="inline" />
			</span>
		);
	}
	if (node.kind === "search") {
		return (
			<span className={`tt-glyph is-search${node.status === "active" ? " is-active" : ""}`} aria-hidden="true">
				<Icon name="search" size="inline" />
			</span>
		);
	}
	if (node.kind === "merge") {
		return <span className={`tt-glyph is-merge${node.status === "active" ? " is-active" : ""}`} aria-hidden="true" />;
	}
	return <span className={`tt-glyph is-step${node.status === "active" ? " is-active" : ""}`} aria-hidden="true" />;
}

export function useThinkingDuration(block: TurnActivity): number | undefined {
	const [startedLocal] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	const graph = useMemo(() => buildThinkingGraph(block), [block]);
	useEffect(() => {
		if (!block.active) return;
		const timer = window.setInterval(() => setNow(Date.now()), 500);
		return () => window.clearInterval(timer);
	}, [block.active]);
	const start = graph.startedAtMs ?? (block.active ? startedLocal : undefined);
	if (start === undefined) return undefined;
	const end = block.active ? now : (graph.endedAtMs ?? now);
	return Math.max(0, Math.round((end - start) / 1000));
}

export function ThinkingTimeline({
	block,
	onFile,
	rawChildren,
}: {
	block: TurnActivity;
	onFile: (path: string, line?: number) => void;
	rawChildren?: ReactNode;
}) {
	const graph = useMemo(() => buildThinkingGraph(block), [block]);
	const listRef = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState<EdgeSegment[]>([]);
	const [svgHeight, setSvgHeight] = useState(0);
	const [expandedCitations, setExpandedCitations] = useState<Record<string, boolean>>({});
	const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
	const [showRaw, setShowRaw] = useState(false);

	useLayoutEffect(() => {
		const container = listRef.current;
		if (!container) return;
		const measure = () => {
			const rootRect = container.getBoundingClientRect();
			const centers = new Map<string, number>();
			for (const el of container.querySelectorAll<HTMLElement>("[data-node-id]")) {
				const id = el.dataset.nodeId;
				const anchor = el.querySelector<HTMLElement>(".tt-node-anchor");
				if (!id || !anchor) continue;
				const rect = anchor.getBoundingClientRect();
				centers.set(id, rect.top - rootRect.top + rect.height / 2);
			}
			const nextEdges: EdgeSegment[] = [];
			for (const node of graph.nodes) {
				const y2 = centers.get(node.id);
				if (y2 === undefined) continue;
				if (node.lane === "main" && node.prevMainId) {
					const y1 = centers.get(node.prevMainId);
					if (y1 !== undefined && y2 > y1) {
						nextEdges.push({
							key: `main:${node.prevMainId}->${node.id}`,
							d: `M ${MAIN_X} ${y1.toFixed(1)} L ${MAIN_X} ${y2.toFixed(1)}`,
						});
					}
				}
				if (node.lane === "branch" && node.forkFromId) {
					const y1 = centers.get(node.forkFromId);
					if (y1 !== undefined) {
						const midY = y1 + (y2 - y1) * 0.55;
						nextEdges.push({
							key: `fork:${node.forkFromId}->${node.id}`,
							d: `M ${MAIN_X} ${y1.toFixed(1)} C ${MAIN_X} ${midY.toFixed(1)}, ${BRANCH_X} ${(y1 + 4).toFixed(1)}, ${BRANCH_X} ${y2.toFixed(1)}`,
							dashed: node.kind === "dead_end",
							branch: true,
						});
					}
				}
				if (node.lane === "branch" && node.prevBranchId) {
					const y1 = centers.get(node.prevBranchId);
					if (y1 !== undefined && y2 > y1) {
						nextEdges.push({
							key: `branch:${node.prevBranchId}->${node.id}`,
							d: `M ${BRANCH_X} ${y1.toFixed(1)} L ${BRANCH_X} ${y2.toFixed(1)}`,
							branch: true,
						});
					}
				}
				if (node.kind === "merge" && node.mergeFromId) {
					const y1 = centers.get(node.mergeFromId);
					if (y1 !== undefined) {
						const midY = y1 + (y2 - y1) * 0.55;
						nextEdges.push({
							key: `merge:${node.mergeFromId}->${node.id}`,
							d: `M ${BRANCH_X} ${y1.toFixed(1)} C ${BRANCH_X} ${midY.toFixed(1)}, ${MAIN_X} ${(y2 - 4).toFixed(1)}, ${MAIN_X} ${y2.toFixed(1)}`,
							branch: true,
						});
					}
				}
			}
			setEdges(nextEdges);
			setSvgHeight(Math.ceil(container.scrollHeight));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [graph.nodes, expandedCitations, expandedThoughts]);

	if (graph.nodes.length === 0) {
		return rawChildren ? <div className="turn-activity-items">{rawChildren}</div> : null;
	}

	return (
		<div className="tt-container">
			<div className="tt-list" ref={listRef}>
				{svgHeight > 0 && (
					<svg
						className="tt-rail-svg"
						width="32"
						height={svgHeight}
						viewBox={`0 0 32 ${svgHeight}`}
						aria-hidden="true"
					>
						{edges.map((edge) => (
							<path
								key={edge.key}
								d={edge.d}
								className={`tt-edge${edge.dashed ? " is-dashed" : ""}${edge.branch ? " is-branch" : ""}`}
							/>
						))}
					</svg>
				)}
				{graph.nodes.map((node) => {
					const citations = node.citations ?? [];
					const allCitations = expandedCitations[node.id] === true;
					const visibleCitations = allCitations ? citations : citations.slice(0, MAX_VISIBLE_CITATIONS);
					const hiddenCount = citations.length - visibleCitations.length;
					const thoughtOpen = expandedThoughts[node.id] === true;
					const hasExpandableThought = !!node.thinkingText && node.thinkingText.length > 96;
					return (
						<div
							key={node.id}
							data-node-id={node.id}
							className={`tt-row is-${node.lane} is-${node.kind} is-${node.status}`}
						>
							<span className={`tt-node-anchor is-${node.lane}`}>
								<NodeGlyph node={node} />
							</span>
							<div className="tt-content">
								<div className="tt-label-line">
									{hasExpandableThought ? (
										<button
											type="button"
											className={`tt-label-button${node.status === "active" ? " is-shimmer" : ""}`}
											aria-expanded={thoughtOpen}
											onClick={() =>
												setExpandedThoughts((current) => ({ ...current, [node.id]: !current[node.id] }))
											}
										>
											{node.label}
										</button>
									) : (
										<span className={`tt-label${node.status === "active" ? " is-shimmer" : ""}`}>{node.label}</span>
									)}
									{node.meta && <span className="tt-meta">{node.meta}</span>}
								</div>
								{thoughtOpen && node.thinkingText && <p className="tt-thought-body">{node.thinkingText}</p>}
								{visibleCitations.length > 0 && (
									<div className="tt-citations">
										{visibleCitations.map((citation, index) => (
											<CitationPill key={`${citation.label}:${index}`} citation={citation} onFile={onFile} />
										))}
										{hiddenCount > 0 && (
											<button
												type="button"
												className="tt-more-citations"
												onClick={() => setExpandedCitations((current) => ({ ...current, [node.id]: true }))}
											>
												+{hiddenCount} 件
											</button>
										)}
									</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
			{rawChildren && (
				<div className="tt-raw-toggle-wrap">
					<button
						type="button"
						className="tt-raw-toggle"
						aria-expanded={showRaw}
						onClick={() => setShowRaw((value) => !value)}
					>
						{showRaw ? "ツール詳細を折りたたむ" : "ツール詳細を表示"}
					</button>
					{showRaw && <div className="turn-activity-items">{rawChildren}</div>}
				</div>
			)}
		</div>
	);
}
