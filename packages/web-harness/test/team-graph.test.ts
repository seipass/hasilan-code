import { describe, expect, it } from "vitest";
import { layoutTeamGraph, selectedTeamAgents, TEAM_NODE_HEIGHT, TEAM_NODE_WIDTH } from "../src/client/team-graph.ts";
import type { Run, TeamAgent, TeamSnapshot } from "../src/client/types.ts";

function agent(agentId: string, parentAgentId?: string, teamId = "team-a"): TeamAgent {
	return {
		agentId,
		parentAgentId,
		teamId,
		sessionId: `session-${agentId}`,
		name: agentId,
		role: parentAgentId ? "worker" : "root",
	};
}

function snapshot(agents: TeamAgent[], runs: Run[] = []): TeamSnapshot {
	return { teams: [], agents, runs };
}

describe("team graph scope", () => {
	const root = agent("root");
	const child = agent("child", root.agentId);
	const other = agent("other", undefined, "team-b");
	const state = snapshot([root, child, other]);

	it("shows only the selected conversation's team, including when a child conversation is selected", () => {
		expect(selectedTeamAgents(state, root.sessionId)).toEqual([root, child]);
		expect(selectedTeamAgents(state, child.sessionId)).toEqual([root, child]);
		expect(selectedTeamAgents(state, other.sessionId)).toEqual([other]);
	});

	it("does not fall back to the previous or all teams for a new, missing, or unloaded conversation", () => {
		expect(selectedTeamAgents(state, undefined)).toEqual([]);
		expect(selectedTeamAgents(state, "unknown-session")).toEqual([]);
		expect(selectedTeamAgents(undefined, root.sessionId)).toEqual([]);
	});
});

