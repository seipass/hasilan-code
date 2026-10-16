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
	from: TeamGraphNode;
	to: TeamGraphNode;
	kind: "parent" | "waiting";
}

export function selectedTeamAgents(
	snapshot: TeamSnapshot | undefined,
	selectedSessionId: string | undefined,
): TeamAgent[] {
	if (!snapshot || !selectedSessionId) return [];
	const selected = snapshot.agents.find((agent) => agent.sessionId === selectedSessionId);
	return selected ? snapshot.agents.filter((agent) => agent.teamId === selected.teamId) : [];
}

/** Each leaf owns a column; saved positions override the automatic layout. */
export function layoutTeamGraph(
	agents: TeamAgent[],
	snapshot: TeamSnapshot,
	positions?: ReadonlyMap<string, { x: number; y: number }>,
) {
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
		const saved = positions?.get(node.agent.agentId);
		if (saved) {
			node.x = saved.x;
			node.y = saved.y;
		}
		minX = Math.min(minX, node.x);
		minY = Math.min(minY, node.y);
		maxX = Math.max(maxX, node.x + TEAM_NODE_WIDTH);
		maxY = Math.max(maxY, node.y + TEAM_NODE_HEIGHT);
	}
	const runs = new Map(snapshot.runs.map((run) => [run.runId, run]));
	const edges: TeamGraphEdge[] = [];
	for (const node of nodes) {
		const parent = node.agent.parentAgentId ? positioned.get(node.agent.parentAgentId) : undefined;
		if (parent) edges.push({ from: parent, to: node, kind: "parent" });
		const waitingFor = new Set<string>();
		for (const runId of node.agent.currentRun?.waitingOnRunIds ?? []) {
			const run = runs.get(runId);
			if (!run || waitingFor.has(run.agentId)) continue;
			const target = positioned.get(run.agentId);
			if (!target || target === node) continue;
			waitingFor.add(run.agentId);
			edges.push({ from: node, to: target, kind: "waiting" });
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
