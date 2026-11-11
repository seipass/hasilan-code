import type { ExtensionToolContext } from "@hasilan-code/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ShellProcessManager } from "../src/server/tools/shell-process.ts";

describe("shell_process", () => {
	const manager = new ShellProcessManager();
	afterEach(() => manager.close());

	it("yields, accepts stdin, returns output and isolates conversations", async () => {
		const tool = manager.createTool("one", process.cwd());
		const other = manager.createTool("two", process.cwd());
		const call = async (input: Parameters<typeof tool.execute>[1]) => {
			const result = await tool.execute("id", input, undefined, undefined, {} as ExtensionToolContext);
			const content = result.content[0];
			if (content.type !== "text") throw new Error("Expected text result");
			return JSON.parse(content.text) as { processId: string; status: string; output: string; exitCode?: number };
		};
		const started = await call({
			action: "start",
			command: `node -e 'process.stdout.write("ready"); process.stdin.once("data", x => { console.log("got:" + x.toString().trim()); process.exit(0); });'`,
			yieldMs: 200,
		});
		expect(started.status).toBe("running");
		await expect(
			other.execute(
				"id",
				{ action: "poll", processId: started.processId },
				undefined,
				undefined,
				{} as ExtensionToolContext,
			),
		).rejects.toThrow("not found");
		const done = await call({ action: "input", processId: started.processId, text: "hello\n", yieldMs: 5000 });
		expect(done.status).toBe("finished");
		expect(done.exitCode).toBe(0);
		expect(started.output + done.output).toContain("got:hello");
		await expect(call({ action: "poll", processId: started.processId })).rejects.toThrow("not found");
	});

	it("forgets a running process when its session closes", async () => {
		const tool = manager.createTool("closing", process.cwd());
		const context = {} as ExtensionToolContext;
		const result = await tool.execute(
			"id",
			{ action: "start", command: "node -e 'setInterval(() => {}, 1000)'", yieldMs: 100 },
			undefined,
			undefined,
			context,
		);
		const content = result.content[0];
		if (content.type !== "text") throw new Error("Expected text result");
		const { processId } = JSON.parse(content.text) as { processId: string };
		manager.closeSession("closing");
		await expect(tool.execute("id", { action: "poll", processId }, undefined, undefined, context)).rejects.toThrow(
			"not found",
		);
	});
});
