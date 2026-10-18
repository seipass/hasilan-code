import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentToolResult, ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { ArtifactStore } from "../artifacts.ts";

const tabIdSchema = Type.String({ minLength: 1 });
const selectorSchema = Type.String({ minLength: 1 });
export const browserSchema = Type.Union([
	Type.Object(
		{ action: Type.Literal("open"), url: Type.Optional(Type.String({ minLength: 1 })) },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("tabs") }, { additionalProperties: false }),
	Type.Object(
		{ action: Type.Literal("navigate"), tabId: tabIdSchema, url: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("read"), tabId: tabIdSchema }, { additionalProperties: false }),
	Type.Object(
		{ action: Type.Literal("click"), tabId: tabIdSchema, selector: selectorSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("fill"), tabId: tabIdSchema, selector: selectorSchema, value: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("press"),
			tabId: tabIdSchema,
			selector: selectorSchema,
			key: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("screenshot"), tabId: tabIdSchema, fullPage: Type.Optional(Type.Boolean()) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("evaluate"), tabId: tabIdSchema, expression: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("close"), tabId: tabIdSchema }, { additionalProperties: false }),
]);
export type BrowserInput = Static<typeof browserSchema>;
export interface BrowserToolDetails {
	action: BrowserInput["action"];
	[key: string]: unknown;
}
export interface BrowserStatus {
	ready: boolean;
	error?: string;
}
interface Tab {
	id: string;
	page: Page;
	queue: Promise<void>;
	status: number | null;
}
interface SessionBrowser {
	agentId: string;
	context: BrowserContext;
	tabs: Map<string, Tab>;
}
const installMessage = "Chromium is not installed. Run npx playwright install chromium";

function truncateUtf8(text: string, limit: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	let end = limit;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function navigationUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Browser navigation requires an absolute http or https URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Browser navigation supports http and https only");
	return url.href;
}

/** Browser contexts belong to agent sessions; no default/current tab is shared. */
export class BrowserManager {
	private readonly artifacts: Pick<ArtifactStore, "put">;
	private browser: Promise<Browser> | undefined;
	private readonly sessions = new Map<string, Promise<SessionBrowser>>();
	private readonly closingSessions = new Map<string, Promise<void>>();
	private closed = false;
	private launchError: string | undefined;

	constructor(artifacts: Pick<ArtifactStore, "put">) {
		this.artifacts = artifacts;
	}

	status(): BrowserStatus {
		if (!existsSync(chromium.executablePath())) return { ready: false, error: installMessage };
		return this.launchError ? { ready: false, error: this.launchError } : { ready: true };
	}

	createTool(sessionId: string, agentId: string): ToolDefinition<typeof browserSchema, BrowserToolDetails> {
		return {
			name: "browser",
			label: "Browser",
			description:
				"Operate the built-in Playwright Chromium browser. Each agent session has an isolated context. Use explicit tabId for every tab action; tabs includes popups. open/navigate accept http/https URLs only. read returns visible body text and candidate selectors (maximum 64 KiB, truncation reported). evaluate runs a JavaScript expression inside the page, not Node or the host. Screenshot returns a PNG image. Cancellation closes the operated tab.",
			promptSnippet: "Use Chromium tabs to navigate, read, interact, evaluate page JavaScript, and screenshot",
			parameters: browserSchema,
			execute: (_toolCallId, params, signal) => this.execute(sessionId, agentId, params, signal),
		};
	}

