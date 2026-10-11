import type { SpawnTask } from "./team-manager.ts";

export interface WorkflowTask extends SpawnTask {
	dependsOn?: string[];
}

/** Validate the entire graph before any child session is created. */
export function validateWorkflow(tasks: readonly WorkflowTask[]): void {
	if (tasks.length === 0 || tasks.length > 32) throw new Error("Workflow requires 1..32 tasks");
	const byName = new Map<string, WorkflowTask>();
	for (const task of tasks) {
		if (!task.name.trim() || !task.task.trim()) throw new Error("Workflow task name and prompt must not be empty");
		if (byName.has(task.name)) throw new Error(`Duplicate workflow task: ${task.name}`);
		byName.set(task.name, task);
	}
	for (const task of tasks) {
		const visited = new Set<string>();
		for (const dependency of task.dependsOn ?? []) {
			if (!byName.has(dependency)) throw new Error(`Unknown workflow dependency: ${dependency}`);
			if (visited.has(dependency)) throw new Error(`Duplicate workflow dependency: ${dependency}`);
			visited.add(dependency);
		}
	}
	const complete = new Set<string>();
	const visiting = new Set<string>();
	function visit(name: string): void {
		if (complete.has(name)) return;
		if (visiting.has(name)) throw new Error(`Workflow dependency cycle: ${name}`);
		visiting.add(name);
		for (const dependency of byName.get(name)?.dependsOn ?? []) visit(dependency);
		visiting.delete(name);
		complete.add(name);
	}
	for (const task of tasks) visit(task.name);
}
