import type { HarnessState, SessionDescriptor, SessionRegistry } from "../session-registry.ts";
import { MANAGER_WORK_GUIDANCE, swarmBoardContext, swarmContext } from "../swarm.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function runtimeContextPlugin(getRegistry: () => SessionRegistry): ServerPlugin {
	return {
		apiVersion: 1,
		context: ({ sessionId }) => {
			const registry = getRegistry();
			return standardRuntimeSections(registry.descriptor(sessionId), registry.state, {
				goal: registry.goalEnabled,
				swarm: registry.swarmEnabled,
			});
		},
	};
}

export function standardRuntimeSections(
	descriptor: SessionDescriptor,
	state?: Pick<HarnessState, "agents" | "runs" | "teams" | "sessions">,
	modes = { goal: true, swarm: true },
): string[] {
	const sections: string[] = [];
	const swarm = modes.swarm ? descriptor.swarm : undefined;
	const member = state?.agents.find((agent) => agent.sessionId === descriptor.sessionId);
	const team = state?.teams.find((entry) => entry.teamId === member?.teamId && entry.scope === "workspace");
	if (member && team && state) {
		const manager = state.agents.find((agent) => agent.agentId === team.rootAgentId)!;
		const objective = modes.swarm
			? state.sessions.find((session) => session.sessionId === manager.sessionId)?.swarm
			: undefined;
		const specialist = member.parentAgentId === manager.agentId;
		const boardSummary = objective ? swarmBoardContext(objective) : undefined;
		sections.push(
			`Workspace team identity: ${JSON.stringify({ teamId: team.teamId, agentId: member.agentId, name: member.name, kind: member === manager ? "manager" : specialist ? "specialist" : "helper", responsibility: member.responsibility ?? member.role, managerAgentId: manager.agentId })}`,
			"This identity and role belong to the workspace, not to a single task or chat. Preserve role knowledge in this conversation; shared project files, the shared board, and handoff context are visible to teammates. Recheck current source facts instead of treating memory as authoritative.",
			member === manager
				? `You are the workspace manager even outside active Hyakki-Yako. ${swarm?.status === "active" ? "Follow the active swarm instructions below." : MANAGER_WORK_GUIDANCE}`
				: specialist
					? "Own your continuing responsibility and choose how to deliver it. Use team action=board to read/update your task status, post decisions/contracts/findings/blockers for teammates, and record independent review verdicts (you cannot approve your own task). Stay within your task's ownedPaths to avoid parallel merge conflicts. Consult existing specialists directly with team send and wait for their results when necessary. Use team handoff to transfer this assignment's ownership to an idle specialist; include facts, artifact paths, deliverable, and acceptance criteria, then end your turn without duplicating their work. You may spawn bounded helpers for focused work. Escalate conflicting priorities, changed responsibility boundaries, blockers, and important decisions to the manager. Report evidence and uncertainty, not invented success."
					: "You are a bounded helper, not a new permanent specialist. Complete your assigned work and report to its requester; do not take over the manager's role or a specialist's continuing responsibility.",
			...(objective
				? [
						`Shared objective: ${JSON.stringify({ id: objective.id, objective: objective.objective, status: objective.status, reason: objective.reason })}`,
						...(boardSummary ? [boardSummary] : []),
						"A paused, blocked, or completed objective is not an instruction to resume it. Honor explicit new requests; never wake idle teammates merely to keep them busy.",
					]
				: []),
			`Workspace roster (contact existing agentId directly): ${JSON.stringify(
				state.agents
					.filter(
						(agent) =>
							agent.teamId === team.teamId &&
							(agent.agentId === manager.agentId || agent.parentAgentId === manager.agentId),
					)
					.map((agent) => {
						const run = state.runs.findLast((entry) => entry.agentId === agent.agentId);
						return {
							agentId: agent.agentId,
							name: agent.name,
							responsibility: agent.responsibility ?? agent.role,
							state: !run || run.status === "completed" ? "awaiting_assignment" : run.status,
							...(run ? { runId: run.runId } : {}),
						};
					}),
			)}`,
		);
	}
	if (modes.goal && descriptor.goal) {
		const { id, objective, status, reason } = descriptor.goal;
		sections.push(
			[
				`Goal mode: ${JSON.stringify({ id, objective, status, ...(reason ? { reason } : {}) })}`,
				"Only while active, continue pursuing the objective after ordinary responses.",
				"Never treat assistant prose as completion. Use goal complete or block with a concrete reason.",
				"User instructions and subagent completion context take precedence over autonomous continuation.",
				"Only the user may resume a paused or blocked goal.",
			].join("\n"),
		);
	}
	if (swarm) {
		sections.push(swarmContext(swarm));
		if (!team && member && state)
			sections.push(
				`Current direct reports: ${JSON.stringify(state.agents.filter((agent) => agent.parentAgentId === member.agentId).map((agent) => ({ agentId: agent.agentId, name: agent.name, role: agent.role })))}`,
			);
	}
	return sections;
}
