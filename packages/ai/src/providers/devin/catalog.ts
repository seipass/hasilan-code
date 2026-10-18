import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "../../types.ts";
import { apiServer, blobs, decode, type Fields, integer, text } from "./protocol.ts";

interface Variant {
	uid: string;
	effort?: ModelThinkingLevel;
	preferred: boolean;
	contextWindow: number;
	maxTokens: number;
	images: boolean;
}
const EFFORTS: Readonly<Record<string, ModelThinkingLevel>> = {
	none: "off",
	"no thinking": "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	"x-high": "xhigh",
	"extra high": "xhigh",
	max: "max",
};

export function decodeModels(payload: Fields, server: string): Model<"devin-connect">[] {
	const groups = new Map<string, { name: string; variants: Variant[] }>();
	for (const bytes of blobs(payload, 1)) {
		const config = decode(bytes);
		if (integer(config, 4)) continue;
		const info = decode(blobs(config, 23)[0] ?? Buffer.alloc(0));
		const familyInfo = decode(blobs(config, 30)[0] ?? Buffer.alloc(0));
		const uid = text(config, 22) || text(info, 17);
		const familyName = text(familyInfo, 1) || "";
		const family = text(info, 23) || familyName.toLowerCase().replace(/[\s.]+/g, "-");
		// Fusion requires its own lead/sidekick orchestration, not this single-model wire.
		if (!uid || !family || family === "fusion") continue;
		const label = text(config, 1) || familyName || uid;
		let suffix = label.toLowerCase().trim();
		if (familyName && suffix.startsWith(familyName.toLowerCase())) suffix = suffix.slice(familyName.length).trim();
		let effort = EFFORTS[suffix];
		const modifiers: string[] = [];
		if (!effort) {
			const rest: string[] = [];
			for (const word of suffix.split(/\s+/)) {
				if (word === "fast" || word === "priority" || word === "1m") modifiers.push(word);
				else rest.push(word);
			}
			effort = EFFORTS[rest.join(" ")];
			if (!effort && rest.some((word) => word === "thinking" || word === "think")) modifiers.unshift("thinking");
		}
		const id = [family, ...modifiers].join("-");
		let group = groups.get(id);
		if (!group) {
			group = {
				name: `${familyName || label}${modifiers.length ? ` ${modifiers.map((word) => (word === "1m" ? "1M" : word[0].toUpperCase() + word.slice(1))).join(" ")}` : ""}`,
				variants: [],
			};
			groups.set(id, group);
		}
		group.variants.push({
			uid,
			effort,
			preferred: Boolean(integer(config, 31) || integer(familyInfo, 3)),
			contextWindow: integer(info, 4) || integer(config, 18) || 200000,
			maxTokens: integer(info, 13) || 64000,
			images: Boolean(integer(config, 5)),
		});
	}
	const result: Model<"devin-connect">[] = [];
	for (const [id, group] of groups) {
		const variants: ThinkingLevelMap = {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: null,
		};
		for (const variant of group.variants)
			if (variant.effort && variants[variant.effort] === null) variants[variant.effort] = variant.uid;
		const preferred =
			group.variants.find((variant) => variant.preferred) ??
			group.variants.find((variant) => !variant.effort) ??
			group.variants.find((variant) => variant.effort === "medium") ??
			group.variants.find((variant) => variant.effort === "high") ??
			group.variants[0];
		const reasoning = group.variants.some((variant) => variant.effort !== undefined && variant.effort !== "off");
		result.push({
			id,
			name: group.name,
			api: "devin-connect",
			provider: "devin",
			baseUrl: apiServer(server),
			input: group.variants.some((variant) => variant.images) ? ["text", "image"] : ["text"],
			contextWindow: Math.max(...group.variants.map((variant) => variant.contextWindow)),
			maxTokens: Math.max(...group.variants.map((variant) => variant.maxTokens)),
			reasoning,
			...(reasoning ? { thinkingLevelMap: variants } : {}),
			samplingParams: { chat_model_uid: preferred.uid },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}