	async execute(
		sessionId: string,
		agentId: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!Check(browserSchema, input)) throw new Error("Invalid browser action or arguments");
		signal?.throwIfAborted();
		// Validate before launching Chromium or creating a tab.
		const url =
			input.action === "navigate" || (input.action === "open" && input.url)
				? navigationUrl(input.url as string)
				: undefined;
		const session = await this.getSession(sessionId, agentId);
		signal?.throwIfAborted();
		if (input.action === "tabs") {
			const tabs = await Promise.all(
				[...session.tabs.values()].map((tab) => this.enqueue(tab, signal, () => this.describeTab(tab))),
			);
			return { content: [{ type: "text", text: JSON.stringify({ tabs }) }], details: { action: "tabs", tabs } };
		}
		let tab: Tab;
		if (input.action === "open") {
			const page = await session.context.newPage();
			tab = this.registerTab(session, page);
		} else {
			const found = session.tabs.get(input.tabId);
			if (!found || found.page.isClosed())
				throw new Error("Tab is closed, unknown, or belongs to another agent session");
			tab = found;
		}
		return this.enqueue(tab, signal, async () => {
			const page = tab.page;
			let details: BrowserToolDetails;
			switch (input.action) {
				case "open":
				case "navigate": {
					if (url) {
						const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
						tab.status = response?.status() ?? null;
					}
					details = { action: input.action, ...(await this.describeTab(tab)) };
					break;
				}
				case "read": {
					const [text, candidates, description] = await Promise.all([
						page.locator("body").innerText({ timeout: 10_000 }),
						page.locator("a,button,input,select,textarea").evaluateAll((elements) => ({
							count: elements.length,
							items: elements.slice(0, 256).map((element, index) => ({
								tag: element.tagName.toLowerCase(),
								text: (element.textContent ?? "").trim().slice(0, 512),
								role: element.getAttribute("role") ?? "",
								name: (element.getAttribute("aria-label") ?? element.getAttribute("name") ?? "").slice(0, 512),
								id: element.id.slice(0, 512),
								selector: `:nth-match(a,button,input,select,textarea,${index + 1})`,
							})),
						})),
						this.describeTab(tab),
					]);
					const result = {
						...description,
						url: truncateUtf8(description.url, 4096),
						title: truncateUtf8(description.title, 4096),
						text: truncateUtf8(text, 48 * 1024),
						candidates: candidates.items,
						truncated: candidates.count > candidates.items.length,
					};
					result.truncated ||=
						result.text !== text || result.url !== description.url || result.title !== description.title;
					while (result.candidates.length && Buffer.byteLength(JSON.stringify(result), "utf8") > 64 * 1024 - 32) {
						result.candidates.pop();
						result.truncated = true;
					}
					while (Buffer.byteLength(JSON.stringify(result), "utf8") > 64 * 1024 - 32) {
						result.text = truncateUtf8(result.text, Math.floor(Buffer.byteLength(result.text, "utf8") * 0.8));
						result.truncated = true;
					}
					details = { action: "read", ...result };
					break;
				}
				case "click":
					await page.locator(input.selector).click({ timeout: 10_000 });
					details = { action: "click", ...(await this.describeTab(tab)) };
					break;
				case "fill":
					await page.locator(input.selector).fill(input.value, { timeout: 10_000 });
					details = { action: "fill", ...(await this.describeTab(tab)) };
					break;
				case "press":
					await page.locator(input.selector).press(input.key, { timeout: 10_000 });
					details = { action: "press", ...(await this.describeTab(tab)) };
					break;
				case "evaluate": {
					const value: unknown = await page.evaluate(input.expression);
					details = { action: "evaluate", ...(await this.describeTab(tab)), value };
					break;
				}
				case "screenshot": {
					const bytes = await page.screenshot({ type: "png", fullPage: input.fullPage ?? false, timeout: 10_000 });
					signal?.throwIfAborted();
					const artifact = this.artifacts.put({ sessionId, agentId, bytes, mimeType: "image/png" });
					details = { action: "screenshot", ...(await this.describeTab(tab)), artifact };
					return {
						content: [
							{ type: "text", text: JSON.stringify(details) },
							{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
						],
						details,
					};
				}
				case "close":
					await page.close();
					details = { action: "close", tabId: tab.id, closed: true };
					break;
			}
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		});
	}

	closeSession(sessionId: string): Promise<void> {
		const existing = this.closingSessions.get(sessionId);
		if (existing) return existing;
		const pending = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		const closing = (async () => {
			if (!pending) return;
			let session: SessionBrowser;
			try {
				session = await pending;
			} catch {
				return;
			}
			await session.context.close();
		})();
		this.closingSessions.set(sessionId, closing);
		void closing
			.finally(() => {
				if (this.closingSessions.get(sessionId) === closing) this.closingSessions.delete(sessionId);
			})
			.catch(() => undefined);
		return closing;
	}

