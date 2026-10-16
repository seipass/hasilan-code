import { type Static, Type } from "typebox";

export const SWARM_OBJECTIVE_MAX_LENGTH = 65536;
export const swarmStartSchema = Type.Object(
	{ objective: Type.String({ minLength: 1, maxLength: SWARM_OBJECTIVE_MAX_LENGTH }) },
	{ additionalProperties: false },
);
export type SwarmStart = Static<typeof swarmStartSchema>;

/** Durable mode identity; execution state comes from TeamManager runs, not a second scheduler. */
export interface Swarm {
	id: string;
	objective: string;
	createdAt: string;
	rootRunId: string;
}
