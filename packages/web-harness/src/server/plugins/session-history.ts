import { HttpError, sendJson } from "../http-host.ts";
import { handleSessionImport } from "../session-import/routes.ts";
import { SessionImportService } from "../session-import/service.ts";
import type { SessionRegistry } from "../session-registry.ts";
import { readStorageUsage } from "../storage-usage.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function sessionSearchPlugin(getRegistry: () => SessionRegistry): ServerPlugin {
	return {
		apiVersion: 1,
		handleApi(request, response, url) {
			if (request.method !== "GET" || url.pathname !== "/api/sessions/search") return false;
			const query = url.searchParams.get("q") ?? "";
			if (query.length > 200) throw new HttpError(400, "Search text is too long");
			sendJson(response, 200, getRegistry().searchText(query));
			return true;
		},
	};
}

export function sessionImportPlugin(
	getRegistry: () => SessionRegistry,
	ensureRoot: (id: string) => Promise<unknown>,
): ServerPlugin {
	let imports: SessionImportService | undefined;
	return {
		apiVersion: 1,
		handleApi(request, response, url, parts) {
			if (parts[1] !== "session-imports") return false;
			const registry = getRegistry();
			if (!registry.sessionStorage) return false;
			imports ??= new SessionImportService();
			return handleSessionImport(request, response, url, imports, registry, ensureRoot);
		},
	};
}

export function sessionArchivePlugin(getRegistry: () => SessionRegistry): ServerPlugin {
	return {
		apiVersion: 1,
		async handleApi(request, response, url, parts) {
			if (parts[1] !== "session-archive") return false;
			const registry = getRegistry();
			if (!registry.sessionStorage) return false;
			if (url.pathname === "/api/session-archive" && request.method === "GET") {
				sendJson(response, 200, await registry.listSessionArchive());
				return true;
			}
			if (parts.length !== 3 || (request.method !== "POST" && request.method !== "DELETE")) return false;
			await registry.changeArchivedSession(parts[2], request.method === "POST" ? "restore" : "delete");
			sendJson(response, 200, { ok: true });
			return true;
		},
	};
}

export function storageUsagePlugin(agentDir: string, getRegistry: () => SessionRegistry): ServerPlugin {
	return {
		apiVersion: 1,
		async handleApi(request, response, url) {
			if (request.method !== "GET" || url.pathname !== "/api/storage") return false;
			const registry = getRegistry();
			sendJson(
				response,
				200,
				await readStorageUsage(agentDir, new Set(registry.sessionPaths()), registry.sessionStorage),
			);
			return true;
		},
	};
}
