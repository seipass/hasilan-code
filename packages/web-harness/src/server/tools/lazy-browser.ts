import { Worker } from "node:worker_threads";
import type { AgentToolResult, ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { Check } from "typebox/value";
import type { ArtifactStore } from "../artifacts.ts";
import { type BrowserStatus, type BrowserToolDetails, browserSchema } from "./browser-schema.ts";

interface Reply {
	id: number;
	result?: unknown;
	error?: string;
}

class BrowserWorker {
	private readonly worker: Worker;
	private nextId = 0;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private failed?: Error;

	constructor() {
		const file = import.meta.url.endsWith(".ts") ? "./browser-worker.ts" : "./browser-worker.js";
		this.worker = new Worker(new URL(file, import.meta.url));
		this.worker.on("message", (reply: Reply) => {
			const pending = this.pending.get(reply.id);
			if (!pending) return;
			this.pending.delete(reply.id);
			if (reply.error) pending.reject(new Error(reply.error));
			else pending.resolve(reply.result);
		});
		this.worker.on("error", (error) => this.fail(error));
		this.worker.on("exit", () => this.fail(new Error("Browser worker stopped")));
	}

	private fail(error: Error): void {
		this.failed = error;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	request(
		op: string,
		args: { sessionId?: string; agentId?: string; input?: unknown } = {},
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.failed) return Promise.reject(this.failed);
		signal?.throwIfAborted();
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const abort = () => this.worker.postMessage({ id, op: "abort" });
			const cleanup = () => signal?.removeEventListener("abort", abort);
			this.pending.set(id, {
				resolve: (value) => {
					cleanup();
					resolve(value);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			signal?.addEventListener("abort", abort, { once: true });
			try {
				this.worker.postMessage({ id, op, ...args });
			} catch (error) {
				this.pending.delete(id);
				cleanup();
				reject(error);
				return;
			}
			if (signal?.aborted) abort();
		});
	}

	async terminate(): Promise<void> {
		await this.worker.terminate();
	}
}

/** Load Playwright only while the browser tool or its settings status is used. */
export class LazyBrowserManager {
	private readonly artifacts: Pick<ArtifactStore, "put">;
	private worker?: BrowserWorker;
	private closed = false;

	constructor(artifacts: Pick<ArtifactStore, "put">) {
		this.artifacts = artifacts;
	}

	async status(): Promise<BrowserStatus> {
		if (this.worker) return (await this.worker.request("status")) as BrowserStatus;
		const worker = new BrowserWorker();
		try {
			return (await worker.request("status")) as BrowserStatus;
		} finally {
			await worker.terminate();
		}
	}

	createTool(sessionId: string, agentId: string): ToolDefinition<typeof browserSchema, BrowserToolDetails> {
		return {
			name: "browser",
			label: "Browser",
			description:
				"Operate the built-in Playwright Chromium browser. Each agent session has an isolated context. Use explicit tabId for every tab action; tabs includes popups. open/navigate accept http/https URLs only. read returns visible body text and candidate selectors (maximum 64 KiB, truncation reported). evaluate runs a JavaScript expression inside the page, not Node or the host. Screenshot returns a PNG image. Cancellation closes the operated tab.",
			promptSnippet: "Use Chromium tabs to navigate, read, interact, evaluate page JavaScript, and screenshot",
			parameters: browserSchema,
			execute: (_id, input, signal) => this.execute(sessionId, agentId, input, signal),
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
		if (this.closed) throw new Error("Browser manager is closed");
		if (input.action === "navigate" || (input.action === "open" && input.url)) {
			let url: URL;
			try {
				url = new URL(input.url as string);
			} catch {
				throw new Error("Browser navigation requires an absolute http or https URL");
			}
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new Error("Browser navigation supports http and https only");
		}
		this.worker ??= new BrowserWorker();
		const result = (await this.worker.request(
			"execute",
			{ sessionId, agentId, input },
			signal,
		)) as AgentToolResult<BrowserToolDetails>;
		if (input.action === "screenshot") {
			const image = result.content.find((part) => part.type === "image");
			if (!image || image.type !== "image") throw new Error("Browser screenshot is missing");
			const artifact = this.artifacts.put({
				sessionId,
				agentId,
				bytes: Buffer.from(image.data, "base64"),
				mimeType: "image/png",
			});
			result.details.artifact = artifact;
			result.content[0] = { type: "text", text: JSON.stringify(result.details) };
		}
		return result;
	}

	async closeSession(sessionId: string): Promise<void> {
		if (this.worker) await this.worker.request("closeSession", { sessionId });
	}

	async close(): Promise<void> {
		this.closed = true;
		const worker = this.worker;
		this.worker = undefined;
		if (!worker) return;
		try {
			await worker.request("close");
		} finally {
			await worker.terminate();
		}
	}
}
