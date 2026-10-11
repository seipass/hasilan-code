import type { AuthInteraction, Credential, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AuthLoginManager,
	type AuthLoginRuntime,
	authLoginPromptSchema,
	authLoginSchema,
} from "../src/server/auth-login.ts";
import { HttpError } from "../src/server/http-host.ts";

const credential: OAuthCredential = {
	type: "oauth",
	access: "private-access-token",
	refresh: "private-refresh-token",
	expires: 123,
};
const oauth = {
	name: "Test account",
	login: async () => credential,
	refresh: async () => credential,
	toAuth: async () => ({ apiKey: credential.access }),
};
const apiKey = { name: "Test API key", resolve: async () => ({ auth: { apiKey: "private-api-key" } }) };
const providers: Provider[] = [
	{ id: "openai", name: "OpenAI", auth: { oauth, apiKey } },
	{ id: "openai-codex", name: "Codex", auth: { oauth } },
	{ id: "key-only", name: "API key only", auth: { apiKey } },
].map((provider) => ({
	...provider,
	getModels: () => [],
	stream: () => {
		throw new Error("Tests must not issue provider requests");
	},
	streamSimple: () => {
		throw new Error("Tests must not issue provider requests");
	},
}));

let manager: AuthLoginManager;
let runtime: AuthLoginRuntime;
let interaction: AuthInteraction;
let completion: PromiseWithResolvers<Credential>;

beforeEach(() => {
	completion = Promise.withResolvers<Credential>();
	runtime = {
		getProviders: () => providers,
		login: vi.fn<AuthLoginRuntime["login"]>((_provider, _type, callbacks) => {
			interaction = callbacks;
			return completion.promise;
		}),
	};
	manager = new AuthLoginManager(runtime, { getDeviceId: () => "stable-installation-id" });
});

