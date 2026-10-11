import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, LoginOptions, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuthLoginPrompt, AuthLoginView } from "../shared/auth-login.ts";
import { HttpError } from "./http-host.ts";

export const authLoginSchema = Type.Object(
	{ provider: Type.String({ minLength: 1, maxLength: 256 }) },
	{ additionalProperties: false },
);
export const authLoginPromptSchema = Type.Object(
	{
		promptId: Type.String({ minLength: 1, maxLength: 128 }),
		value: Type.String({ maxLength: 16_384 }),
	},
	{ additionalProperties: false },
);

export type AuthLoginRuntime = Pick<ModelRuntime, "login" | "getProviders">;

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_EVENTS = 64;
const LOGIN_FAILURE = "Account login failed. Try again or check provider configuration.";

interface PendingPrompt {
	view: AuthLoginPrompt;
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	dispose: () => void;
}

interface LoginFlow {
	view: AuthLoginView;
	controller: AbortController;
	timeout?: NodeJS.Timeout;
	prompt?: PendingPrompt;
	operation?: Promise<void>;
}

function copyEvent(event: AuthEvent): AuthEvent {
	// Only SDK interaction metadata is public; never copy extra credential/error fields.
	switch (event.type) {
		case "info":
			return {
				type: event.type,
				message: event.message,
				links: event.links?.map((link) => ({ url: link.url, label: link.label })),
			};
		case "auth_url":
			return { type: event.type, url: event.url, instructions: event.instructions };
		case "device_code":
			return {
				type: event.type,
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				intervalSeconds: event.intervalSeconds,
				expiresInSeconds: event.expiresInSeconds,
			};
		case "progress":
			return { type: event.type, message: event.message };
	}
}

/** One host-owned SDK flow and one retained public snapshot, never a credential store. */
export class AuthLoginManager {
	private readonly runtime: AuthLoginRuntime;
	private readonly options: LoginOptions;
	private active?: LoginFlow;
	private current?: AuthLoginView;
	private closed = false;

	constructor(runtime: AuthLoginRuntime, options: LoginOptions = {}) {
		this.runtime = runtime;
		this.options = options;
	}

	start(providerId: string): AuthLoginView {
		if (this.closed) throw new HttpError(503, "Account login is unavailable while the host shuts down");
		if (this.active) throw new HttpError(409, "Another account login is still active");
		if (typeof providerId !== "string" || !providerId.trim() || providerId.length > 256)
			throw new HttpError(400, "A model provider is required");
		let provider: Provider | undefined;
		try {
			provider = this.runtime.getProviders().find((item) => item.id === providerId);
		} catch {
			throw new HttpError(500, LOGIN_FAILURE);
		}
		if (!provider) throw new HttpError(400, "Unknown model provider");
		if (!provider.auth.oauth) throw new HttpError(400, "This provider does not support account login");
		const flow: LoginFlow = {
			view: { loginId: randomUUID(), provider: providerId, status: "pending", events: [] },
			controller: new AbortController(),
		};
		this.active = flow;
		this.current = flow.view;
		flow.timeout = setTimeout(() => {
			this.finish(flow, "failed", "Account login timed out. Try again.");
		}, LOGIN_TIMEOUT_MS);
		flow.timeout.unref();
		flow.operation = this.run(flow);
		return structuredClone(flow.view);
	}

	get(loginId: string): AuthLoginView {
		return structuredClone(this.find(loginId));
	}

	submit(loginId: string, promptId: string, value: string): AuthLoginView {
		const view = this.find(loginId);
		const flow = this.active;
		const prompt = flow?.prompt;
		if (view.status !== "pending" || flow?.view !== view || !prompt || prompt.view.id !== promptId)
			throw new HttpError(409, "Login prompt changed or is no longer pending");
		if (typeof value !== "string" || value.length > 16_384) throw new HttpError(400, "Invalid login prompt input");
		if (prompt.view.type === "select" && !prompt.view.options?.some((option) => option.id === value))
			throw new HttpError(400, "Select one of the available login options");
		if ((prompt.view.type === "secret" || prompt.view.type === "manual_code") && !value.trim())
			throw new HttpError(400, "Login prompt input must not be empty");
		prompt.dispose();
		flow.prompt = undefined;
		delete view.prompt;
		// The entered value goes directly to the SDK, never into a snapshot or log.
		prompt.resolve(value);
		return structuredClone(view);
	}

