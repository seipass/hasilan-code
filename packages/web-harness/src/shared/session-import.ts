import { type Static, Type } from "typebox";
import { modelSchema, thinkingSchema } from "./contracts.ts";

export const SESSION_IMPORT_SOURCES = [
	{ id: "codex", label: "Codex" },
	{ id: "claude-code", label: "Claude Code" },
	{ id: "grok-build", label: "Grok Build" },
	{ id: "opencode", label: "OpenCode" },
	{ id: "oh-my-pi", label: "oh my pi" },
	{ id: "deepseek-harness", label: "deepseek harness" },
] as const;
export type SessionImportSource = (typeof SESSION_IMPORT_SOURCES)[number]["id"];
export const SESSION_IMPORT_MESSAGE_API = "session-import";
const sourceSchema = Type.Union([
	Type.Literal("codex"),
	Type.Literal("claude-code"),
	Type.Literal("grok-build"),
	Type.Literal("opencode"),
	Type.Literal("oh-my-pi"),
	Type.Literal("deepseek-harness"),
]);
export const sessionDiscoverySchema = Type.Object(
	{ source: sourceSchema, path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) },
	{ additionalProperties: false },
);
export const sessionPreviewSchema = Type.Object(
	{ candidateId: Type.String({ minLength: 1, maxLength: 128 }) },
	{ additionalProperties: false },
);
export const sessionImportSchema = Type.Object(
	{
		candidateId: Type.String({ minLength: 1, maxLength: 128 }),
		revision: Type.String({ minLength: 1, maxLength: 128 }),
		workspaceId: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Optional(modelSchema),
		thinkingLevel: Type.Optional(thinkingSchema.properties.level),
	},
	{ additionalProperties: false },
);
export type SessionDiscoveryRequest = Static<typeof sessionDiscoverySchema>;
export type SessionImportRequest = Static<typeof sessionImportSchema>;
export interface SessionImportMessage {
	role: "user" | "assistant" | "context";
	text: string;
	timestamp?: number;
}
export interface ImportedTranscript {
	source: SessionImportSource;
	sourceSessionId: string;
	title: string;
	cwd?: string;
	messages: SessionImportMessage[];
	warnings: string[];
}
export interface ImportedFrom {
	source: SessionImportSource;
	sourceSessionId: string;
	revision: string;
	importedAt: string;
}
export interface SessionImportCandidate {
	candidateId: string;
	source: SessionImportSource;
	sourceSessionId: string;
	title: string;
	cwd?: string;
	updatedAt: string;
}
export interface SessionDiscovery {
	candidates: SessionImportCandidate[];
	paths: string[];
	warnings: string[];
}
export interface SessionImportPreview extends SessionImportCandidate {
	revision: string;
	messageCount: number;
	messages: SessionImportMessage[];
	warnings: string[];
}
