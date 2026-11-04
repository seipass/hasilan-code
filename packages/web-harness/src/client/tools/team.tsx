import { record } from "../Content.tsx";
import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

interface Entry {
	name?: unknown;
	agentId?: unknown;
	status?: unknown;
	result?: unknown;
	error?: unknown;
	description?: unknown;
	task?: unknown;
	dependsOn?: unknown;
}

/**
 * team: the action decides the useful shape. spawn lists what is about to run, wait
 * lists what each agent returned, send shows the message. Results stay collapsed
 * when they are long.
 */
export function teamView({ input, details }: ToolDetails): ToolView {
	const action = typeof input?.action === "string" ? input.action : undefined;
	const timedOut = details?.timedOut === true;
	const tasks = Array.isArray(input?.tasks) ? input.tasks.filter((task) => record(task)) as Entry[] : [];
	const agents = details && Array.isArray(details.agents) ? (details.agents as Entry[]).filter((entry) => record(entry)) : [];
	const runs = details && Array.isArray(details.runs) ? (details.runs as Entry[]).filter((entry) => record(entry)) : [];
	const profiles = details && Array.isArray(details.details) ? (details.details as Entry[]).filter((entry) => record(entry)) : [];
	const entries = runs.length ? runs : agents.length ? agents : profiles;
	const message = typeof input?.message === "string" ? input.message : undefined;
	return {
		meta: (
			<MetaChips
				items={[
					action,
					tasks.length > 0 && `${tasks.length} tasks`,
					entries.length > 0 && `${entries.length} agents`,
					action === "wait" && (timedOut ? "timed out" : "completed"),
					typeof details?.disposition === "string" && details.disposition,
					typeof details?.status === "string" && details.status,
				]}
			/>
		),
		body: (
			<>
				{message && <blockquote className="tool-message">{message}</blockquote>}
				{action === "spawn" && tasks.length > 0 && (
					<ul className="tool-team-list">
						{tasks.map((task, index) => {
							const depends = Array.isArray(task.dependsOn) ? task.dependsOn.filter((entry): entry is string => typeof entry === "string") : [];
							return (
								<li key={index}>
									<span className="tool-team-name">{typeof task.name === "string" ? task.name : `Task ${index + 1}`}</span>
									{typeof task.task === "string" && <p>{task.task}</p>}
									{depends.length > 0 && <span className="tool-team-depends">after {depends.join(", ")}</span>}
								</li>
							);
						})}
					</ul>
				)}
				{action !== "spawn" && entries.length > 0 && (
					<ul className="tool-team-list">
						{entries.map((entry, index) => {
							const name = typeof entry.name === "string" ? entry.name : typeof entry.agentId === "string" ? entry.agentId : `Entry ${index + 1}`;
							const result = typeof entry.result === "string" ? entry.result : undefined;
							const firstLine = result?.split(/\r?\n/).find((line) => line.trim())?.trim();
							return (
								<li key={index} data-failed={typeof entry.error === "string" || undefined}>
									<div className="tool-team-heading">
										<span className="tool-team-name">{name}</span>
										{typeof entry.status === "string" && <span className="tool-team-status">{entry.status}</span>}
									</div>
									{typeof entry.description === "string" && <p>{entry.description}</p>}
									{firstLine && (result && result.length > 160
										? <details className="tool-secondary tool-section"><summary>{firstLine.slice(0, 120)}…</summary><pre className="tool-code">{result}</pre></details>
										: <p>{firstLine}</p>)}
									{typeof entry.error === "string" && <p className="tool-error">{entry.error}</p>}
								</li>
							);
						})}
					</ul>
				)}
			</>
		),
		handlesResult: true,
	};
}