	cancel(loginId: string): AuthLoginView {
		const view = this.find(loginId);
		if (this.active?.view === view) this.finish(this.active, "cancelled");
		return structuredClone(view);
	}

	close(): Promise<void> {
		this.closed = true;
		const flow = this.active;
		if (!flow) return Promise.resolve();
		this.finish(flow, "cancelled");
		return flow.operation ?? Promise.resolve();
	}

	private find(loginId: string): AuthLoginView {
		if (typeof loginId !== "string" || !loginId.trim() || loginId.length > 128)
			throw new HttpError(400, "Invalid account login ID");
		if (!this.current || this.current.loginId !== loginId) throw new HttpError(404, "Account login not found");
		return this.current;
	}

	private async run(flow: LoginFlow): Promise<void> {
		try {
			// ModelRuntime owns persistence, token refresh and the configured-model snapshot.
			// Discard the returned credential, including on synchronization failures.
			await this.runtime.login(
				flow.view.provider,
				"oauth",
				{
					signal: flow.controller.signal,
					prompt: (prompt) => this.prompt(flow, prompt),
					notify: (event) => {
						if (flow.view.status !== "pending") return;
						flow.view.events.push(copyEvent(event));
						if (flow.view.events.length > MAX_EVENTS) flow.view.events.shift();
					},
				},
				this.options,
			);
			this.finish(flow, "completed");
		} catch {
			// SDK errors and their causes may contain tokens, prompt input or credentials.
			this.finish(flow, "failed", LOGIN_FAILURE);
		} finally {
			// Keep the single-flight guard until ModelRuntime.login has settled after cancellation.
			if (this.active === flow) this.active = undefined;
		}
	}

	private prompt(flow: LoginFlow, input: AuthPrompt): Promise<string> {
		if (flow.view.status !== "pending" || flow.controller.signal.aborted || input.signal?.aborted)
			return Promise.reject(new DOMException("Login prompt cancelled", "AbortError"));
		if (flow.prompt) return Promise.reject(new Error("Another login prompt is already pending"));
		const answer = Promise.withResolvers<string>();
		const view: AuthLoginPrompt =
			input.type === "select"
				? {
						id: randomUUID(),
						type: input.type,
						message: input.message,
						options: input.options.map((option) => ({
							id: option.id,
							label: option.label,
							description: option.description,
						})),
					}
				: { id: randomUUID(), type: input.type, message: input.message, placeholder: input.placeholder };
		const onAbort = () => this.rejectPrompt(flow);
		const pending: PendingPrompt = {
			view,
			resolve: answer.resolve,
			reject: answer.reject,
			dispose: () => {
				flow.controller.signal.removeEventListener("abort", onAbort);
				input.signal?.removeEventListener("abort", onAbort);
			},
		};
		flow.prompt = pending;
		flow.view.prompt = view;
		flow.controller.signal.addEventListener("abort", onAbort, { once: true });
		input.signal?.addEventListener("abort", onAbort, { once: true });
		return answer.promise;
	}

	private rejectPrompt(flow: LoginFlow): void {
		const prompt = flow.prompt;
		if (!prompt) return;
		prompt.dispose();
		flow.prompt = undefined;
		delete flow.view.prompt;
		prompt.reject(new DOMException("Login prompt cancelled", "AbortError"));
	}

	private finish(flow: LoginFlow, status: AuthLoginView["status"], error?: string): void {
		if (flow.view.status !== "pending") return;
		flow.view.status = status;
		if (error) flow.view.error = error;
		clearTimeout(flow.timeout);
		flow.timeout = undefined;
		this.rejectPrompt(flow);
		flow.controller.abort();
	}
}
