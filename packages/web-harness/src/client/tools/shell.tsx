import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

/**
 * Shell output reads as one unit: the command that ran, then its output immediately
 * below with no gap, then the exit status. Failures tint the block instead of adding
 * a separate error card.
 */
export function shellView({ input, details, result, text, status }: ToolDetails): ToolView {
	const command = typeof input?.command === "string" ? input.command : undefined;
	const exitCode = result?.exit_code;
	const seconds = result?.wall_time_seconds;
	const truncated = result?.truncated === true;
	const output = typeof result?.output === "string" ? result.output : text;
	const failed = status === "error" || (typeof exitCode === "number" && exitCode !== 0);
	const hasOutput = output.trim().length > 0;
	if (!command) return { meta: <MetaChips items={[typeof exitCode === "number" && `exit ${exitCode}`, typeof seconds === "number" && `${seconds}s`]} />, handlesResult: true };
	return {
		meta: (
			<MetaChips
				items={[
					typeof exitCode === "number" && `exit ${exitCode}`,
					typeof seconds === "number" && `${seconds}s`,
					truncated && "truncated",
				]}
			/>
		),
		body: (
			<div className="tool-shell" data-failed={failed || undefined} data-empty={!hasOutput || undefined}>
				<div className="tool-shell-command"><span aria-hidden="true">$</span><code>{command}</code></div>
				{hasOutput ? (
					<pre className="tool-shell-output">{output}</pre>
				) : (
					<p className="tool-shell-empty">{status === "running" ? "Running…" : "No output"}</p>
				)}
			</div>
		),
		handlesResult: true,
	};
}
