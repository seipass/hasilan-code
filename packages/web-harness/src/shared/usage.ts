export interface ModelUsage {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	responses: number;
	failures: number;
	auxiliary: number;
}

export function aggregateUsage(groups: readonly (readonly ModelUsage[])[]): ModelUsage[] {
	const models = new Map<string, ModelUsage>();
	for (const group of groups)
		for (const usage of group) {
			const key = JSON.stringify([usage.provider, usage.model]);
			const total = models.get(key);
			if (!total) {
				models.set(key, { ...usage });
				continue;
			}
			total.input += usage.input;
			total.output += usage.output;
			total.cacheRead += usage.cacheRead;
			total.cacheWrite += usage.cacheWrite;
			total.cost += usage.cost;
			total.responses += usage.responses;
			total.failures += usage.failures;
			total.auxiliary += usage.auxiliary;
		}
	return [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

/** Input is uncached input in Pi usage, not the whole prompt. */
export function cacheReadPercent(usage: Pick<ModelUsage, "input" | "cacheRead" | "cacheWrite">): number | null {
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	return input > 0 ? (usage.cacheRead / input) * 100 : null;
}
