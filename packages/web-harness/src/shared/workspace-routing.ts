import { type Static, Type } from "typebox";
import { ATTACHMENT_LIMITS } from "./attachments.ts";

export const workspaceRouteSchema = Type.Object(
	{
		text: Type.String({ maxLength: 1024 * 1024 }),
		attachments: Type.Optional(
			Type.Array(
				Type.Object(
					{
						name: Type.String({ minLength: 1, maxLength: 255 }),
						mimeType: Type.String({ minLength: 1, maxLength: 255 }),
					},
					{ additionalProperties: false },
				),
				{ maxItems: ATTACHMENT_LIMITS.files },
			),
		),
	},
	{ additionalProperties: false },
);
export type WorkspaceRouteInput = Static<typeof workspaceRouteSchema>;
export type ConversationDestination =
	| { kind: "new"; workspaceId: string }
	| { kind: "session"; workspaceId: string; sessionId: string };
export type ConversationCandidate = {
	workspaceId: string;
	path: string;
	name: string;
	probability: number;
} & ({ kind: "new" } | { kind: "session"; sessionId: string; title: string; updatedAt?: string });
export type WorkspaceRouteResult =
	| { kind: "selected"; destination: ConversationCandidate }
	| { kind: "candidates"; candidates: ConversationCandidate[] };
export type ComposerDestination = { kind: "auto" } | ConversationDestination;
export interface ComposerSendResult {
	disposition?: "queued" | "started";
	notice?: string;
	destinationCandidates?: ConversationCandidate[];
}

/** Automatic routing only continues idle, saved user conversations with a model selected. */
export function canContinueSession(session: {
	parentSessionId?: string;
	materialized: boolean;
	availability: "ready" | "missing";
	model?: { provider: string; id: string };
	currentRun?: { runId: string };
	pendingInput: readonly unknown[];
	goal?: { status: string };
	swarm?: { status: string };
}): boolean {
	return (
		!session.parentSessionId &&
		session.materialized &&
		session.availability === "ready" &&
		!!session.model &&
		!session.currentRun &&
		!session.pendingInput.length &&
		session.goal?.status !== "active" &&
		session.swarm?.status !== "active"
	);
}
export interface JevStatus {
	configured: boolean;
	model?: JevSelection;
}

export const jevSelectionSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1, maxLength: 200 }),
		id: Type.String({ minLength: 1, maxLength: 300 }),
	},
	{ additionalProperties: false },
);
export type JevSelection = Static<typeof jevSelectionSchema>;

export function isJevModel(model: { id: string }): boolean {
	return /(?:^|[/:_-])jev(?:$|[-/.])/i.test(model.id);
}
