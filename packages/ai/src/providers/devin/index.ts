import { createHash } from "node:crypto";
import { isModelType, type Provider } from "../../models.ts";
import type { Model } from "../../types.ts";
import { devinAuth } from "./auth.ts";
import { decodeModels } from "./catalog.ts";
import { apiServer, DEVIN_MODELS_PATH, unary } from "./protocol.ts";
import { streamDevin } from "./stream.ts";

import { devinAccountUsage } from "./usage.ts";
export function devinProvider(fetcher: typeof fetch = fetch): Provider<"devin-connect"> {
	let models: readonly Model<"devin-connect">[] = [];
	let account: string | undefined;
	return {
		id: "devin",
		name: "Devin",
		baseUrl: apiServer(undefined),
		auth: { oauth: devinAuth(fetcher) },
		getAccountUsage: (context) => devinAccountUsage({ ...context, fetch: context.fetch ?? fetcher }),
		getModels: () => models,
		async refreshModels(context) {
			const credential = context.credential;
			if (credential?.type !== "oauth") {
				await context.publish({
					persist: null,
					update: () => {
						models = [];
						account = undefined;
					},
				});
				return;
			}
			const fingerprint = createHash("sha256").update(credential.access).digest("hex");
			if (context.stored?.etag === fingerprint) {
				const restored = context.stored.models.filter(
					(model): model is Model<"devin-connect"> =>
						isModelType(model, "chat") && model.provider === "devin" && model.api === "devin-connect",
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
							account = fingerprint;
						},
					}))
				)
					return;
			} else if (account !== fingerprint) {
				if (
					!(await context.publish({
						persist: null,
						update: () => {
							models = [];
							account = fingerprint;
						},
					}))
				)
					return;
			}
			if (!context.allowNetwork) return;
			const server = apiServer(credential.apiServer);
			const payload = await unary(
				server,
				DEVIN_MODELS_PATH,
				credential.access,
				AbortSignal.any([context.signal, AbortSignal.timeout(30000)]),
				fetcher,
			);
			const fresh = decodeModels(payload, server);
			if (!fresh.length) throw new Error("このDevinアカウントで利用できるモデルがありません。");
			await context.publish({
				persist: { models: fresh, etag: fingerprint, checkedAt: Date.now() },
				update: () => {
					models = fresh;
					account = fingerprint;
				},
			});
		},
		stream: (model, context, options) => streamDevin(model, context, options, fetcher),
		streamSimple: (model, context, options) => streamDevin(model, context, options, fetcher),
	};
}
