import type { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { JevSelection } from "../shared/workspace-routing.ts";

const splitDecisionSchema = Type.Object({
	answers: Type.Object({
		routing: Type.Object({
			type: Type.Literal("choice"),
			choice: Type.Union([Type.Literal("continue_here"), Type.Literal("split_session")]),
			confidence: Type.Number({ minimum: 0, maximum: 1 }),
		}),
	}),
});

export interface SplitDecision {
	shouldSplit: boolean;
	suggestedTitle: string;
	branchName: string;
	explanation: string;
}

const SEPARATE_PREFIX_RE =
	/^(?:also[,:\s]+|separately[,:\s]+|on the side[,:\s]+|btw[,:\s]+|by the way[,:\s]+|meanwhile[,:\s]+|ついでに[、,\s]*|別件(?:で|ですが)?[、,\s]*|あと[、,\s]+|並行して[、,\s]*|ちなみに別で[、,\s]*)/i;

const STEER_ONLY_RE =
	/^(?:wait|stop|actually|no[, ]|never ?mind|use |keep |make sure|don't |do not |sorry|待って|やっぱ|いや|そこ|それ|続けて|止めて)/i;

function tokenize(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, " ")
		.split(/\s+/)
		.filter((token) => token.length >= 3);
	return new Set(words);
}

export function deriveSplitMetadata(text: string): { suggestedTitle: string; branchName: string } {
	const cleaned = text.trim().replace(SEPARATE_PREFIX_RE, "").trim();
	const firstLine = (cleaned || text.trim()).split(/\r?\n/, 1)[0].trim();
	const suggestedTitle = firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine || "別タスク";

	const prefix = /\b(fix|bug|broken|overflow|error|crash)\b|修正|バグ|直/i.test(firstLine)
		? "fix"
		: /\b(refactor|clean|rename)\b|リファクタ/i.test(firstLine)
			? "refactor"
			: "feat";
	const asciiSlug = firstLine
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter((part) => part.length > 0 && !["the", "a", "an", "on", "in", "to", "for", "of", "and"].includes(part))
		.slice(0, 4)
		.join("-");
	const branchName = asciiSlug ? `${prefix}/${asciiSlug}` : `split/${Date.now().toString(36)}`;
	return { suggestedTitle, branchName };
}

export function heuristicShouldSplit(currentTask: string, incomingText: string): boolean {
	const trimmed = incomingText.trim();
	if (trimmed.length < 10 || STEER_ONLY_RE.test(trimmed)) return false;
	if (!SEPARATE_PREFIX_RE.test(trimmed)) return false;
	const currentTokens = tokenize(currentTask);
	const incomingTokens = tokenize(trimmed.replace(SEPARATE_PREFIX_RE, ""));
	if (incomingTokens.size === 0) return false;
	let overlap = 0;
	for (const token of incomingTokens) {
		if (currentTokens.has(token)) overlap++;
	}
	return overlap / incomingTokens.size < 0.25;
}

export async function classifyMidTurnSplit(options: {
	currentTask: string;
	incomingText: string;
	runtime?: Pick<ModelRuntime, "getModelOfType" | "hasConfiguredAuth" | "classify">;
	getClassifier?: () => JevSelection | undefined;
}): Promise<SplitDecision> {
	const { suggestedTitle, branchName } = deriveSplitMetadata(options.incomingText);
	const selection = options.getClassifier?.();
	const model =
		selection && options.runtime
			? options.runtime.getModelOfType("classifier", selection.provider, selection.id)
			: undefined;

	if (model && options.runtime?.hasConfiguredAuth(model.provider)) {
		try {
			const result = await options.runtime.classify(
				model,
				{
					state: {
						activeTask: options.currentTask.slice(0, 2000),
						incomingMessage: options.incomingText.slice(0, 2000),
					},
					questions: {
						routing: {
							type: "choice",
							instructions:
								"The user sent a message while an AI coding agent is busy with activeTask. Decide whether incomingMessage steers/clarifies activeTask (continue_here) or asks for an unrelated independent task that can run in its own parallel session (split_session). Choose continue_here when uncertain.",
							criteria: {
								continue_here:
									"Clarifies, adjusts, redirects, or asks about the current activeTask, or is a short steering instruction.",
								split_session:
									"Requests an unrelated feature, bug fix, or task independent from activeTask that can proceed in parallel.",
							},
						},
					},
				},
				{ signal: AbortSignal.timeout(4_000), maxRetries: 0 },
			);
			if (result.stopReason === "stop" && Check(splitDecisionSchema, result)) {
				const answer = result.answers.routing;
				const shouldSplit = answer.choice === "split_session" && answer.confidence >= 0.72;
				return {
					shouldSplit,
					suggestedTitle,
					branchName,
					explanation: "進行中の作業とは別のタスクです。新しいセッションで並行実行しますか？",
				};
			}
		} catch {
			/* Fall through to deterministic heuristic when classifier is unreachable. */
		}
	}

	const shouldSplit = heuristicShouldSplit(options.currentTask, options.incomingText);
	return {
		shouldSplit,
		suggestedTitle,
		branchName,
		explanation: "進行中の作業とは別のタスクです。新しいセッションで並行実行しますか？",
	};
}
