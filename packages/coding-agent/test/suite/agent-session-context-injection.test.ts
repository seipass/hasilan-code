import type { AgentTool } from "@hasilan-code/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hasilan-code/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const injection = {
	customType: "context-injection",
	content: "Worker finished: found the answer",
	display: true,
	details: {
		injectionId: "injection-1",
		content: "Worker finished: found the answer",
		source: {
			type: "subagent_completion",
			agentId: "worker-1",
			agentName: "Worker",
			runId: "run-1",
			status: "completed",
			result: "found the answer",
		},
	},
};

describe("AgentSession context injection execution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("persists an idle injection without waking, then resumes without a user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				expect(context.messages.some((message) => getMessageText(message) === injection.content)).toBe(true);
				expect(context.messages.some((message) => message.role === "system")).toBe(true);
				return fauxAssistantMessage("used injected context");
			},
		]);

		await harness.session.sendCustomMessage(injection, { triggerTurn: false });

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				...injection,
			}),
		);

		await harness.session.resumeContext();

		expect(getUserTexts(harness)).toEqual([]);
		expect(getAssistantTexts(harness)).toEqual(["used injected context"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("waits for a complete tool-result batch and fulfills the wake through natural continuation once", async () => {
		const started = deferred();
		const release = deferred();
		const parameters = Type.Object({ index: Type.Number() });
		const tool: AgentTool<typeof parameters> = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters,
			execute: async (_id, args) => {
				if (args.index === 2) {
					started.resolve();
					await release.promise;
				}
				return { content: [{ type: "text", text: `result ${args.index}` }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.session.agent.toolExecution = "sequential";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wait", { index: 1 }, { id: "call-1" }),
					fauxToolCall("wait", { index: 2 }, { id: "call-2" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const roles = context.messages
					.filter((message) => message.role !== "system")
					.map((message) => message.role);
				expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult", "user"]);
				expect(getMessageText(context.messages.at(-1))).toBe(injection.content);
				return fauxAssistantMessage("used both results and injected context");
			},
		]);
		const run = harness.session.prompt("start");
		await started.promise;
		try {
			await harness.session.sendCustomMessage(injection, { triggerTurn: false });
			await harness.session.resumeContext();
			await harness.session.resumeContext();
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
		} finally {
			release.resolve();
		}
		await run;

		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(
			harness.session.messages.filter((message) => message.role !== "system").map((message) => message.role),
		).toEqual(["user", "assistant", "toolResult", "toolResult", "custom", "assistant"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("continues from an injection arriving while the final assistant response is active", async () => {
		const started = deferred();
		const release = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("original response");
			},
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toBe(injection.content);
				return fauxAssistantMessage("context response");
			},
		]);
		const run = harness.session.prompt("start");
		await started.promise;
		try {
			await harness.session.sendCustomMessage(injection, { triggerTurn: false });
			await harness.session.resumeContext();
		} finally {
			release.resolve();
		}
		await run;

		expect(getAssistantTexts(harness)).toEqual(["original response", "context response"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("does not lose a wake at the final pre-settlement boundary", async () => {
		const started = deferred();
		const release = deferred();
		let first = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async () => {
						if (!first) return;
						first = false;
						started.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("continued")]);
		const run = harness.session.prompt("start");
		await started.promise;
		try {
			await harness.session.sendCustomMessage(injection, { triggerTurn: false });
			await harness.session.resumeContext();
		} finally {
			release.resolve();
		}
		await run;

		expect(getAssistantTexts(harness)).toEqual(["first", "continued"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("does not wake for a context-only injection when execution was not requested", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") void harness.session.sendCustomMessage(injection, { triggerTurn: false });
		});

		await harness.session.prompt("start");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.at(-1)?.role).toBe("custom");
	});

	it("does nothing when there is no runnable context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.resumeContext();
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		harness.sessionManager.appendMessage({ role: "system", content: "system only", timestamp: Date.now() });
		await harness.session.resumeContext();
		expect(harness.faux.state.callCount).toBe(0);
		harness.setResponses([fauxAssistantMessage("answered")]);
		await harness.session.prompt("start");
		await harness.session.resumeContext();
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("does not duplicate an active response when a wake has no new runnable context", async () => {
		const started = deferred();
		const release = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("only response");
			},
		]);
		const run = harness.session.prompt("start");
		await started.promise;
		try {
			await harness.session.resumeContext();
		} finally {
			release.resolve();
		}
		await run;

		expect(harness.faux.state.callCount).toBe(1);
		expect(getAssistantTexts(harness)).toEqual(["only response"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("clears a requested continuation on abort while retaining the non-waking context", async () => {
		const started = deferred();
		const release = deferred();
		let first = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async () => {
						if (!first) return;
						first = false;
						started.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("explicitly resumed")]);
		const run = harness.session.prompt("start");
		await started.promise;
		await harness.session.sendCustomMessage(injection, { triggerTurn: false });
		await harness.session.resumeContext();
		const abort = harness.session.abort();
		release.resolve();
		await Promise.all([run, abort]);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.eventsOfType("agent_settled")).toEqual([expect.objectContaining({ aborted: true })]);
		expect(harness.session.messages.at(-1)?.role).toBe("custom");
		await harness.session.resumeContext();
		expect(getAssistantTexts(harness)).toEqual(["first", "explicitly resumed"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
	});
});
