import { fileEditSchema, readEditableFile, saveEditableFile } from "../file-editor.ts";
import { fileView } from "../file-view.ts";
import { HttpError, readJson, sendJson } from "../http-host.ts";
import { serveWorkspaceImage } from "../image-content.ts";
import { mediaView, serveMedia } from "../media.ts";
import type { WorkspaceFiles } from "../workspace-files.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function workspaceFilesPlugin(files: WorkspaceFiles): ServerPlugin {
	return {
		apiVersion: 1,
		async handleApi(request, response, url, parts) {
			const [, section, id, resource] = parts;
			if (section !== "workspaces" || !id) return false;
			const path = url.searchParams.get("path") ?? "";
			const method = request.method;
			if (resource === "files" && method === "GET") sendJson(response, 200, await files.list(id, path));
			else if (resource === "file-search" && method === "GET") {
				const query = url.searchParams.get("q") ?? "";
				if (query.length > 200) throw new HttpError(400, "Search text is too long");
				const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 200) || 200);
				sendJson(response, 200, await files.search(id, query, limit));
			} else if (resource === "file-edit" && parts.length === 4 && method === "GET")
				sendJson(response, 200, await readEditableFile(files, id, path));
			else if (resource === "file-edit" && parts.length === 4 && method === "PUT") {
				const { revision, text } = await readJson(request, fileEditSchema, 12 * 1024 * 1024);
				sendJson(response, 200, await saveEditableFile(files, id, path, revision, text));
			} else if (resource === "file" && method === "GET") {
				const view =
					(await mediaView(files, id, path)) ??
					fileView(
						await files.read(id, path),
						Number(url.searchParams.get("offset") ?? 1),
						Number(url.searchParams.get("limit") ?? 200),
					);
				sendJson(response, 200, view);
			} else if (resource === "file-content" && (method === "GET" || method === "HEAD")) {
				const revision = url.searchParams.get("revision");
				if (!(await serveMedia(files, id, path, revision, request, response)))
					await serveWorkspaceImage(files, id, path, revision, request, response);
			} else return false;
			return true;
		},
	};
}
