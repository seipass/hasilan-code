import { record } from "../Content.tsx";
import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

interface Entry {
	id?: unknown;
	title?: unknown;
	name?: unknown;
	agentId?: unknown;
	status?: unknown;
	result?: unknown;
	error?: unknown;
	description?: unknown;
	task?: unknown;
	dependsOn?: unknown;
	ownedPaths?: unknown;
}

/**
 * team: the action decides the useful shape. spawn lists what is about to run, wait
 * lists what each agent returned, send shows the message. Results stay collapsed
 * when they are long.
 */
export function teamView({ input, details }: ToolDetails): ToolView {
	const action = typeof input?.action === "string" ? input.action : undefined;
	const op = typeof input?.op === "string" ? input.op : undefined;
	if (action === "board") {
		const boardTasks = details && Array.isArray(details.tasks) ? (details.tasks as Entry[]).filter((entry) => record(entry)) : [];
		const boardChecks = details && Array.isArray(details.checks) ? (details.checks as Entry[]).filter((entry) => record(entry)) : [];
		const boardNotes = details && Array.isArray(details.notes) ? (details.notes as Entry[]).filter((entry) => record(entry)) : [];
		const singleCheck = details && record(details.check) ? (details.check as Record<string, unknown>) : undefined;
		const singleReview = details && record(details.review) ? (details.review as Record<string, unknown>) : undefined;
		const singleTask = details && record(details.task) ? (details.task as Record<string, unknown>) : details && typeof details.id === "string" && typeof details.title === "string" && typeof details.status === "string" ? details : undefined;
		const output = typeof details?.output === "string" ? details.output : undefined;
		return {
			meta: (
				<MetaChips
					items={[
						"board",
						op,
						typeof input?.taskId === "string" && input.taskId,
						typeof singleReview?.verdict === "string" && singleReview.verdict,
						typeof singleCheck?.status === "string" && singleCheck.status,
						typeof singleCheck?.exitCode === "number" && `exit ${singleCheck.exitCode}`,
						boardTasks.length > 0 && `${boardTasks.length} tasks`,
						boardChecks.length > 0 && `${boardChecks.length} checks`,
						boardNotes.length > 0 && `${boardNotes.length} notes`,
					]}
				/>
			),
			body: (
				<>
					{op === "post" && typeof input?.title === "string" && (
						<blockquote className="tool-message">
							<strong>[{typeof input?.kind === "string" ? input.kind : "note"}] {input.title}</strong>
							{typeof input?.body === "string" && `\n${input.body}`}
						</blockquote>
					)}
					{op === "review" && typeof input?.summary === "string" && (
						<blockquote className="tool-message">{input.summary}</blockquote>
					)}
					{singleCheck && (
						<div className="tool-section">
							<p>
								<strong>{typeof singleCheck.name === "string" ? singleCheck.name : "check"}</strong>
								{typeof singleCheck.command === "string" ? ` · ${singleCheck.command}` : ""}
							</p>
							{output && (
								<details className="tool-secondary tool-section">
									<summary>検証出力を表示</summary>
									<pre className="tool-code">{output}</pre>
								</details>
							)}
						</div>
					)}
					{op === "task" && singleTask && (
						<p>
							<strong>{String(singleTask.id)}</strong>: {String(singleTask.title)} ({String(singleTask.status)}
							{typeof singleTask.ownerName === "string" ? ` · ${singleTask.ownerName}` : ""})
						</p>
					)}
					{op === "plan" && boardTasks.length > 0 && (
						<ul className="tool-team-list">
							{boardTasks.map((task, index) => (
								<li key={index}>
									<div className="tool-team-heading">
										<span className="tool-team-name">
											{typeof task.id === "string" ? `${task.id} ` : ""}
											{typeof task.title === "string" ? task.title : `Task ${index + 1}`}
										</span>
										{typeof task.status === "string" && <span className="tool-team-status">{task.status}</span>}
									</div>
									{Array.isArray(task.ownedPaths) && task.ownedPaths.length > 0 && (
										<span className="tool-team-depends">
											paths: {task.ownedPaths.filter((entry): entry is string => typeof entry === "string").join(", ")}
										</span>
									)}
								</li>
							))}
						</ul>
					)}
				</>
			),
			handlesResult: true,
		};
	}
	if (action === "work") {
		const stale = details && Array.isArray(details.staleAgents)
			? (details.staleAgents as Entry[]).filter((entry) => record(entry))
			: [];
		const diff = typeof details?.diff === "string" ? details.diff : undefined;
		return {
			meta: (
				<MetaChips
					items={[
						"work",
						op,
						typeof input?.agentId === "string" && input.agentId,
						typeof details?.status === "string" && details.status,
						details?.changed === true && "changed",
						details?.updated === true && "synced",
						stale.length > 0 && `${stale.length} stale`,
					]}
				/>
			),
			body: (
				<>
					{stale.length > 0 && (
						<p className="tool-team-depends">
							同期推奨: {stale.map((entry) => (typeof entry.name === "string" ? entry.name : String(entry.agentId ?? ""))).join(", ")}
						</p>
					)}
					{diff && (
						<details className="tool-secondary tool-section">
							<summary>差分を表示</summary>
							<pre className="tool-code">{diff}</pre>
						</details>
					)}
				</>
			),
			handlesResult: true,
		};
	}
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
