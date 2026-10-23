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
export const SESSION_IMPORT_CONTEXT_TYPE = "harness-imported-context";
export const SESSION_IMPORT_RECORD_TYPE = "harness-imported-record";
export const SESSION_IMPORT_BOUNDARY_TYPE = "harness-imported-boundary";
export type ImportContent =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; summary?: string; thinkingSignature?: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: unknown; status?: string }
	| { type: "toolResult"; id: string; name?: string; content: ImportContent[]; isError: boolean; status?: string }
	| {
			type: "attachment";
			kind: string;
			name: string;
			mimeType: string;
			data?: string;
			text?: string;
			path?: string;
			url?: string;
			referenceId?: string;
			assetId?: string;
			unavailable?: string;
	  }
	| { type: "sourceBlock"; label: string; value: unknown };
export interface ImportedMessageOrigin {
	recordId: string;
	id?: string;
	parentId?: string | null;
	channel?: string;
	model?: string;
	stopReason?: string;
	usage?: unknown;
	active: boolean;
	url?: string;
}
export interface ImportedRecord {
	id: string;
	raw: Record<string, unknown>;
	messages: SessionImportMessage[];
}
const sourceSchema = Type.Union([
	Type.Literal("codex"),
	Type.Literal("claude-code"),
	Type.Literal("grok-build"),
	Type.Literal("opencode"),
	Type.Literal("oh-my-pi"),
	Type.Literal("deepseek-harness"),
]);
export const sessionDiscoverySchema = Type.Object(
	{
		source: sourceSchema,
		workspaceId: Type.String({ minLength: 1 }),
		path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	},
	{ additionalProperties: false },
);
export const sessionPreviewSchema = Type.Object(
	{ candidateId: Type.String({ minLength: 1, maxLength: 128 }), workspaceId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
export const sessionImportSchema = Type.Object(
	{
		candidateId: Type.String({ minLength: 1, maxLength: 128 }),
		revision: Type.String({ minLength: 1, maxLength: 128 }),
		workspaceId: Type.String({ minLength: 1 }),
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
	content?: ImportContent[];
	origin?: ImportedMessageOrigin;
}
export interface ImportedTranscript {
	source: SessionImportSource;
	sourceSessionId: string;
	title: string;
	cwd?: string;
	messages: SessionImportMessage[];
	warnings: string[];
	/** Full source history, including records excluded from the current model context. */
	records?: ImportedRecord[];
	attachmentRoot?: string;
}
export interface ImportedFrom {
	source: SessionImportSource;
	sourceSessionId: string;
	revision: string;
	importedAt: string;
	fidelityVersion?: 1;
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
