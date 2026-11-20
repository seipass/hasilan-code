import type { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { workspaceRouteSchema } from "../../shared/workspace-routing.ts";
import { browserAdjustmentSchema, suggestBrowserAdjustments } from "../browser-adjustments.ts";
import { gitReview } from "../git-review.ts";
import { readJson, sendJson } from "../http-host.ts";
import type { SessionRegistry } from "../session-registry.ts";
import type { SettingsService } from "../settings.ts";
import { textTransformSchema, transformText } from "../text-transform.ts";
import type { WorkspaceFiles } from "../workspace-files.ts";
import { WorkspaceRouter } from "../workspace-router.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function gitReviewPlugin(getRegistry: () => SessionRegistry): ServerPlugin {
	return {
		apiVersion: 1,
		async handleApi(request, response, url, parts) {
			if (parts[1] !== "sessions" || !parts[2] || parts[3] !== "git-review" || parts.length !== 4) return false;
			if (request.method !== "GET") return false;
			sendJson(
				response,
				200,
				await gitReview(
					getRegistry().descriptor(parts[2]).cwd,
					url.searchParams.get("mode"),
					url.searchParams.get("base"),
				),
			);
			return true;
		},
	};
}

export function textTransformPlugin(
	getSettings: () => SettingsService,
	getModelRuntime: () => ModelRuntime,
	files: WorkspaceFiles,
): ServerPlugin {
	return {
		apiVersion: 1,
		async handleApi(request, response, url) {
			if (url.pathname !== "/api/text-transform" || request.method !== "POST") return false;
			const input = await readJson(request, textTransformSchema, 512 * 1024);
			const controller = new AbortController();
			const abort = () => controller.abort();
			response.once("close", abort);
			try {
				sendJson(
					response,
					200,
					await transformText(input, getSettings(), getModelRuntime(), files, controller.signal),
				);
				return true;
			} finally {
				response.off("close", abort);
			}
		},
	};
}

export function browserAdjustmentsPlugin(getModelRuntime: () => ModelRuntime): ServerPlugin {
	return {
		apiVersion: 1,
		async handleApi(request, response, url) {
			if (url.pathname !== "/api/browser-adjustments" || request.method !== "POST") return false;
			const input = await readJson(request, browserAdjustmentSchema, 32 * 1024);
			const controller = new AbortController();
			const abort = () => controller.abort();
			response.once("close", abort);
			try {
				sendJson(
					response,
					200,
					await suggestBrowserAdjustments(
						input,
						getModelRuntime(),
						AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
					),
				);
				return true;
			} finally {
				response.off("close", abort);
			}
		},
	};
}

export function workspaceRouterPlugin(
	files: WorkspaceFiles,
	getModelRuntime: () => ModelRuntime,
	getSettings: () => SettingsService,
	getRegistry: () => SessionRegistry,
): ServerPlugin {
	let router: WorkspaceRouter | undefined;
	return {
		apiVersion: 1,
		async handleApi(request, response, url) {
			if (url.pathname !== "/api/workspaces/route" || request.method !== "POST") return false;
			router ??= new WorkspaceRouter(files, getModelRuntime(), () => getSettings().get().jev.model, getRegistry());
			sendJson(response, 200, await router.select(await readJson(request, workspaceRouteSchema)));
			return true;
		},
	};
}
