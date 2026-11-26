import type { Usage } from "@hasilan-code/pi-ai";
import type { SessionManager } from "@hasilan-code/pi-coding-agent";
import { SESSION_IMPORT_MESSAGE_API } from "../shared/session-import.ts";
import { aggregateUsage, type DailyUsagePoint, type ModelUsage } from "../shared/usage.ts";

interface TimedUsageRecord {
	timestampMs: number;
	provider: string;
	model: string;
	tokens: number;
}

const MAX_RECENT_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

function entryDateKey(timestamp: string | number | undefined): string | undefined {
	if (timestamp === undefined) return undefined;
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return undefined;
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function entryTimestampMs(timestamp: string | number | undefined): number | undefined {
	if (timestamp === undefined) return undefined;
	const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Billing covers all entries, including compacted history, without recounting stream deltas. */
export class SessionUsage {
	private readonly manager: SessionManager;
	private processed = 0;
	private models: ModelUsage[] = [];
	private readonly daily = new Map<string, DailyUsagePoint>();
	private readonly recent: TimedUsageRecord[] = [];
	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	private sync(): void {
		const count = this.manager.getEntryCount();
		if (count === this.processed) return;
		const entries = this.manager.getEntries();
		const added: ModelUsage[] = [];
		const cutoffMs = Date.now() - MAX_RECENT_WINDOW_MS;
		for (let index = this.processed; index < entries.length; index++) {
			const entry = entries[index];
			let usage: Usage | undefined;
			let provider = "";
			let model = "補助処理（モデル不明）";
			let responses = 0;
			let failures = 0;
			let timestamp: string | number | undefined = entry.timestamp;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const message = entry.message;
				if (message.api === SESSION_IMPORT_MESSAGE_API) continue;
				usage = message.usage;
				provider = message.provider;
				model = message.responseModel ?? message.model;
				responses = 1;
				failures = message.stopReason === "error" || message.stopReason === "aborted" ? 1 : 0;
				timestamp = message.timestamp ?? entry.timestamp;
			} else if (entry.type === "usage") {
				usage = entry.usage;
				provider = entry.provider;
				model = entry.model;
			} else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
			else if (entry.type === "message" && entry.message.role === "toolResult") {
				usage = entry.message.usage;
				timestamp = entry.message.timestamp ?? entry.timestamp;
			}
			if (!usage) continue;
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
			const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			const date = entryDateKey(timestamp);
			if (date) {
				const bucket = this.daily.get(date);
				if (bucket) {
					bucket.totalTokens += totalTokens;
					bucket.cachedTokens += usage.cacheRead;
					bucket.cost += usage.cost.total;
					bucket.responses += responses;
				} else {
					this.daily.set(date, {
						date,
						totalTokens,
						cachedTokens: usage.cacheRead,
						cost: usage.cost.total,
						responses,
					});
				}
			}
			const ms = entryTimestampMs(timestamp);
			if (ms !== undefined && ms >= cutoffMs && totalTokens > 0) {
				this.recent.push({ timestampMs: ms, provider, model, tokens: totalTokens });
			}
		}
		this.models = aggregateUsage([this.models, added]);
		this.processed = entries.length;
	}

	snapshot(): ModelUsage[] {
		this.sync();
		return this.models;
	}

	dailySnapshot(): DailyUsagePoint[] {
		this.sync();
		return [...this.daily.values()].sort((a, b) => a.date.localeCompare(b.date));
	}

	windowTokens(sinceMs: number): {
		totalTokens: number;
		byModel: Map<string, { provider: string; model: string; tokens: number }>;
	} {
		this.sync();
		let totalTokens = 0;
		const byModel = new Map<string, { provider: string; model: string; tokens: number }>();
		for (const record of this.recent) {
			if (record.timestampMs < sinceMs) continue;
			totalTokens += record.tokens;
			const key = `${record.provider}\0${record.model}`;
			const existing = byModel.get(key);
			if (existing) existing.tokens += record.tokens;
			else byModel.set(key, { provider: record.provider, model: record.model, tokens: record.tokens });
		}
		return { totalTokens, byModel };
	}
}