afterEach(async () => {
	completion.reject(new Error("Test cleanup"));
	await completion.promise.catch(() => undefined);
	await manager.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("host account login", () => {
	it("runs successive Codex selection, text, secret and manual-code interactions without echoing input", async () => {
		const entered: string[] = [];
		vi.mocked(runtime.login).mockImplementationOnce(async (provider, type, callbacks, options) => {
			interaction = callbacks;
			expect(provider).toBe("openai-codex");
			expect(type).toBe("oauth");
			expect(options?.getDeviceId?.()).toBe("stable-installation-id");
			entered.push(
				await callbacks.prompt({
					type: "select",
					message: "Choose login method",
					options: [
						{ id: "device", label: "Device code" },
						{ id: "browser", label: "Browser login" },
					],
				}),
			);
			callbacks.notify({
				type: "device_code",
				userCode: "ABCD-EFGH",
				verificationUri: "https://example.com/device",
			});
			entered.push(await callbacks.prompt({ type: "text", message: "Optional domain", placeholder: "example.com" }));
			entered.push(await callbacks.prompt({ type: "secret", message: "Enter secret" }));
			entered.push(
				await callbacks.prompt({
					type: "manual_code",
					message: "Paste redirect",
					placeholder: "http://localhost/callback",
				}),
			);
			return credential;
		});
		const started = manager.start("openai-codex");
		const selection = started.prompt;
		expect(selection?.type).toBe("select");
		expect(() => manager.submit(started.loginId, selection?.id ?? "", "invalid-private-value")).toThrow(HttpError);
		expect(() => manager.submit(started.loginId, "stale-prompt", "private-stale-input")).toThrow("prompt changed");
		expect(manager.get(started.loginId).prompt?.id).toBe(selection?.id);
		manager.submit(started.loginId, selection?.id ?? "", "device");
		expect(() => manager.submit(started.loginId, selection?.id ?? "", "device")).toThrow("prompt changed");
		await vi.waitFor(() => expect(manager.get(started.loginId).prompt?.type).toBe("text"));
		manager.submit(started.loginId, manager.get(started.loginId).prompt?.id ?? "", "");
		await vi.waitFor(() => expect(manager.get(started.loginId).prompt?.type).toBe("secret"));
		const secretPrompt = manager.get(started.loginId).prompt;
		expect(() => manager.submit(started.loginId, secretPrompt?.id ?? "", " ")).toThrow("must not be empty");
		const submitted = manager.submit(started.loginId, secretPrompt?.id ?? "", "private-entered-secret");
		expect(JSON.stringify(submitted)).not.toContain("private-");
		await vi.waitFor(() => expect(manager.get(started.loginId).prompt?.type).toBe("manual_code"));
		manager.submit(started.loginId, manager.get(started.loginId).prompt?.id ?? "", "private-callback-code");
		await vi.waitFor(() => expect(manager.get(started.loginId).status).toBe("completed"));
		expect(entered).toEqual(["device", "", "private-entered-secret", "private-callback-code"]);
		const completed = manager.get(started.loginId);
		expect(completed.prompt).toBeUndefined();
		expect(JSON.stringify(completed)).not.toContain("private-");
		expect(() => manager.submit(started.loginId, secretPrompt?.id ?? "", "private-late-value")).toThrow(
			"prompt changed",
		);
	});

	it("removes a callback-cancelled prompt without cancelling the overall exchange and disposes both listeners", async () => {
		const started = manager.start("openai");
		const promptAbort = new AbortController();
		const localRemoval = vi.spyOn(promptAbort.signal, "removeEventListener");
		const flowRemoval = vi.spyOn(interaction.signal!, "removeEventListener");
		const answer = interaction.prompt({ type: "manual_code", message: "Paste redirect", signal: promptAbort.signal });
		const rejection = expect(answer).rejects.toMatchObject({ name: "AbortError", message: "Login prompt cancelled" });
		const promptId = manager.get(started.loginId).prompt?.id ?? "";
		expect(manager.get(started.loginId).prompt).not.toHaveProperty("signal");
		promptAbort.abort(new Error("private-callback-state"));
		await rejection;
		expect(manager.get(started.loginId).status).toBe("pending");
		expect(manager.get(started.loginId).prompt).toBeUndefined();
		expect(interaction.signal?.aborted).toBe(false);
		expect(localRemoval).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(flowRemoval).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(() => manager.submit(started.loginId, promptId, "private-stale-code")).toThrow("prompt changed");
		interaction.notify({ type: "progress", message: "Exchanging authorization code" });
		completion.resolve(credential);
		await completion.promise;
		expect(manager.get(started.loginId).status).toBe("completed");
		expect(JSON.stringify(manager.get(started.loginId))).not.toContain("private-");
	});

	it("disposes submitted prompt listeners before a later prompt can be cancelled by the old signal", async () => {
		const started = manager.start("openai");
		const firstAbort = new AbortController();
		const localRemoval = vi.spyOn(firstAbort.signal, "removeEventListener");
		const first = interaction.prompt({ type: "text", message: "First step", signal: firstAbort.signal });
		manager.submit(started.loginId, manager.get(started.loginId).prompt?.id ?? "", "first-value");
		await expect(first).resolves.toBe("first-value");
		const second = interaction.prompt({ type: "text", message: "Second step" });
		const secondId = manager.get(started.loginId).prompt?.id ?? "";
		firstAbort.abort();
		expect(localRemoval).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(manager.get(started.loginId).prompt?.id).toBe(secondId);
		manager.submit(started.loginId, secondId, "second-value");
		await expect(second).resolves.toBe("second-value");
		completion.resolve(credential);
		await completion.promise;
	});

	it("rejects already-aborted and concurrent prompts without overwriting the current prompt", async () => {
		const started = manager.start("openai");
		await expect(
			interaction.prompt({ type: "text", message: "Gone", signal: AbortSignal.abort("private-reason") }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(manager.get(started.loginId).prompt).toBeUndefined();
		const first = interaction.prompt({ type: "text", message: "Current" });
		const firstId = manager.get(started.loginId).prompt?.id ?? "";
		await expect(interaction.prompt({ type: "secret", message: "Unexpected" })).rejects.toThrow("already pending");
		expect(manager.get(started.loginId).prompt?.id).toBe(firstId);
		manager.submit(started.loginId, firstId, "");
		await expect(first).resolves.toBe("");
	});

	it("holds the single-flight guard after cancellation until the SDK settles, then allows a new login", async () => {
		const started = manager.start("openai");
		const oldInteraction = interaction;
		const answer = interaction.prompt({ type: "secret", message: "Pending secret" });
		const rejection = expect(answer).rejects.toMatchObject({ name: "AbortError" });
		const promptId = manager.get(started.loginId).prompt?.id ?? "";
		expect(() => manager.start("openai-codex")).toThrow("still active");
		expect(manager.cancel(started.loginId).status).toBe("cancelled");
		await rejection;
		expect(oldInteraction.signal?.aborted).toBe(true);
		expect(manager.get(started.loginId).prompt).toBeUndefined();
		expect(() => manager.start("openai-codex")).toThrow("still active");
		expect(() => manager.submit(started.loginId, promptId, "private-cancelled-value")).toThrow("prompt changed");
		oldInteraction.notify({ type: "progress", message: "late notification" });
		expect(manager.get(started.loginId).events).toEqual([]);
		completion.resolve(credential);
		await completion.promise;
		expect(manager.get(started.loginId).status).toBe("cancelled");
		completion = Promise.withResolvers<Credential>();
		const restarted = manager.start("openai-codex");
		expect(restarted.loginId).not.toBe(started.loginId);
		expect(() => manager.cancel(started.loginId)).toThrow("not found");
		expect(manager.get(restarted.loginId).status).toBe("pending");
		expect(interaction.signal?.aborted).toBe(false);
	});

	it("aborts the SDK and waits for cleanup on host shutdown", async () => {
		let sdkDisposed = false;
		vi.mocked(runtime.login).mockImplementationOnce(async (_provider, _type, callbacks) => {
			interaction = callbacks;
			try {
				await callbacks.prompt({ type: "manual_code", message: "Waiting for callback" });
				return credential;
			} finally {
				sdkDisposed = true;
			}
		});
		const started = manager.start("openai");
		await manager.close();
		expect(sdkDisposed).toBe(true);
		expect(interaction.signal?.aborted).toBe(true);
		expect(manager.get(started.loginId).status).toBe("cancelled");
		expect(manager.get(started.loginId).prompt).toBeUndefined();
		expect(() => manager.start("openai")).toThrow("shuts down");
		await manager.close();
	});

	it("bounds pending lifetime at ten minutes and preserves timeout status while cleanup finishes", async () => {
		vi.useFakeTimers();
		const started = manager.start("openai");
		const answer = interaction.prompt({ type: "manual_code", message: "Waiting for callback" });
		const rejection = expect(answer).rejects.toMatchObject({ name: "AbortError" });
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
		expect(manager.get(started.loginId).status).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
		expect(manager.get(started.loginId)).toMatchObject({
			status: "failed",
			error: "Account login timed out. Try again.",
		});
		expect(manager.get(started.loginId).prompt).toBeUndefined();
		expect(interaction.signal?.aborted).toBe(true);
		expect(() => manager.start("openai-codex")).toThrow("still active");
		completion.resolve(credential);
		await completion.promise;
		expect(manager.get(started.loginId).status).toBe("failed");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains bounded independent interaction metadata, not extra credential fields", async () => {
		const started = manager.start("openai");
		for (let index = 0; index < 90; index++) interaction.notify({ type: "progress", message: `step ${index}` });
		const event = {
			type: "info" as const,
			message: "Continue sign-in",
			links: [{ url: "https://example.com/login", label: "Sign in", token: "private-extra-token" }],
			credential,
			cause: new Error("private-cause"),
		};
		interaction.notify(event);
		interaction.notify({
			type: "auth_url",
			url: "https://example.com/authorize?state=public-state",
			instructions: "Open the sign-in page",
		});
		event.links[0].label = "caller mutation";
		const snapshot = manager.get(started.loginId);
		expect(snapshot.events.length).toBeLessThanOrEqual(64);
		expect(snapshot.events[0]).not.toEqual({ type: "progress", message: "step 0" });
		expect(snapshot.events).toContainEqual({
			type: "info",
			message: "Continue sign-in",
			links: [{ url: "https://example.com/login", label: "Sign in" }],
		});
		snapshot.events[0] = { type: "progress", message: "client mutation" };
		expect(manager.get(started.loginId).events[0]).not.toEqual(snapshot.events[0]);
		completion.resolve(credential);
		await completion.promise;
		expect(JSON.stringify(manager.get(started.loginId))).not.toContain("private-");
		expect(manager.get(started.loginId)).not.toHaveProperty("credential");
	});

	it.each([
		Object.assign(new Error("private-token-in-sdk-error"), { credential, cause: { refresh: credential.refresh } }),
		new HttpError(418, "private-token-in-http-error"),
		"private-non-error-rejection",
	])("sanitizes every SDK rejection without carrying its credential or cause", async (failure) => {
		const started = manager.start("openai");
		completion.reject(failure);
		await completion.promise.catch(() => undefined);
		const view = manager.get(started.loginId);
		expect(view.status).toBe("failed");
		expect(view.error).toBe("Account login failed. Try again or check provider configuration.");
		expect(JSON.stringify(view)).not.toContain("private-");
		expect(view).not.toHaveProperty("credential");
		expect(view).not.toHaveProperty("cause");
		completion = Promise.withResolvers<Credential>();
		expect(manager.start("openai-codex").status).toBe("pending");
	});

	it("rejects unknown requests, unsupported providers and oversized input with safe HTTP errors", async () => {
		expect(() => manager.start(" ")).toThrow("provider is required");
		expect(() => manager.start("private-unknown-provider")).toThrow("Unknown model provider");
		expect(() => manager.start("key-only")).toThrow("does not support account login");
		expect(() => manager.get(" ")).toThrow("Invalid account login ID");
		expect(() => manager.get("unknown-id")).toThrow("not found");
		const started = manager.start("openai");
		const answer = interaction.prompt({ type: "text", message: "Optional input" });
		const promptId = manager.get(started.loginId).prompt?.id ?? "";
		expect(() => manager.submit(started.loginId, promptId, "a".repeat(16_385))).toThrow("Invalid login prompt input");
		expect(manager.get(started.loginId).prompt?.id).toBe(promptId);
		manager.submit(started.loginId, promptId, "");
		await answer;
	});

	it("redacts credential-bearing catalogue failures before they become HTTP errors", () => {
		runtime.getProviders = () => {
			throw Object.assign(new Error(credential.access), { credential });
		};
		let failure: unknown;
		try {
			manager.start("openai");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(HttpError);
		expect(String(failure)).not.toContain("private-");
		expect(failure).not.toHaveProperty("credential");
		expect(failure).not.toHaveProperty("cause");
	});

	it("validates strict bounded request bodies and permits empty optional text answers", () => {
		expect(Check(authLoginSchema, { provider: "openai" })).toBe(true);
		for (const body of [{ provider: "" }, { provider: 1 }, { provider: "openai", key: "private-key" }])
			expect(Check(authLoginSchema, body)).toBe(false);
		expect(Check(authLoginPromptSchema, { promptId: "prompt", value: "" })).toBe(true);
		for (const body of [
			{ value: "code" },
			{ promptId: "prompt", value: 1 },
			{ promptId: "prompt", value: "a".repeat(16_385) },
			{ promptId: "prompt", value: "code", credential },
		])
			expect(Check(authLoginPromptSchema, body)).toBe(false);
	});
});
