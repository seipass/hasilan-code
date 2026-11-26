import { type Static, Type } from "typebox";

export const SURFACE_CUSTOM_TYPE = "harness-surface";

export interface ActionPlanFileChange {
	path: string;
	added: number;
	removed: number;
	isNew?: boolean;
	patch: string;
}

export interface ActionPlanTestCase {
	name: string;
	status: "passed" | "failed";
	durationMs?: number;
}

export interface ActionPlanTestSummary {
	passed: number;
	failed: number;
	total: number;
	cases?: ActionPlanTestCase[];
}

export interface ActionPlanToolTrace {
	callId: string;
	name: string;
	label: string;
	target?: string;
	status: "running" | "success" | "error";
	added?: number;
	removed?: number;
}

export interface ActionPlanStep {
	id: string;
	title: string;
	status: "pending" | "active" | "completed" | "skipped";
	note?: string;
	tools: ActionPlanToolTrace[];
	files: ActionPlanFileChange[];
	tests?: ActionPlanTestSummary;
}

export interface ActionPlanSurface {
	kind: "action_plan";
	surfaceId: string;
	sessionId: string;
	runId?: string;
	anchorCallId?: string;
	phase: "draft" | "executing" | "completed" | "cancelled";
	title?: string;
	estimatedFiles: number;
	steps: ActionPlanStep[];
	activeStepId?: string;
	startedAt?: string;
	completedAt?: string;
	updatedAt: string;
}

export type SessionSurface = ActionPlanSurface;

export const surfaceActionSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("approve_plan"),
			steps: Type.Array(
				Type.Object(
					{
						id: Type.String({ minLength: 1, maxLength: 128 }),
						title: Type.String({ minLength: 1, maxLength: 500 }),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1, maxItems: 50 },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("cancel_plan"),
			reason: Type.Optional(Type.String({ maxLength: 500 })),
		},
		{ additionalProperties: false },
	),
]);

export type SurfaceAction = Static<typeof surfaceActionSchema>;

export function isSessionSurface(value: unknown): value is SessionSurface {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<SessionSurface>;
	return (
		candidate.kind === "action_plan" &&
		typeof candidate.surfaceId === "string" &&
		typeof candidate.sessionId === "string" &&
		Array.isArray(candidate.steps)
	);
}
