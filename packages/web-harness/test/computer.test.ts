import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/server/artifacts.ts";
import type { DesktopBackend, DesktopFrame, DesktopRequest } from "../src/server/tools/computer/backend.ts";
import { ComputerManager } from "../src/server/tools/computer/index.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1EAAAAASUVORK5CYII=",
	"base64",
);

describe("Computer tool boundaries", () => {
	let backend: DesktopBackend;
	let artifacts: ArtifactStore;
	let manager: ComputerManager;
	let frame: DesktopFrame;
	beforeEach(() => {
		frame = { bounds: { left: -100, top: 20, width: 100, height: 50 }, width: 200, height: 100, png };
		backend = {
			status: vi.fn(async () => ({ ready: true, platform: "test", setup: [] })),
			screens: vi.fn(async () => [{ index: 1, ...frame.bounds }]),
			frame: vi.fn(async () => frame),
			close: vi.fn(async () => undefined),
		};
		artifacts = new ArtifactStore();
		manager = new ComputerManager(backend, artifacts);
	});
	afterEach(async () => {
		await manager.close();
		artifacts.close();
	});

	it("returns an owned image artifact and maps Retina pixels to a monitor with a negative origin", async () => {
		const screenshot = await manager.execute("s1", "a1", { action: "screenshot" });
		expect(screenshot.content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
		expect(artifacts.get(screenshot.details.artifact?.id ?? "")).toMatchObject({
			sessionId: "s1",
			agentId: "a1",
			bytes: png,
		});
		const clicked = await manager.execute("s1", "a1", {
			action: "click",
			frameId: screenshot.details.frameId,
			x: 80,
			y: 40,
			button: "right",
			count: 2,
		});
		expect(backend.frame).toHaveBeenLastCalledWith(
			{ action: "click", monitor: 1, bounds: frame.bounds, x: -60, y: 40, button: "right", count: 2 },
			expect.any(AbortSignal),
		);
		expect(clicked.details.frameId).not.toBe(screenshot.details.frameId);
		await expect(
			manager.execute("s1", "a1", { action: "type", frameId: screenshot.details.frameId, text: "stale" }),
		).rejects.toThrow("latest screenshot");
	});

	it.each([
		{ action: "click", x: -1, y: 0 },
		{ action: "click", x: 0, y: 0, count: 100 },
		{ action: "press", key: "enter", modifiers: ["ctrl", "ctrl"] },
		{ action: "press", key: "eval('code')" },
		{ action: "type", text: "" },
		{ action: "type", text: "x".repeat(2001) },
		{ action: "screenshot", expression: "code" },
	])("rejects invalid arguments before opening a desktop helper: %j", async (input) => {
		await expect(manager.execute("s1", "a1", { frameId: "fake", ...input })).rejects.toThrow("Invalid computer");
		expect(backend.frame).not.toHaveBeenCalled();
	});

	it("requires a current frame and rejects off-screen drag destinations before sending input", async () => {
		await expect(manager.execute("s1", "a1", { action: "press", frameId: "fake", key: "enter" })).rejects.toThrow(
			"latest screenshot",
		);
		const screenshot = await manager.execute("s1", "a1", { action: "screenshot", monitor: 2 });
		await expect(
			manager.execute("s1", "a1", {
				action: "drag",
				frameId: screenshot.details.frameId,
				x: 0,
				y: 0,
				toX: 200,
				toY: 1,
			}),
		).rejects.toThrow("outside");
		expect(backend.frame).toHaveBeenCalledTimes(1);
		await manager.execute("s1", "a1", {
			action: "drag",
			frameId: screenshot.details.frameId,
			x: 0,
			y: 0,
			toX: 100,
			toY: 80,
		});
		expect(backend.frame).toHaveBeenLastCalledWith(
			expect.objectContaining({ monitor: 2, x: -100, y: 20, toX: -50, toY: 60 }),
			expect.any(AbortSignal),
		);
	});

	it("isolates control by both session and agent and makes it available on release/Stop", async () => {
		await manager.execute("s1", "a1", { action: "screenshot" });
		await expect(manager.execute("s2", "a2", { action: "screenshot" })).rejects.toThrow("another agent");
		await expect(manager.execute("s1", "a2", { action: "release" })).rejects.toThrow("another agent");
		expect((await manager.execute("s2", "a2", { action: "screens" })).details.busy).toBe(true);
		await manager.execute("s1", "a1", { action: "release" });
		await manager.execute("s2", "a2", { action: "screenshot" });
		await manager.closeSession("s2");
		await expect(manager.execute("s1", "a1", { action: "screenshot" })).resolves.toBeDefined();
	});

	it("invalidates the old frame if input succeeds but the next screenshot fails", async () => {
		const screenshot = await manager.execute("s1", "a1", { action: "screenshot" });
		vi.mocked(backend.frame).mockRejectedValueOnce(new Error("capture denied"));
		await expect(
			manager.execute("s1", "a1", {
				action: "type",
				frameId: screenshot.details.frameId,
				text: "日本語 'quote'\nsecond line",
			}),
		).rejects.toThrow("capture denied");
		await expect(
			manager.execute("s1", "a1", { action: "press", frameId: screenshot.details.frameId, key: "enter" }),
		).rejects.toThrow("latest screenshot");
		await expect(manager.execute("s1", "a1", { action: "screenshot" })).resolves.toBeDefined();
	});

	it("does not retain ownership when its first capture fails", async () => {
		vi.mocked(backend.frame).mockRejectedValueOnce(new Error("permission denied"));
		await expect(manager.execute("s1", "a1", { action: "screenshot" })).rejects.toThrow("permission denied");
		await expect(manager.execute("s2", "a2", { action: "screenshot" })).resolves.toBeDefined();
	});
	it("keeps active-run ownership but releases it after an ordinary response completes", async () => {
		await manager.execute("s1", "a1", { action: "screenshot" });
		await manager.releaseIdle((sessionId) => sessionId === "s1");
		await expect(manager.execute("s2", "a2", { action: "screenshot" })).rejects.toThrow("another agent");
		await manager.releaseIdle(() => false);
		await expect(manager.execute("s2", "a2", { action: "screenshot" })).resolves.toBeDefined();
	});

	it("waits for cancellation cleanup, discards queued inputs, and then releases the desktop", async () => {
		const started = Promise.withResolvers<void>();
		const cleanup = Promise.withResolvers<void>();
		const screenshot = await manager.execute("s1", "a1", { action: "screenshot" });
		vi.mocked(backend.frame).mockImplementationOnce(async (_request: DesktopRequest, signal?: AbortSignal) => {
			started.resolve();
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			await cleanup.promise;
			throw new Error("cancelled after releasing keys");
		});
		const active = manager.execute("s1", "a1", { action: "type", frameId: screenshot.details.frameId, text: "work" });
		const activeFailure = expect(active).rejects.toThrow("cancelled after releasing keys");
		await started.promise;
		const queued = manager.execute("s1", "a1", { action: "screenshot" });
		const queuedFailure = expect(queued).rejects.toThrow("stopped session");
		const stopping = manager.closeSession("s1");
		const next = manager.execute("s2", "a2", { action: "screenshot" });
		expect(backend.frame).toHaveBeenCalledTimes(2);
		cleanup.resolve();
		await Promise.all([activeFailure, queuedFailure, stopping, next]);
		expect(backend.frame).toHaveBeenCalledTimes(3);
	});

	it("rejects pre-aborted operations without capturing and rejects calls after shutdown", async () => {
		await expect(manager.execute("s1", "a1", { action: "screenshot" }, AbortSignal.abort())).rejects.toBeDefined();
		expect(backend.frame).not.toHaveBeenCalled();
		await manager.close();
		await expect(manager.execute("s1", "a1", { action: "screenshot" })).rejects.toThrow("stopped session");
	});
});
