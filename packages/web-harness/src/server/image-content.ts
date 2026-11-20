import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./http-host.ts";
import { imageMime, type WorkspaceFiles } from "./workspace-files.ts";

export async function serveWorkspaceImage(
	files: Pick<WorkspaceFiles, "read">,
	workspaceId: string,
	path: string,
	revision: string | null,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const snapshot = await files.read(workspaceId, path);
	if (snapshot.revision !== revision) throw new HttpError(409, "File revision changed; refresh the viewer");
	const mime = imageMime(snapshot.bytes);
	if (!mime || mime === "image/bmp" || snapshot.bytes.length > 10 * 1024 * 1024)
		throw new HttpError(415, "File is not a supported image");
	response.writeHead(200, {
		"Content-Type": mime,
		"Content-Length": snapshot.bytes.length,
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "private, no-store",
	});
	response.end(request.method === "HEAD" ? undefined : snapshot.bytes);
}
