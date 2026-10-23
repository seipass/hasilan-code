import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	SESSION_IMPORT_SOURCES,
	sessionDiscoverySchema,
	sessionImportSchema,
	sessionPreviewSchema,
} from "../../shared/session-import.ts";
import { HttpError, readJson, sendJson } from "../http-host.ts";
import type { SessionRegistry } from "../session-registry.ts";
import { HarnessError } from "../session-registry.ts";
import { sameWorkspace } from "./common.ts";
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
	const currentWorkspace = (id: string) => {
		const workspace = registry.listWorkspaces().find((entry) => entry.id === id);
		if (!workspace) throw new HarnessError("現在のワークスペースが見つかりません。", 404);
		return workspace;
	};
	try {
		const archive = /^\/api\/session-imports\/([^/]+)\/records$/.exec(url.pathname);
		const saved = /^\/api\/session-imports\/([^/]+)\/(records|assets)\/([^/]+)$/.exec(url.pathname);
		if (archive && request.method === "GET") {
			const records = registry.importRecords(decodeURIComponent(archive[1]));
			response.writeHead(200, {
				"Content-Type": "application/x-ndjson; charset=utf-8",
				"Content-Disposition": 'attachment; filename="imported-records.jsonl"',
				"Cache-Control": "no-store",
			});
			await pipeline(
				Readable.from(
					(function* () {
						for (const entry of records) yield `${JSON.stringify(entry)}\n`;
					})(),
				),
				response,
			);
		} else if (saved && request.method === "GET") {
			const sessionId = decodeURIComponent(saved[1]);
			const id = decodeURIComponent(saved[3]);
			if (saved[2] === "records") sendJson(response, 200, registry.importRecord(sessionId, id));
			else {
				const asset = registry.importAsset(sessionId, id);
				const info = await stat(asset.path);
				const inline =
					/^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|mp3|wav|ogg|webm|mp4)|video\/(mp4|webm|ogg))$/.test(
						asset.mimeType,
					);
				response.writeHead(200, {
					"Content-Type": inline ? asset.mimeType : "application/octet-stream",
					"Content-Length": info.size,
					"Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/'/g, "%27")}`,
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "private, max-age=31536000, immutable",
				});
				await pipeline(createReadStream(asset.path), response);
			}
		} else if (url.pathname === "/api/session-imports/sources" && request.method === "GET") {
			sendJson(
				response,
				200,
				SESSION_IMPORT_SOURCES.map((source) => ({ ...source, paths: service.paths(source.id) })),
			);
		} else if (url.pathname === "/api/session-imports/discover" && request.method === "POST") {
			const options = await readJson(request, sessionDiscoverySchema);
			sendJson(response, 200, await service.discover(options, currentWorkspace(options.workspaceId).path));
		} else if (url.pathname === "/api/session-imports/preview" && request.method === "POST") {
			const { candidateId, workspaceId } = await readJson(request, sessionPreviewSchema);
			const workspace = currentWorkspace(workspaceId);
			const preview = await service.preview(candidateId);
			if (!(await sameWorkspace(preview.cwd, workspace.path)))
				throw new HarnessError("このセッションは現在のワークスペースの履歴ではありません。");
			sendJson(response, 200, preview);
		} else if (url.pathname === "/api/session-imports" && request.method === "POST") {
			const options = await readJson(request, sessionImportSchema);
			const workspace = currentWorkspace(options.workspaceId);
			const { data, revision } = await service.read(options.candidateId, options.revision);
			if (!(await sameWorkspace(data.cwd, workspace.path)))
				throw new HarnessError("このセッションは現在のワークスペースの履歴ではありません。");
			const session = await registry.importSession(
				workspace.id,
				data,
				revision,
				options.model,
				options.thinkingLevel,
			);
			await ensureRoot(session.sessionId);
			sendJson(response, 201, {
				session: registry.page(session.sessionId),
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
