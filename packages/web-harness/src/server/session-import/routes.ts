import type { IncomingMessage, ServerResponse } from "node:http";
import {
	SESSION_IMPORT_SOURCES,
	sessionDiscoverySchema,
	sessionImportSchema,
	sessionPreviewSchema,
} from "../../shared/session-import.ts";
import { HttpError, readJson, sendJson } from "../http-host.ts";
import type { SessionRegistry } from "../session-registry.ts";
import { HarnessError } from "../session-registry.ts";
import type { SessionImportService } from "./service.ts";

export async function handleSessionImport(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	service: SessionImportService,
	registry: SessionRegistry,
	ensureRoot: (id: string) => Promise<unknown>,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/session-imports")) return false;
	try {
		if (url.pathname === "/api/session-imports/sources" && request.method === "GET") {
			sendJson(
				response,
				200,
				SESSION_IMPORT_SOURCES.map((source) => ({ ...source, paths: service.paths(source.id) })),
			);
		} else if (url.pathname === "/api/session-imports/discover" && request.method === "POST") {
			sendJson(response, 200, await service.discover(await readJson(request, sessionDiscoverySchema)));
		} else if (url.pathname === "/api/session-imports/preview" && request.method === "POST") {
			const { candidateId } = await readJson(request, sessionPreviewSchema);
			sendJson(response, 200, await service.preview(candidateId));
		} else if (url.pathname === "/api/session-imports" && request.method === "POST") {
			const options = await readJson(request, sessionImportSchema);
			const { data, revision } = await service.read(options.candidateId, options.revision);
			if (!options.workspaceId && !data.cwd)
				throw new HarnessError("引き継ぎ先の作業フォルダーを選択してください。");
			const workspace = options.workspaceId
				? registry.listWorkspaces().find((entry) => entry.id === options.workspaceId)
				: await registry.addWorkspace(data.cwd!);
			if (!workspace) throw new HarnessError("引き継ぎ先の作業フォルダーが見つかりません。", 404);
			const session = await registry.importSession(
				workspace.id,
				data,
				revision,
				options.model,
				options.thinkingLevel,
			);
			await ensureRoot(session.sessionId);
			sendJson(response, 201, {
				session: registry.get(session.sessionId),
				workspace: { workspaceId: workspace.id, path: workspace.path },
			});
		} else return false;
		return true;
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(
			error instanceof HarnessError ? error.statusCode : 400,
			error instanceof Error ? error.message : "履歴を読み込めませんでした。",
		);
	}
}
