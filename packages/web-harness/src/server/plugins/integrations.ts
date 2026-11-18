import type { ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { readAccountUsage } from "../account-usage.ts";
import { GithubDashboardReader } from "../github-dashboard.ts";
import { HttpError, sendJson } from "../http-host.ts";
import { WidgetData } from "../widget-data.ts";
import type { ServerPlugin } from "./server-profile.ts";

export function githubDashboardPlugin(): ServerPlugin {
	const reader = new GithubDashboardReader();
	return {
		apiVersion: 1,
		async handleApi(request, response, url) {
			if (request.method !== "GET" || url.pathname !== "/api/home/github") return false;
			sendJson(response, 200, await reader.read());
			return true;
		},
	};
}

export function widgetFeedsPlugin(): ServerPlugin {
	const widgets = new WidgetData();
	return {
		apiVersion: 1,
		async handleApi(request, response, url) {
			if (!url.pathname.startsWith("/api/widgets/")) return false;
			if (request.method !== "GET") throw new HttpError(405, "Method is not allowed");
			sendJson(response, 200, await widgets.query(url));
			return true;
		},
	};
}

export function accountUsagePlugin(getRuntime: () => ModelRuntime): ServerPlugin {
	return {
		apiVersion: 1,
		async handleApi(request, response, url) {
			if (request.method !== "GET" || url.pathname !== "/api/account-usage") return false;
			const controller = new AbortController();
			const abort = () => controller.abort();
			response.once("close", abort);
			try {
				sendJson(response, 200, await readAccountUsage(getRuntime(), controller.signal));
				return true;
			} finally {
				response.off("close", abort);
			}
		},
	};
}
