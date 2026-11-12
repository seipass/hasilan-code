import { type Static, Type } from "typebox";
import { modelSchema, thinkingSchema } from "./contracts.ts";

export const AGENT_CATEGORIES = {
	orchestration: "オーケストレーション",
	coding: "コーディング",
	design: "デザイン",
	writing: "文章",
	research: "調査",
	strategy: "ストラテジー",
	advisor: "アドバイザー",
	other: "その他",
} as const;

export type AgentCategory = keyof typeof AGENT_CATEGORIES;
export const agentCategorySchema = Type.Unsafe<AgentCategory>(
	Type.Union(Object.keys(AGENT_CATEGORIES).map((id) => Type.Literal(id))),
);
export const agentModelSchema = Type.Object(
	{ ...modelSchema.properties, thinkingLevel: thinkingSchema.properties.level },
	{ additionalProperties: false },
);
export type AgentModel = Static<typeof agentModelSchema>;
export type AgentModels = Partial<Record<AgentCategory, AgentModel>>;
export const agentModelsSchema = Type.Unsafe<AgentModels>(
	Type.Object(Object.fromEntries(Object.keys(AGENT_CATEGORIES).map((id) => [id, Type.Optional(agentModelSchema)])), {
		additionalProperties: false,
	}),
);
