import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/server/artifacts.ts";
import { BrowserManager } from "../src/server/tools/browser.ts";

describe("Playwright browser consumer boundaries (requires installed Chromium)", () => {
	let server: Server;
	let base: string;
	let artifacts: ArtifactStore;
	let manager: BrowserManager;
	let barrier = Promise.withResolvers<void>();
	let barrierResponse: ServerResponse | undefined;
	beforeEach(async () => {
		barrier = Promise.withResolvers<void>();
		barrierResponse = undefined;
		server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://fixture");
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			if (url.pathname === "/barrier") {
				barrierResponse = response;
				barrier.resolve();
				return;
			}
			if (url.pathname === "/missing") {
				response.writeHead(404);
				response.end("<title>Missing</title><body>Not found</body>");
				return;
			}
			if (url.pathname === "/done") {
				response.end(`<title>Done</title><body>Submitted ${url.searchParams.get("q") ?? ""}</body>`);
				return;
			}
			response.end(
				`<!doctype html><title>Fixture</title><body><a href="/missing">Missing link</a><form action="/done"><input id="query" name="q" aria-label="Query"><button type="submit">Submit</button></form><button id="popup" onclick="window.open('/missing')">Popup</button></body>`,
			);
		});
		const listening = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await listening;
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		artifacts = new ArtifactStore();
		manager = new BrowserManager(artifacts);
	});
	afterEach(async () => {
		await manager.close();
		artifacts.close();
		server.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		server.close((error) => (error ? closed.reject(error) : closed.resolve()));
		await closed.promise;
	});

	it("opens, reads, fills, presses, navigates and returns a real PNG artifact", async () => {
		const opened = await manager.execute("parent-session", "parent-agent", { action: "open", url: base });
		const tabId = opened.details.tabId;
		expect(opened.details).toMatchObject({ action: "open", title: "Fixture", status: 200 });
		const read = await manager.execute("parent-session", "parent-agent", { action: "read", tabId });
		expect(read.details.text).toContain("Submit");
		expect(read.details.candidates).toEqual(
			expect.arrayContaining([expect.objectContaining({ tag: "input", name: "Query", id: "query" })]),
		);
		await manager.execute("parent-session", "parent-agent", {
			action: "fill",
			tabId,
			selector: "#query",
			value: "unicode-雪",
		});
		await manager.execute("parent-session", "parent-agent", {
			action: "press",
			tabId,
			selector: "#query",
			key: "Enter",
		});
		await expect
			.poll(
				async () =>
					(await manager.execute("parent-session", "parent-agent", { action: "read", tabId })).details.text,
			)
			.toContain("unicode-雪");
		const missing = await manager.execute("parent-session", "parent-agent", {
			action: "navigate",
			tabId,
			url: `${base}/missing`,
		});
		expect(missing.details).toMatchObject({ status: 404, title: "Missing" });
		const screenshot = await manager.execute("parent-session", "parent-agent", {
			action: "screenshot",
			tabId,
			fullPage: true,
		});
		expect(screenshot.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
		const artifact = screenshot.details.artifact as { id: string; url: string };
		expect(artifact.url).toBe(`/api/artifacts/${artifact.id}`);
		expect(artifacts.get(artifact.id)?.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		await manager.execute("parent-session", "parent-agent", { action: "close", tabId });
		await expect(manager.execute("parent-session", "parent-agent", { action: "read", tabId })).rejects.toThrow(
			"closed",
		);
	});

	it("registers popup tabs and keeps parent and child contexts and tab IDs isolated", async () => {
		const parent = await manager.execute("parent", "parent-agent", { action: "open", url: base });
		await manager.execute("parent", "parent-agent", {
			action: "evaluate",
			tabId: parent.details.tabId,
			expression: "document.cookie = 'onlyParent=yes; path=/'; document.cookie",
		});
		const child = await manager.execute("child", "child-agent", { action: "open", url: base });
		const cookies = await manager.execute("child", "child-agent", {
			action: "evaluate",
			tabId: child.details.tabId,
			expression: "document.cookie",
		});
		expect(cookies.details.value).toBe("");
		await expect(
			manager.execute("child", "child-agent", { action: "read", tabId: parent.details.tabId }),
		).rejects.toThrow("belongs to another agent");
		await manager.execute("parent", "parent-agent", {
			action: "click",
			tabId: parent.details.tabId,
			selector: "#popup",
		});
		await expect
			.poll(async () => {
				const tabs = await manager.execute("parent", "parent-agent", { action: "tabs" });
				return (tabs.details.tabs as unknown[]).length;
			})
			.toBe(2);
		await manager.closeSession("child");
		const parentTabs = await manager.execute("parent", "parent-agent", { action: "tabs" });
		expect(parentTabs.details.tabs).toHaveLength(2);
		const newChild = await manager.execute("child", "child-agent", { action: "tabs" });
		expect(newChild.details.tabs).toEqual([]);
	});

	it("serializes competing tab operations and marks read truncation", async () => {
		const opened = await manager.execute("session", "agent", { action: "open", url: base });
		const tabId = opened.details.tabId;
		const first = manager.execute("session", "agent", {
			action: "evaluate",
			tabId,
			expression:
				"(async () => { window.sequence = []; await fetch('/barrier'); window.sequence.push(1); return window.sequence; })()",
		});
		const second = manager.execute("session", "agent", {
			action: "evaluate",
			tabId,
			expression: "window.sequence.push(2); window.sequence",
		});
		await barrier.promise;
		if (!barrierResponse) throw new Error("Fixture barrier was not entered");
		barrierResponse.end();
		await Promise.all([first, second]);
		const sequence = await manager.execute("session", "agent", {
			action: "evaluate",
			tabId,
			expression: "window.sequence",
		});
		expect(sequence.details.value).toEqual([1, 2]);
		await manager.execute("session", "agent", {
			action: "evaluate",
			tabId,
			expression: "document.body.textContent = '雪'.repeat(40000)",
		});
		const read = await manager.execute("session", "agent", { action: "read", tabId });
		expect(read.details.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(read.details), "utf8")).toBeLessThanOrEqual(64 * 1024);
	});

	it("closes the operated tab on cancellation, and closes contexts on stop", async () => {
		const opened = await manager.execute("session", "agent", { action: "open", url: base });
		const controller = new AbortController();
		const operation = manager.execute(
			"session",
			"agent",
			{ action: "evaluate", tabId: opened.details.tabId, expression: "fetch('/barrier')" },
			controller.signal,
		);
		await barrier.promise;
		controller.abort();
		await expect(operation).rejects.toThrow();
		await expect
			.poll(async () => {
				const tabs = await manager.execute("session", "agent", { action: "tabs" });
				return (tabs.details.tabs as unknown[]).length;
			})
			.toBe(0);
		const another = await manager.execute("session", "agent", { action: "open", url: base });
		barrier = Promise.withResolvers<void>();
		const pending = manager.execute("session", "agent", {
			action: "evaluate",
			tabId: another.details.tabId,
			expression: "fetch('/barrier')",
		});
		const rejected = expect(pending).rejects.toThrow();
		await barrier.promise;
		await manager.closeSession("session");
		await rejected;
	});

	it("rejects non-HTTP navigation before launching a browser", async () => {
		await expect(
			manager.execute("session", "agent", { action: "open", url: "file:///private-file" }),
		).rejects.toThrow("http and https only");
		await expect(manager.execute("session", "agent", { action: "open", url: "javascript:alert(1)" })).rejects.toThrow(
			"http and https only",
		);
	});
});
