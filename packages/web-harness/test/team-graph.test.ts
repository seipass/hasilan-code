import { describe, expect, it } from "vitest";
import {
	layoutTeamGraph,
	selectedTeamAgents,
	TEAM_NODE_HEIGHT,
	TEAM_NODE_WIDTH,
	teamEdgePath,
} from "../src/client/team-graph.ts";
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

	it("turns an existing parent edge into one waiting edge, deduplicating runs and ignoring unresolved targets", () => {
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
		expect(graph.edges.map((edge) => edge.kind)).toEqual(["waiting"]);
		const wait = graph.edges.find((edge) => edge.kind === "waiting");
		expect(wait?.from.agent.agentId).toBe(root.agentId);
		expect(wait?.to.agent.agentId).toBe(child.agentId);

		root.latestRun = { ...runs[0], status: "completed" };
		root.currentRun = undefined;
		const settled = layoutTeamGraph(state.agents, state).edges;
		expect(settled.map((edge) => edge.kind)).toEqual(["parent"]);
		expect(settled[0].id).toBe(wait?.id);
		expect(teamEdgePath(settled[0])).toBe(teamEdgePath(graph.edges[0]));
	});

	it("changes only connections the agent is actually waiting for", () => {
		const root = agent("root");
		const first = agent("first", root.agentId);
		const second = agent("second", root.agentId);
		const run: Run = { runId: "first-run", agentId: first.agentId, task: "Work", status: "running" };
		root.currentRun = {
			runId: "root-run",
			agentId: root.agentId,
			task: "Wait",
			status: "waiting",
			waitingOnRunIds: [run.runId],
		};
		const graph = layoutTeamGraph([root, first, second], snapshot([root, first, second], [run]));
		expect(graph.edges.map((edge) => [edge.to.agent.agentId, edge.kind])).toEqual([
			["first", "waiting"],
			["second", "parent"],
		]);
		expect(graph.edges.filter((edge) => edge.to.agent.agentId === "first")).toHaveLength(1);
	});

	it("keeps a cross-branch wait directed from the waiter to its dependency", () => {
		const root = agent("root");
		const first = agent("first", root.agentId);
		const second = agent("second", root.agentId);
		const dependency: Run = { runId: "dependency", agentId: second.agentId, task: "Work", status: "running" };
		first.currentRun = {
			runId: "waiter",
			agentId: first.agentId,
			task: "Wait",
			status: "waiting",
			waitingOnRunIds: [dependency.runId],
		};
		const graph = layoutTeamGraph([root, first, second], snapshot([root, first, second], [dependency]));
		expect(graph.edges.filter((edge) => edge.kind === "parent")).toHaveLength(2);
		const wait = graph.edges.find((edge) => edge.kind === "waiting");
		if (!wait) throw new Error("Missing waiting connection");
		expect(wait.route).toBe("dependency");
		expect(teamEdgePath(wait)).toMatch(
			new RegExp(`^M ${wait.from.x + TEAM_NODE_WIDTH / 2} ${wait.from.y + TEAM_NODE_HEIGHT} C `),
		);
		expect(teamEdgePath(wait)).toMatch(
			new RegExp(`${wait.to.x + TEAM_NODE_WIDTH / 2} ${wait.to.y + TEAM_NODE_HEIGHT}$`),
		);
	});

	it("reuses the parent connection for a child waiting on its parent and reverses the path direction", () => {
		const root = agent("root");
		const child = agent("child", root.agentId);
		const parentRun: Run = { runId: "parent-run", agentId: root.agentId, task: "Work", status: "running" };
		child.currentRun = {
			runId: "child-run",
			agentId: child.agentId,
			task: "Wait",
			status: "waiting",
			waitingOnRunIds: [parentRun.runId],
		};
		const graph = layoutTeamGraph([root, child], snapshot([root, child], [parentRun]));
		expect(graph.edges).toHaveLength(1);
		const edge = graph.edges[0];
		expect(edge).toMatchObject({
			kind: "waiting",
			route: "parent",
			from: { agent: { agentId: "child" } },
			to: { agent: { agentId: "root" } },
		});
		expect(teamEdgePath(edge)).toMatch(new RegExp(`^M ${edge.from.x + TEAM_NODE_WIDTH / 2} ${edge.from.y} C `));
		expect(teamEdgePath(edge)).toMatch(
			new RegExp(`${edge.to.x + TEAM_NODE_WIDTH / 2} ${edge.to.y + TEAM_NODE_HEIGHT}$`),
		);
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
