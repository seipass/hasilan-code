import { type Static, Type } from "typebox";

export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "dropped";
export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	reason?: string;
	createdAt: string;
	updatedAt: string;
}

export const goalActionSchema = Type.Union([
	Type.Object(
		{
			op: Type.Literal("create"),
			objective: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
		},
		{ additionalProperties: false },
	),
	Type.Object({ op: Type.Literal("get") }, { additionalProperties: false }),
	Type.Object({ op: Type.Literal("pause") }, { additionalProperties: false }),
	Type.Object({ op: Type.Literal("resume") }, { additionalProperties: false }),
	Type.Object({ op: Type.Literal("drop") }, { additionalProperties: false }),
]);
export type GoalAction = Static<typeof goalActionSchema>;