describe("team graph layout", () => {
	it("places parallel children side by side, parents centered above them, and grandchildren on a deeper row", () => {
		const root = agent("root");
		const first = agent("first", root.agentId);
		const second = agent("second", root.agentId);
		const grandchild = agent("grandchild", first.agentId);
		const state = snapshot([root, first, second, grandchild]);
		const graph = layoutTeamGraph(state.agents, state);
		const [rootNode, firstNode, grandchildNode, secondNode] = graph.nodes;
		expect(firstNode.y).toBe(secondNode.y);
		expect(secondNode.x - firstNode.x).toBeGreaterThan(TEAM_NODE_WIDTH);
		expect(rootNode.x).toBe((firstNode.x + secondNode.x) / 2);
		expect(firstNode.y - rootNode.y).toBeGreaterThan(TEAM_NODE_HEIGHT);
		expect(grandchildNode.y - firstNode.y).toBeGreaterThan(TEAM_NODE_HEIGHT);
		expect(graph.edges.map((edge) => [edge.from.agent.agentId, edge.to.agent.agentId, edge.kind])).toEqual([
			["root", "first", "parent"],
			["first", "grandchild", "parent"],
			["root", "second", "parent"],
		]);
	});

	it("draws real current waits separately, deduplicating agents and ignoring unresolved or out-of-team runs", () => {
		const root = agent("root");
		const child = agent("child", root.agentId);
		const runs: Run[] = [
			{
				runId: "root-run",
				agentId: root.agentId,
				task: "Coordinate",
				status: "waiting",
				waitingOnRunIds: ["child-run", "child-old", "missing", "other-run"],
			},
			{ runId: "child-run", agentId: child.agentId, task: "Implement", status: "running" },
			{ runId: "child-old", agentId: child.agentId, task: "Research", status: "completed" },
			{ runId: "other-run", agentId: "other-team-agent", task: "Other", status: "running" },
		];
		root.currentRun = runs[0];
		child.currentRun = runs[1];
		const state = snapshot([root, child], runs);
		const graph = layoutTeamGraph(state.agents, state);
		expect(graph.edges.map((edge) => edge.kind)).toEqual(["waiting", "parent"]);
		const wait = graph.edges.find((edge) => edge.kind === "waiting");
		expect(wait?.from.agent.agentId).toBe(root.agentId);
		expect(wait?.to.agent.agentId).toBe(child.agentId);

		root.latestRun = { ...runs[0], status: "completed" };
		root.currentRun = undefined;
		expect(layoutTeamGraph(state.agents, state).edges.map((edge) => edge.kind)).toEqual(["parent"]);
	});

	it("attaches parent and waiting edges to dragged positions and fits negative and distant coordinates", () => {
		const root = agent("root");
		const child = agent("child", root.agentId);
		const run: Run = { runId: "child-run", agentId: child.agentId, task: "Implement", status: "running" };
		root.currentRun = {
			runId: "root-run",
			agentId: root.agentId,
			task: "Coordinate",
			status: "waiting",
			waitingOnRunIds: [run.runId],
		};
		const state = snapshot([root, child], [run]);
		const positions = new Map([
			[root.agentId, { x: -640, y: -320 }],
			[child.agentId, { x: 1_600, y: 1_200 }],
			["another-team", { x: 50_000, y: 50_000 }],
		]);
		const graph = layoutTeamGraph(state.agents, state, positions);
		const [rootNode, childNode] = graph.nodes;
		expect({ x: rootNode.x, y: rootNode.y }).toEqual(positions.get(root.agentId));
		expect({ x: childNode.x, y: childNode.y }).toEqual(positions.get(child.agentId));
		expect(graph.edges).toHaveLength(2);
		for (const edge of graph.edges) {
			expect(edge.from).toBe(rootNode);
			expect(edge.to).toBe(childNode);
		}
		for (const node of graph.nodes) {
			expect(node.x).toBeGreaterThan(graph.x);
			expect(node.y).toBeGreaterThan(graph.y);
			expect(node.x + TEAM_NODE_WIDTH).toBeLessThan(graph.x + graph.width);
			expect(node.y + TEAM_NODE_HEIGHT).toBeLessThan(graph.y + graph.height);
		}
		expect(graph.width).toBe(1_600 + TEAM_NODE_WIDTH + 640 + 56);
		expect(graph.height).toBe(1_200 + TEAM_NODE_HEIGHT + 320 + 56);
	});

	it("preserves a custom position through refreshed status and new siblings, and restores automatic layout without it", () => {
		const root = agent("root");
		const child = agent("child", root.agentId);
		const state = snapshot([root, child]);
		const positions = new Map([[child.agentId, { x: -120, y: 720 }]]);
		const before = layoutTeamGraph(state.agents, state, positions);
		const refreshedChild: TeamAgent = {
			...child,
			currentRun: { runId: "child-run", agentId: child.agentId, task: "Fresh task", status: "running" },
		};
		const refreshed = snapshot([{ ...root }, agent("new-sibling", root.agentId), refreshedChild]);
		const graph = layoutTeamGraph(refreshed.agents, refreshed, positions);
		const node = graph.nodes.find((entry) => entry.agent.agentId === child.agentId);
		expect(node?.agent).toBe(refreshedChild);
		expect({ x: node?.x, y: node?.y }).toEqual(positions.get(child.agentId));
		expect(graph.edges.find((edge) => edge.to === node)?.to).toBe(node);
		expect(before.nodes.find((entry) => entry.agent.agentId === child.agentId)?.agent).toBe(child);
		expect(positions.get(child.agentId)).toEqual({ x: -120, y: 720 });
		expect(layoutTeamGraph(state.agents, state, new Map())).toEqual(layoutTeamGraph(state.agents, state));
	});

	it("keeps large and deep teams within scrollable bounds without overlapping nodes on the same row", () => {
		const agents = [agent("root")];
		for (let index = 0; index < 30; index++) agents.push(agent(`parallel-${index}`, "root"));
		let parentId = "parallel-0";
		for (let depth = 0; depth < 8; depth++) {
			const child = agent(`depth-${depth}`, parentId);
			agents.push(child);
			parentId = child.agentId;
		}
		const state = snapshot(agents);
		const graph = layoutTeamGraph(agents, state);
		expect(graph.nodes).toHaveLength(agents.length);
		expect(graph.edges).toHaveLength(agents.length - 1);
		for (const node of graph.nodes) {
			expect(node.x).toBeGreaterThanOrEqual(0);
			expect(node.y).toBeGreaterThanOrEqual(0);
			expect(node.x + TEAM_NODE_WIDTH).toBeLessThanOrEqual(graph.width);
			expect(node.y + TEAM_NODE_HEIGHT).toBeLessThanOrEqual(graph.height);
			for (const other of graph.nodes) {
				if (node === other || node.y !== other.y) continue;
				expect(Math.abs(node.x - other.x)).toBeGreaterThanOrEqual(TEAM_NODE_WIDTH);
			}
		}
	});

	it("keeps a disconnected snapshot node visible without fabricating a parent edge", () => {
		const root = agent("root");
		const orphan = agent("orphan", "not-in-snapshot");
		const state = snapshot([root, orphan]);
		const graph = layoutTeamGraph(state.agents, state);
		expect(graph.nodes.map((node) => node.agent.agentId)).toEqual(["root", "orphan"]);
		expect(graph.edges).toEqual([]);
	});
});
