import type { TeamAgent, TeamSnapshot } from "./types.ts";

export const TEAM_NODE_WIDTH = 224;
export const TEAM_NODE_HEIGHT = 152;
const COLUMN_GAP = 28;
const ROW_GAP = 64;
const PADDING = 28;

export interface TeamGraphNode {
	agent: TeamAgent;
	x: number;
	y: number;
}

export interface TeamGraphEdge {
	id: string;
	from: TeamGraphNode;
	to: TeamGraphNode;
	kind: "parent" | "waiting";
	route: "parent" | "dependency";
}

/** Path order always follows the source and destination, including waits directed back to a parent. */
export function teamEdgePath(edge: TeamGraphEdge): string {
	const parent = edge.route === "parent";
	if (!parent && edge.from.y === edge.to.y) {
		const fromX = edge.from.x + TEAM_NODE_WIDTH / 2;
		const toX = edge.to.x + TEAM_NODE_WIDTH / 2;
		const bottom = edge.from.y + TEAM_NODE_HEIGHT;
		const bendY = bottom + ROW_GAP / 2;
		return `M ${fromX} ${bottom} C ${fromX} ${bendY}, ${toX} ${bendY}, ${toX} ${bottom}`;
	}
	const down = edge.to.y >= edge.from.y;
	const x1 = edge.from.x + (parent ? TEAM_NODE_WIDTH / 2 : TEAM_NODE_WIDTH);
	const y1 = edge.from.y + (parent ? (down ? TEAM_NODE_HEIGHT : 0) : TEAM_NODE_HEIGHT / 2);
	const x2 = edge.to.x + (parent ? TEAM_NODE_WIDTH / 2 : TEAM_NODE_WIDTH);
	const y2 = edge.to.y + (parent ? (down ? 0 : TEAM_NODE_HEIGHT) : TEAM_NODE_HEIGHT / 2);
	const bendX = Math.max(x1, x2) + 20;
	const middleY = (y1 + y2) / 2;
	return parent
		? `M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`
		: `M ${x1} ${y1} C ${bendX} ${y1}, ${bendX} ${y2}, ${x2} ${y2}`;
}

export function selectedTeamAgents(
	snapshot: TeamSnapshot | undefined,
	selectedSessionId: string | undefined,
): TeamAgent[] {
	if (!snapshot) return [];
	const selected = snapshot.agents.find((agent) => agent.sessionId === selectedSessionId);
	const workspaceTeamId = snapshot.teams.find((team) => team.scope === "workspace")?.teamId;
	// Keep existing per-conversation teams inspectable when they contain actual delegated work.
	const ownTeam = selected && snapshot.agents.some((agent) => agent.teamId === selected.teamId && agent.parentAgentId);
	const teamId = ownTeam ? selected.teamId : (workspaceTeamId ?? selected?.teamId);
	return teamId ? snapshot.agents.filter((agent) => agent.teamId === teamId) : [];
}

/** Each leaf owns a column; parents are centered above their children. */
export function layoutTeamGraph(agents: TeamAgent[], snapshot: TeamSnapshot) {
	const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
	const children = new Map<string, TeamAgent[]>();
	for (const agent of agents) {
		if (!agent.parentAgentId || !byId.has(agent.parentAgentId)) continue;
		const siblings = children.get(agent.parentAgentId);
		if (siblings) siblings.push(agent);
		else children.set(agent.parentAgentId, [agent]);
	}
	const nodes: TeamGraphNode[] = [];
	const positioned = new Map<string, TeamGraphNode>();
	let column = 0;
	function place(agent: TeamAgent, depth: number): TeamGraphNode {
		const node = { agent, x: 0, y: PADDING + depth * (TEAM_NODE_HEIGHT + ROW_GAP) };
		positioned.set(agent.agentId, node);
		nodes.push(node);
		const descendants = (children.get(agent.agentId) ?? [])
			.filter((child) => !positioned.has(child.agentId))
			.map((child) => place(child, depth + 1));
		if (descendants.length) {
			node.x = (descendants[0].x + descendants[descendants.length - 1].x) / 2;
		} else {
			node.x = PADDING + column * (TEAM_NODE_WIDTH + COLUMN_GAP);
			column++;
		}
		return node;
	}
	for (const agent of agents) {
		if (!agent.parentAgentId || !byId.has(agent.parentAgentId)) place(agent, 0);
	}
	// Keep disconnected snapshot entries visible without inventing a parent relationship.
	for (const agent of agents) {
		if (!positioned.has(agent.agentId)) place(agent, 0);
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const node of nodes) {
		minX = Math.min(minX, node.x);
		minY = Math.min(minY, node.y);
		maxX = Math.max(maxX, node.x + TEAM_NODE_WIDTH);
		maxY = Math.max(maxY, node.y + TEAM_NODE_HEIGHT);
	}
	const runs = new Map(snapshot.runs.map((run) => [run.runId, run]));
	const edges: TeamGraphEdge[] = [];
	const parentLinks = new Map<string, number>();
	for (const node of nodes) {
		const parent = node.agent.parentAgentId ? positioned.get(node.agent.parentAgentId) : undefined;
		if (parent) {
			parentLinks.set(JSON.stringify([parent.agent.agentId, node.agent.agentId].sort()), edges.length);
			edges.push({ id: `parent-${node.agent.agentId}`, from: parent, to: node, kind: "parent", route: "parent" });
		}
	}
	for (const node of nodes) {
		const waitingFor = new Set<string>();
		for (const runId of node.agent.currentRun?.waitingOnRunIds ?? []) {
			const run = runs.get(runId);
			if (!run || waitingFor.has(run.agentId)) continue;
			const target = positioned.get(run.agentId);
			if (!target || target === node) continue;
			waitingFor.add(run.agentId);
			const parentIndex = parentLinks.get(JSON.stringify([node.agent.agentId, target.agent.agentId].sort()));
			const parent = parentIndex === undefined ? undefined : edges[parentIndex];
			if (parentIndex !== undefined && parent?.kind === "parent") {
				edges[parentIndex] = { ...parent, from: node, to: target, kind: "waiting" };
			} else
				edges.push({
					id: JSON.stringify(["waiting", node.agent.agentId, target.agent.agentId]),
					from: node,
					to: target,
					kind: "waiting",
					route: "dependency",
				});
		}
	}
	return {
		nodes,
		edges,
		x: nodes.length ? minX - PADDING : 0,
		y: nodes.length ? minY - PADDING : 0,
		width: nodes.length ? maxX - minX + PADDING * 2 : TEAM_NODE_WIDTH + PADDING * 2,
		height: nodes.length ? maxY - minY + PADDING * 2 : TEAM_NODE_HEIGHT + PADDING * 2,
	};
}
