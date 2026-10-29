import { type ClassifierResult, InMemoryCredentialStore } from "@hasilan-code/pi-ai";
import { type ExtensionToolContext, ModelRuntime } from "@hasilan-code/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/server/artifacts.ts";
import * as desktopAccessibility from "../src/server/tools/computer/accessibility.ts";
import { AccessibleScopeError } from "../src/server/tools/computer/accessibility.ts";
import type { DesktopBackend } from "../src/server/tools/computer/backend.ts";
import { ComputerManager } from "../src/server/tools/computer/index.ts";
import { JevComputer } from "../src/server/tools/computer/jev.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1EAAAAASUVORK5CYII=",
	"base64",
);
const selection = { provider: "commandcode", id: "typesafe/jev" };
const model = {
	type: "classifier",
	...selection,
	api: "typesafe-system-one",
	input: ["text"],
	baseUrl: "https://example.invalid",
	contextWindow: 32000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const chatModel = {
	type: "chat",
	provider: "text-provider",
	id: "text-model",
	api: "openai-completions",
	input: ["text"],
	reasoning: false,
	contextWindow: 10000,
	maxTokens: 1000,
};
const task: Parameters<JevComputer["execute"]>[2] = {
	objective: "Open settings",
	completion: "Settings is open",
	options: [{ action: "click", target: "Settings button" }],
};

function decision(choice: string, complete = 0.01, visible = 0.99): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "commandcode",
		model: "typesafe/jev",
		stopReason: "stop",
		timestamp: 1,
		answers: {
			complete: { type: "bool", probability: complete },
			blocked: { type: "bool", probability: 0.01 },
			next: { type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 0.96, handoff: 0.04 } },
			visible_1: { type: "bool", probability: visible },
			box_1: { type: "box", box: { left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 }, confidence: 0.95 },
			target_1: {
				type: "choice",
				choice: "target_1",
				confidence: 0.95,
				probabilities: { target_1: 0.96, none: 0.04 },
			},
		},
	};
}

