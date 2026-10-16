import { type Static, Type } from "typebox";

export const SWARM_OBJECTIVE_MAX_LENGTH = 65536;
export const swarmStartSchema = Type.Object(
	{ objective: Type.String({ minLength: 1, maxLength: SWARM_OBJECTIVE_MAX_LENGTH }) },
	{ additionalProperties: false },
);
export type SwarmStart = Static<typeof swarmStartSchema>;

export type SwarmStatus = "active" | "paused" | "blocked" | "complete";

/** Durable objective lifecycle; TeamManager remains the only execution scheduler. */
export interface Swarm {
	id: string;
	objective: string;
	createdAt: string;
	updatedAt: string;
	status: SwarmStatus;
	reason?: string;
	rootRunId: string;
}
