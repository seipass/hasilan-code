import { workspaceSwarmStartSchema } from "../../shared/swarm.ts";
import { readJson, sendJson } from "../http-host.ts";
import type { TeamManager } from "../team-manager.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function hyakkiPlugin(getTeams: () => Pick<TeamManager, "startWorkspaceSwarm" | "continueSwarm">): ServerPlugin {
	return {
		apiVersion: 1,
		async handleApi(request, response, _url, parts) {
			const [, section, id, feature, action] = parts;
			if (request.method !== "POST" || !id || feature !== "swarm") return false;
			if (section === "workspaces" && parts.length === 4) {
				sendJson(
					response,
					202,
					await getTeams().startWorkspaceSwarm(id, await readJson(request, workspaceSwarmStartSchema)),
				);
				return true;
			}
			if (section === "sessions" && parts.length === 5 && action === "continue") {
				sendJson(response, 202, await getTeams().continueSwarm(id));
				return true;
			}
			return false;
		},
	};
}
