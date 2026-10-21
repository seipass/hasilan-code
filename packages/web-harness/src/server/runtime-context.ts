import type { AgentMessage } from "@hasilan-code/pi-agent-core";
import type { SessionManager } from "@hasilan-code/pi-coding-agent";
import type { HarnessState, SessionDescriptor } from "./session-registry.ts";
import { swarmContext } from "./swarm.ts";

const CONTEXT_TYPE = "harness-runtime-context";

/** Runs after SDK request preparation, so compaction and restored branches are already reflected. */
export function appendRuntimeContext(
	manager: SessionManager,
	messages: AgentMessage[],
	descriptor: SessionDescriptor,
	state?: Pick<HarnessState, "agents" | "runs" | "teams" | "sessions">,
): AgentMessage[] {
	const sections: string[] = [];
	const member = state?.agents.find((agent) => agent.sessionId === descriptor.sessionId);
	const team = state?.teams.find((entry) => entry.teamId === member?.teamId && entry.scope === "workspace");
	if (member && team && state) {
		const manager = state.agents.find((agent) => agent.agentId === team.rootAgentId)!;
		const objective = state.sessions.find((session) => session.sessionId === manager.sessionId)?.swarm;
		const specialist = member.parentAgentId === manager.agentId;
		sections.push(
			`Workspace team identity: ${JSON.stringify({ teamId: team.teamId, agentId: member.agentId, name: member.name, kind: member === manager ? "manager" : specialist ? "specialist" : "helper", responsibility: member.responsibility ?? member.role, managerAgentId: manager.agentId })}`,
			"This identity and role belong to the workspace, not to a single task or chat. Preserve role knowledge in this conversation; shared project files and handoff context are visible to teammates. Recheck current source facts instead of treating memory as authoritative.",
			member === manager
				? "You are the manager even outside active Hyakki-Yako. Own goals, priorities, responsibility boundaries, coordination, and final acceptance. Delegate all implementation and verification; never implement or run implementation commands yourself. Assign outcomes and acceptance criteria, not every execution step. Routine specialist coordination does not need to route through you."
				: specialist
					? "Own your continuing responsibility and choose how to deliver it. Consult existing specialists directly with team send and wait for their results when necessary. Use team handoff to transfer this assignment's ownership to an idle specialist; include facts, artifact paths, deliverable, and acceptance criteria, then end your turn without duplicating their work. You may spawn bounded helpers for focused work. Escalate conflicting priorities, changed responsibility boundaries, blockers, and important decisions to the manager. Report evidence and uncertainty, not invented success."
					: "You are a bounded helper, not a new permanent specialist. Complete your assigned work and report to its requester; do not take over the manager's role or a specialist's continuing responsibility.",
			...(objective
				? [
						`Shared objective: ${JSON.stringify({ id: objective.id, objective: objective.objective, status: objective.status, reason: objective.reason })}`,
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
	if (descriptor.goal) {
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
	if (descriptor.swarm) {
		sections.push(swarmContext(descriptor.swarm));
		if (!team && member && state)
			sections.push(
				`Current direct reports: ${JSON.stringify(state.agents.filter((agent) => agent.parentAgentId === member.agentId).map((agent) => ({ agentId: agent.agentId, name: agent.name, role: agent.role })))}`,
			);
	}
	const previous = messages.findLast((message) => message.role === "custom" && message.customType === CONTEXT_TYPE);
	if (sections.length === 0 && !previous) return messages;
	const content = [
		"Current runtime context. This snapshot supersedes all earlier runtime-context snapshots.",
		sections.length
			? sections.join("\n\n")
			: "No Goal or Hyakki-Yako mode is enabled. Earlier mode instructions no longer apply.",
	].join("\n\n");
	if (previous && "content" in previous && previous.content === content) return messages;
	const entryId = manager.appendCustomMessageEntry(CONTEXT_TYPE, content, false);
	const entry = manager.getEntry(entryId);
	if (!entry) throw new Error("Runtime context was not persisted");
	return [
		...messages,
		{ role: "custom", customType: CONTEXT_TYPE, content, display: false, timestamp: Date.parse(entry.timestamp) },
	];
}
