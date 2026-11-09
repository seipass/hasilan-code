import { parentPort } from "node:worker_threads";
import { BrowserManager } from "./browser.ts";

if (!parentPort) throw new Error("Browser worker requires a parent port");
const port = parentPort;
const controllers = new Map<number, AbortController>();
const browser = new BrowserManager({
	put: ({ bytes, mimeType }) => ({ id: "worker", url: "", size: bytes.length, mimeType }),
});

port.on("message", (message: { id: number; op: string; sessionId?: string; agentId?: string; input?: unknown }) => {
	if (message.op === "abort") {
		controllers.get(message.id)?.abort();
		return;
	}
	void (async () => {
		switch (message.op) {
			case "status":
				return browser.status();
			case "execute": {
				const controller = new AbortController();
				controllers.set(message.id, controller);
				try {
					return await browser.execute(message.sessionId!, message.agentId!, message.input, controller.signal);
				} finally {
					controllers.delete(message.id);
				}
			}
			case "closeSession":
				return browser.closeSession(message.sessionId!);
			case "close":
				return browser.close();
			default:
				throw new Error("Unknown browser worker operation");
		}
	})().then(
		(result) => port.postMessage({ id: message.id, result }),
		(error) => port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }),
	);
});
