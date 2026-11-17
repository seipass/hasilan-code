import type { ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { goalActionSchema } from "../../shared/goals.ts";
import { readJson, sendJson } from "../http-host.ts";
import type { TeamManager } from "../team-manager.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function goalPlugin(getTeams: () => Pick<TeamManager, "goal" | "createGoalTool">): ServerPlugin {
	return {
		apiVersion: 1,
		tools: ({ sessionId }) => [getTeams().createGoalTool(sessionId) as unknown as ToolDefinition],
		async handleApi(request, response, _url, parts) {
			const [, section, id, feature] = parts;
			if (section !== "sessions" || !id || feature !== "goal" || parts.length !== 4) return false;
			if (request.method === "GET") {
				sendJson(response, 200, await getTeams().goal(id, { op: "get" }));
				return true;
			}
			if (request.method !== "POST") return false;
			sendJson(response, 200, await getTeams().goal(id, await readJson(request, goalActionSchema)));
			return true;
		},
	};
}