	async close(): Promise<void> {
		this.closed = true;
		const contextResults = await Promise.allSettled([
			...this.closingSessions.values(),
			...[...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)),
		]);
		if (this.browser) {
			let browser: Browser | undefined;
			try {
				browser = await this.browser;
			} catch {
				/* Failed launch owns no process. */
			}
			if (browser) await browser.close();
		}
		this.browser = undefined;
		const failure = contextResults.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw new Error("One or more browser contexts could not be closed");
	}

	private async getBrowser(): Promise<Browser> {
		if (this.closed) throw new Error("Browser manager is closed");
		if (!this.browser) {
			const launching = chromium.launch({ headless: true });
			this.browser = launching;
			try {
				const browser = await launching;
				this.launchError = undefined;
				browser.on("disconnected", () => {
					if (this.browser === launching) {
						this.browser = undefined;
						this.sessions.clear();
					}
				});
				return browser;
			} catch {
				if (this.browser === launching) this.browser = undefined;
				this.launchError = existsSync(chromium.executablePath())
					? "Chromium could not start; check the Playwright installation and host configuration"
					: installMessage;
				throw new Error(this.launchError);
			}
		}
		try {
			return await this.browser;
		} catch {
			throw new Error(this.launchError ?? installMessage);
		}
	}

	private async getSession(sessionId: string, agentId: string): Promise<SessionBrowser> {
		if (this.closed) throw new Error("Browser manager is closed");
		if (this.closingSessions.has(sessionId)) throw new Error("Agent browser context is closing");
		let pending = this.sessions.get(sessionId);
		if (!pending) {
			pending = (async () => {
				const browser = await this.getBrowser();
				const context = await browser.newContext();
				context.setDefaultTimeout(10_000);
				context.setDefaultNavigationTimeout(30_000);
				const session: SessionBrowser = { agentId, context, tabs: new Map() };
				context.on("page", (page) => {
					this.registerTab(session, page);
				});
				context.on("close", () => {
					if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId);
				});
				return session;
			})();
			this.sessions.set(sessionId, pending);
		}
		let session: SessionBrowser;
		try {
			session = await pending;
		} catch (error) {
			if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId);
			throw error;
		}
		if (session.agentId !== agentId) throw new Error("Browser context belongs to another agent");
		if (this.closed || this.closingSessions.has(sessionId) || this.sessions.get(sessionId) !== pending)
			throw new Error("Agent browser context is closed or closing");
		return session;
	}

	private registerTab(session: SessionBrowser, page: Page): Tab {
		for (const tab of session.tabs.values()) if (tab.page === page) return tab;
		const tab: Tab = { id: randomUUID(), page, queue: Promise.resolve(), status: null };
		session.tabs.set(tab.id, tab);
		page.on("close", () => {
			session.tabs.delete(tab.id);
		});
		page.on("response", (response) => {
			if (response.request().isNavigationRequest() && response.frame() === page.mainFrame())
				tab.status = response.status();
		});
		return tab;
	}

	private async describeTab(tab: Tab): Promise<{ tabId: string; url: string; title: string; status: number | null }> {
		return { tabId: tab.id, url: tab.page.url(), title: await tab.page.title(), status: tab.status };
	}

	private enqueue<T>(tab: Tab, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => {
			aborted.reject(new Error("Browser operation cancelled; tab closed"));
			void tab.page.close().catch(() => undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const queued = tab.queue.then(async () => {
			signal?.throwIfAborted();
			if (tab.page.isClosed()) throw new Error("Tab is closed");
			return operation();
		});
		// Keep subsequent operations behind actual Playwright settlement, not only cancellation.
		tab.queue = queued.then(
			() => undefined,
			() => undefined,
		);
		if (signal?.aborted) onAbort();
		return Promise.race([queued, aborted.promise]).finally(() => {
			signal?.removeEventListener("abort", onAbort);
		});
	}
}