describe("Jev Computer Use", () => {
	let backend: DesktopBackend;
	let artifacts: ArtifactStore;
	let computer: ComputerManager;
	let jev: JevComputer;
	let runtime: {
		getModelOfType: ReturnType<typeof vi.fn>;
		getModel: ReturnType<typeof vi.fn>;
		hasConfiguredAuth: ReturnType<typeof vi.fn>;
		classify: ReturnType<typeof vi.fn>;
		completeSimple: ReturnType<typeof vi.fn>;
	};
	beforeEach(() => {
		backend = {
			status: vi.fn(async () => ({ ready: true, platform: "test", setup: [] })),
			screens: vi.fn(async () => [{ index: 1, left: 0, top: 0, width: 100, height: 50 }]),
			frame: vi.fn(async () => ({
				bounds: { left: 0, top: 0, width: 100, height: 50 },
				width: 200,
				height: 100,
				png,
			})),
			close: vi.fn(async () => undefined),
		};
		artifacts = new ArtifactStore();
		computer = new ComputerManager(backend, artifacts);
		vi.spyOn(computer, "targets").mockResolvedValue([
			{ name: "Settings button", role: "ControlType.Button", x: 40, y: 20, focused: true },
		]);
		runtime = {
			getModelOfType: vi.fn(() => model),
			getModel: vi.fn(() => chatModel),
			hasConfiguredAuth: vi.fn(() => true),
			classify: vi.fn(),
			completeSimple: vi.fn(),
		};
		jev = new JevComputer(computer, runtime as unknown as ModelRuntime, () => ({
			jev: selection,
			textModel: { provider: "text-provider", id: "text-model" },
		}));
	});
	afterEach(async () => {
		await computer.close();
		artifacts.close();
		vi.unstubAllGlobals();
	});

	it("chooses and locates an action, observes the result, then releases ownership", async () => {
		runtime.classify.mockResolvedValueOnce(decision("option_1")).mockResolvedValueOnce(decision("handoff", 0.99));
		const updates = vi.fn();
		const result = await jev.execute("s1", "a1", task, undefined, updates);
		expect(result.details).toMatchObject({ mode: "jev", outcome: "completed", released: true });
		expect(result.details.frames).toHaveLength(2);
		expect(backend.frame).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: "click", x: 20, y: 10 }),
			expect.any(AbortSignal),
		);
		expect(updates).toHaveBeenCalledTimes(2);
		expect(runtime.classify.mock.calls[0][0].input).toContain("image");
		expect(runtime.classify.mock.calls[0][1].questions.target_1.type).toBe("choice");
		expect(runtime.classify.mock.calls[0][1].questions.box_1).toBeUndefined();
		expect(runtime.completeSimple).not.toHaveBeenCalled();
		await expect(computer.execute("s2", "a2", { action: "screenshot" })).resolves.toBeDefined();
	});

	it("never clicks an absent target even if Jev returns a box", async () => {
		runtime.classify.mockResolvedValueOnce(decision("option_1", 0.01, 0.05));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details.outcome).toBe("handoff");
		expect(backend.frame).toHaveBeenCalledTimes(1);
		expect(runtime.completeSimple).not.toHaveBeenCalled();
		await expect(computer.execute("s2", "a2", { action: "screenshot" })).resolves.toBeDefined();
	});

	it("reports when no accessible control is available instead of hiding the reason", async () => {
		vi.mocked(computer.targets).mockResolvedValue([]);
		runtime.classify.mockResolvedValueOnce(decision("option_1"));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details).toMatchObject({
			outcome: "handoff",
			diagnostic: { code: "no_accessible_targets", monitor: 1 },
		});
		expect(backend.frame).toHaveBeenCalledTimes(1);
	});

	it("recognizes an already completed task even without accessible controls", async () => {
		vi.mocked(computer.targets).mockResolvedValue([]);
		runtime.classify.mockResolvedValueOnce(decision("handoff", 0.99));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details.outcome).toBe("completed");
		expect(backend.frame).toHaveBeenCalledTimes(1);
	});

	it.each(["foreground_off_monitor", "foreground_changed", "no_foreground"] as const)(
		"reports %s and does not send input",
		async (code) => {
			vi.mocked(computer.targets).mockRejectedValueOnce(new AccessibleScopeError(code));
			const result = await jev.execute("s1", "a1", task);
			expect(result.details).toMatchObject({ outcome: "handoff", released: true, diagnostic: { code, monitor: 1 } });
			expect(backend.frame).toHaveBeenCalledTimes(1);
			expect(runtime.classify).not.toHaveBeenCalled();
		},
	);

	it("reports whether model visibility or target selection was uncertain", async () => {
		runtime.classify.mockResolvedValueOnce(decision("option_1", 0.01, 0.05));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details.diagnostic).toMatchObject({
			code: "target_visibility_uncertain",
			candidates: 1,
			probability: 0.05,
		});
	});

	it("provides screen positions to distinguish otherwise identical controls", async () => {
		vi.mocked(computer.targets).mockResolvedValue([
			{ name: "Select", role: "ControlType.Button", x: 20, y: 10, focused: false },
			{ name: "Select", role: "ControlType.Button", x: 180, y: 90, focused: false },
		]);
		runtime.classify.mockResolvedValueOnce(decision("handoff", 0.99));
		await jev.execute("s1", "a1", task);
		const request = runtime.classify.mock.calls[0][1];
		expect(request.questions.target_1.criteria.target_1).toContain("10%, 10%");
		expect(request.questions.target_1.criteria.target_2).toContain("90%, 90%");
		expect(request.state.accessibleControls).toMatchObject([
			{ xPercent: 10, yPercent: 10 },
			{ xPercent: 90, yPercent: 90 },
		]);
	});

	it("records the target choice and confidence when selection is uncertain", async () => {
		const answer = decision("option_1");
		answer.answers.target_1 = {
			type: "choice",
			choice: "none",
			confidence: 0.91,
			probabilities: { target_1: 0.1, none: 0.9 },
		};
		runtime.classify.mockResolvedValueOnce(answer);
		const result = await jev.execute("s1", "a1", task);
		expect(result.details.diagnostic).toMatchObject({
			code: "target_selection_uncertain",
			targetChoice: "none",
			targetConfidence: 0.91,
			targetProbability: 0.9,
		});
		expect(backend.frame).toHaveBeenCalledTimes(1);
	});

	it("keeps the monitor selected by ordinary computer through successive Jev releases", async () => {
		await computer.execute("s1", "a1", { action: "screenshot", monitor: 3 });
		await computer.execute("s1", "a1", { action: "release" });
		runtime.classify.mockResolvedValue(decision("handoff", 0.99));
		const first = await jev.execute("s1", "a1", task);
		const second = await jev.execute("s1", "a1", task);
		expect(first.details.frames[0].monitor).toBe(3);
		expect(second.details.frames[0].monitor).toBe(3);
	});

	it("can click a visible control on monitor 3 while another monitor has keyboard focus", async () => {
		vi.mocked(computer.targets).mockRestore();
		const inspect = vi
			.spyOn(desktopAccessibility, "accessibleTargets")
			.mockImplementation(async (_bounds, _signal, scope: "monitor" | "foreground" = "foreground") => {
				if (scope !== "monitor") throw new AccessibleScopeError("foreground_off_monitor");
				return [
					{ name: "UNDERTALE", role: "ControlType.ListItem", x: 40, y: 20, focused: false, windowId: "steam" },
				];
			});
		try {
			runtime.classify.mockResolvedValueOnce(decision("option_1")).mockResolvedValueOnce(decision("handoff", 0.99));
			const result = await jev.execute("s1", "a1", { ...task, monitor: 3 });
			expect(result.details.outcome).toBe("completed");
			expect(backend.frame).toHaveBeenLastCalledWith(
				expect.objectContaining({ action: "click", monitor: 3, x: 40, y: 20 }),
				expect.any(AbortSignal),
			);
		} finally {
			inspect.mockRestore();
		}
	});

	it("returns a fresh frame when the parent reuses its pre-Jev frame after handoff", async () => {
		const tool = computer.createTool("s1", "a1");
		const context = {} as ExtensionToolContext;
		const before = await computer.execute("s1", "a1", { action: "screenshot", monitor: 3 });
		vi.mocked(computer.targets).mockRejectedValueOnce(new AccessibleScopeError("foreground_off_monitor"));
		await jev.execute("s1", "a1", task);
		const recovery = await tool.execute(
			"recovery",
			{
				action: "click",
				frameId: before.details.frameId!,
				x: 40,
				y: 20,
			},
			undefined,
			undefined,
			context,
		);
		expect(recovery.details).toMatchObject({ action: "screenshot", monitor: 3, skippedAction: "click" });
		expect(recovery.details.frameId).not.toBe(before.details.frameId);
		expect(vi.mocked(backend.frame).mock.calls.every(([request]) => request.action === "screenshot")).toBe(true);
		await tool.execute(
			"retry",
			{ action: "click", frameId: recovery.details.frameId!, x: 40, y: 20 },
			undefined,
			undefined,
			context,
		);
		expect(backend.frame).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: "click", monitor: 3, x: 20, y: 10 }),
			expect.any(AbortSignal),
		);
	});

	it("does not click an identically named control in a different window", async () => {
		vi.mocked(computer.targets)
			.mockResolvedValueOnce([
				{ name: "Settings button", role: "ControlType.Button", x: 40, y: 20, focused: false, windowId: "steam" },
			])
			.mockResolvedValueOnce([
				{ name: "Settings button", role: "ControlType.Button", x: 40, y: 20, focused: false, windowId: "other" },
			]);
		runtime.classify.mockResolvedValueOnce(decision("option_1"));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details.outcome).toBe("handoff");
		expect(backend.frame).toHaveBeenCalledTimes(1);
	});

	it("hands off if the selected control changes before the click", async () => {
		vi.mocked(computer.targets)
			.mockResolvedValueOnce([{ name: "Settings button", role: "ControlType.Button", x: 40, y: 20, focused: false }])
			.mockResolvedValueOnce([]);
		runtime.classify.mockResolvedValueOnce(decision("option_1"));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details.outcome).toBe("handoff");
		expect(JSON.stringify(result.content)).toContain("target changed");
		expect(backend.frame).toHaveBeenCalledTimes(1);
	});

	it("types explicit text without the text model, after verifying focus", async () => {
		const typing: typeof task = {
			objective: "Search",
			completion: "Search results are visible",
			options: [{ action: "type", target: "Search field", text: { kind: "literal", text: "example" } }],
		};
		runtime.classify
			.mockResolvedValueOnce(decision("option_1"))
			.mockResolvedValueOnce({ ...decision("handoff"), answers: { focused: { type: "bool", probability: 0.99 } } })
			.mockResolvedValueOnce(decision("handoff", 0.99));
		const result = await jev.execute("s1", "a1", typing);
		expect(result.details.outcome).toBe("completed");
		expect(backend.frame).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: "type", text: "example" }),
			expect.any(AbortSignal),
		);
		expect(runtime.completeSimple).not.toHaveBeenCalled();
		expect(JSON.stringify(result.details)).not.toContain("example");
	});

	it("uses the selected text model only for generated text", async () => {
		const typing: typeof task = {
			objective: "Draft a search",
			completion: "The field contains the search",
			options: [
				{
					action: "type",
					target: "Search field",
					text: { kind: "generate", instructions: "Write a short search for weather" },
				},
			],
		};
		runtime.classify
			.mockResolvedValueOnce(decision("option_1"))
			.mockResolvedValueOnce({ ...decision("handoff"), answers: { focused: { type: "bool", probability: 0.99 } } })
			.mockResolvedValueOnce(decision("handoff", 0.99));
		runtime.completeSimple.mockResolvedValueOnce({
			stopReason: "stop",
			content: [{ type: "text", text: "today weather" }],
		});
		const result = await jev.execute("s1", "a1", typing);
		expect(result.details.outcome).toBe("completed");
		expect(runtime.getModel).toHaveBeenCalledWith("text-provider", "text-model");
		expect(runtime.completeSimple).toHaveBeenCalledTimes(1);
		expect(runtime.completeSimple.mock.calls[0][2]).toMatchObject({ reasoning: "low" });
		expect(backend.frame).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: "type", text: "today weather" }),
			expect.any(AbortSignal),
		);
	});

	it("hands off without typing when focus is uncertain", async () => {
		const typing: typeof task = {
			objective: "Search",
			completion: "Results visible",
			options: [{ action: "type", target: "Search", text: { kind: "literal", text: "example" } }],
		};
		runtime.classify
			.mockResolvedValueOnce(decision("option_1"))
			.mockResolvedValueOnce({ ...decision("handoff"), answers: { focused: { type: "bool", probability: 0.3 } } });
		const result = await jev.execute("s1", "a1", typing);
		expect(result.details.outcome).toBe("handoff");
		expect(backend.frame).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(result.content)).toContain("focus is uncertain");
	});

	it("releases the desktop on cancellation during Jev inference", async () => {
		const controller = new AbortController();
		runtime.classify.mockImplementationOnce(async () => {
			controller.abort();
			throw new Error("cancelled");
		});
		await expect(jev.execute("s1", "a1", task, controller.signal)).rejects.toThrow("cancelled");
		await expect(computer.execute("s2", "a2", { action: "screenshot" })).resolves.toBeDefined();
	});

	it("does not return an old screenshot as current when input capture fails", async () => {
		runtime.classify.mockResolvedValueOnce(decision("option_1"));
		// Keep the first capture successful and fail the capture after the click.
		vi.mocked(backend.frame)
			.mockResolvedValueOnce({ bounds: { left: 0, top: 0, width: 100, height: 50 }, width: 200, height: 100, png })
			.mockRejectedValueOnce(new Error("capture failed"));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details).toMatchObject({ outcome: "handoff", stale: true, released: true });
		expect(result.content.some((part) => part.type === "image")).toBe(false);
		expect(JSON.stringify(result.content)).toContain("fresh screenshot");
	});

	it("checks completion after the fifth action without issuing a sixth", async () => {
		const scrolling: typeof task = {
			objective: "Find the end",
			completion: "End is visible",
			options: [{ action: "scroll", direction: "down" }],
		};
		for (let index = 0; index < 5; index++) runtime.classify.mockResolvedValueOnce(decision("option_1"));
		runtime.classify.mockResolvedValueOnce(decision("handoff", 0.99));
		const result = await jev.execute("s1", "a1", scrolling);
		expect(result.details.outcome).toBe("completed");
		expect(backend.frame).toHaveBeenCalledTimes(6);
		expect(runtime.classify).toHaveBeenCalledTimes(6);
	});

	it("uses accessible candidates instead of Box with the configured Command Code provider", async () => {
		const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				requests.push({ body, headers: new Headers(init?.headers) });
				const completed = requests.length > 1;
				return Response.json({
					answers: {
						complete: { type: "noul", noul: completed ? 0.99 : 0.01 },
						blocked: { type: "noul", noul: 0.01 },
						next: {
							type: "choice",
							choice: "option_1",
							confidence: 0.95,
							probabilities: { option_1: 0.96, handoff: 0.04 },
						},
						visible_1: { type: "noul", noul: 0.99 },
						target_1: {
							type: "choice",
							choice: "target_1",
							confidence: 0.95,
							probabilities: { target_1: 0.96, none: 0.04 },
						},
					},
				});
			}),
		);
		const actual = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		await actual.setRuntimeApiKey("commandcode", "test-only-key");
		const integrated = new JevComputer(computer, actual, () => ({ jev: selection }));
		const result = await integrated.execute("s1", "a1", task);
		expect(result.details.outcome).toBe("completed");
		expect(requests).toHaveLength(2);
		expect(requests[0].headers.get("typesafe-danger-zone-images")).toBe("true");
		expect(requests[0].headers.get("authorization")).toBe("Bearer test-only-key");
		expect(requests[0].body).toMatchObject({
			model: "typesafe/jev",
			assets: expect.any(Object),
			questions: { target_1: { type: "choice" } },
		});
		expect((requests[0].body.questions as Record<string, unknown>).box_1).toBeUndefined();
	});

	it("uses a text-only decision model with accessible controls without sending screenshots", async () => {
		runtime.getModelOfType.mockReturnValue({
			...model,
			id: "liquid/d1",
			provider: "vercel-ai-gateway",
			input: ["text"],
		});
		runtime.classify.mockResolvedValueOnce(decision("option_1")).mockResolvedValueOnce(decision("handoff", 0.99));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details.outcome).toBe("completed");
		expect(runtime.classify.mock.calls[0][1].images).toBeUndefined();
		expect(runtime.classify.mock.calls[0][1].state.accessibleControls).toHaveLength(1);
	});

	it("uses Liquid d1's image format and accessible controls without Box questions", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				requests.push({
					url: String(url),
					body: JSON.parse(String(init?.body)),
					headers: new Headers(init?.headers),
				});
				return Response.json({
					answers: {
						complete: { type: "noul", noul: requests.length > 1 ? 0.99 : 0.01 },
						blocked: { type: "noul", noul: 0.01 },
						next: {
							type: "choice",
							choice: "option_1",
							confidence: 0.95,
							probabilities: { option_1: 0.96, handoff: 0.04 },
						},
						visible_1: { type: "noul", noul: 0.99 },
						target_1: {
							type: "choice",
							choice: "target_1",
							confidence: 0.95,
							probabilities: { target_1: 0.96, none: 0.04 },
						},
					},
				});
			}),
		);
		const actual = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		await actual.setRuntimeApiKey("liquid", "test-only-key");
		const integrated = new JevComputer(computer, actual, () => ({ jev: { provider: "liquid", id: "d1" } }));
		expect((await integrated.execute("s1", "a1", task)).details.outcome).toBe("completed");
		expect(requests[0].url).toBe("https://api.liquid.ai/decisions/v1/systemone");
		expect(requests[0].body).toMatchObject({
			model: "d1",
			images: [expect.stringContaining("data:image/png;base64,")],
			questions: { target_1: { type: "choice" } },
		});
		expect((requests[0].body.questions as Record<string, unknown>).box_1).toBeUndefined();
		expect(requests[0].headers.has("typesafe-danger-zone-images")).toBe(false);
	});

	it("does not click when accessible controls are unavailable", async () => {
		vi.mocked(computer.targets).mockResolvedValue([]);
		runtime.classify.mockResolvedValueOnce(decision("option_1"));
		const result = await jev.execute("s1", "a1", task);
		expect(result.details.outcome).toBe("handoff");
		expect(backend.frame).toHaveBeenCalledTimes(1);
	});
});
