import { randomBytes } from "node:crypto";
import { CANVAS_LIMITS, canvasSaveSchema, isCanvasDocument, serializeCanvasDesign } from "../../shared/canvas.ts";
import { CanvasStore, CanvasStoreError } from "../canvas-store.ts";
import { HttpError, readJson, sendJson } from "../http-host.ts";
import type { WorkspaceFiles } from "../workspace-files.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function canvasPlugin(
	agentDir: string,
	validateWorkspace: (workspaceId: string) => void,
	files: Pick<WorkspaceFiles, "create">,
): ServerPlugin {
	const canvases = new CanvasStore(agentDir, validateWorkspace);
	return {
		apiVersion: 1,
		async handleApi(request, response, _url, parts) {
			const [, section, id, feature, action] = parts;
			if (section !== "workspaces" || !id || feature !== "canvas") return false;
			try {
				if (parts.length === 5 && action === "compose" && request.method === "POST") {
					const document = await readJson(request, canvasSaveSchema, CANVAS_LIMITS.bytes);
					if (!isCanvasDocument(document)) throw new HttpError(400, "設計データの ID・接続先が不正です。");
					const snapshot = await files.create(
						id,
						`.hasilan-code/canvas/design-${randomBytes(8).toString("hex")}.txt`,
						Buffer.from(`${serializeCanvasDesign(document.design)}\n`, "utf8"),
					);
					sendJson(response, 201, { path: snapshot.path });
					return true;
				}
				if (parts.length !== 4) return false;
				if (request.method === "GET") {
					sendJson(response, 200, await canvases.get(id));
					return true;
				}
				if (request.method !== "PUT") return false;
				sendJson(
					response,
					200,
					await canvases.save(id, await readJson(request, canvasSaveSchema, CANVAS_LIMITS.bytes)),
				);
				return true;
			} catch (error) {
				if (error instanceof CanvasStoreError) throw new HttpError(error.status, error.message);
				throw error;
			}
		},
	};
}
