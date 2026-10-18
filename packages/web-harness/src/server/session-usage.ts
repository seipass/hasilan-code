import type { Usage } from "@hasilan-code/pi-ai";
import type { SessionManager } from "@hasilan-code/pi-coding-agent";
import { aggregateUsage, type ModelUsage } from "../shared/usage.ts";

/** Billing covers all entries, including compacted history, without recounting stream deltas. */
export class SessionUsage {
	private readonly manager: SessionManager;
	private processed = 0;
	private models: ModelUsage[] = [];
	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	snapshot(): ModelUsage[] {
		const count = this.manager.getEntryCount();
		if (count === this.processed) return this.models;
		const entries = this.manager.getEntries();
		const added: ModelUsage[] = [];
		for (let index = this.processed; index < entries.length; index++) {
			const entry = entries[index];
			let usage: Usage | undefined;
			let provider = "";
			let model = "補助処理（モデル不明）";
			let responses = 0;
			let failures = 0;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const message = entry.message;
				usage = message.usage;
				provider = message.provider;
				model = message.responseModel ?? message.model;
				responses = 1;
				failures = message.stopReason === "error" || message.stopReason === "aborted" ? 1 : 0;
			} else if (entry.type === "usage") {
				usage = entry.usage;
				provider = entry.provider;
				model = entry.model;
			} else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
			else if (entry.type === "message" && entry.message.role === "toolResult") usage = entry.message.usage;
			if (usage)
				added.push({
					provider,
					model,
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cost: usage.cost.total,
					responses,
					failures,
					auxiliary: responses ? 0 : 1,
				});
		}
		this.models = aggregateUsage([this.models, added]);
		this.processed = entries.length;
		return this.models;
	}
}
