import { describe, expect, it } from "vitest";
import { parseComposerCommand } from "../src/client/slash-command.ts";
import { SWARM_OBJECTIVE_MAX_LENGTH } from "../src/shared/swarm.ts";

describe("shared composer slash commands", () => {
	it("preserves ordinary text, embedded slashes and multiline prompts verbatim", () => {
		for (const text of ["  ordinary message\n", "Use /canvas for the design", "https://example.com/a", "some/path"]) {
			expect(parseComposerCommand(text)).toEqual({ kind: "prompt", text });
		}
	});

	it.each(["canvas", "chat"])("recognizes local /%s without a session or model", (kind) => {
		expect(parseComposerCommand(` \n/${kind}\n `)).toEqual({ kind });
		expect(() => parseComposerCommand(`/${kind} unexpected`)).toThrow("引数");
	});

	it("requires a bounded Hyakki objective and preserves its internal formatting", () => {
		expect(parseComposerCommand(" /hyakki  Implement authentication\nthen review it  ")).toEqual({
			kind: "hyakki",
			objective: "Implement authentication\nthen review it",
		});
		expect(() => parseComposerCommand("/hyakki\n ")).toThrow("使い方");
		expect(parseComposerCommand(`/hyakki ${"a".repeat(SWARM_OBJECTIVE_MAX_LENGTH)}`).kind).toBe("hyakki");
		expect(() => parseComposerCommand(`/hyakki ${"a".repeat(SWARM_OBJECTIVE_MAX_LENGTH + 1)}`)).toThrow("文字以内");
	});

	it("creates goals with shorthand and explicit create", () => {
		expect(parseComposerCommand("/goal Deliver the feature")).toEqual({
			kind: "goal",
			action: { op: "create", objective: "Deliver the feature" },
		});
		expect(parseComposerCommand("/goal create Deliver\nwith review")).toEqual({
			kind: "goal",
			action: { op: "create", objective: "Deliver\nwith review" },
		});
		expect(parseComposerCommand("/goal create pause")).toEqual({
			kind: "goal",
			action: { op: "create", objective: "pause" },
		});
	});

	it.each(["pause", "resume", "drop", "status"])("routes goal lifecycle %s without creating another goal", (op) => {
		expect(parseComposerCommand(`/goal ${op}`)).toEqual({
			kind: "goal",
			action: { op: op === "status" ? "get" : op },
		});
	});

	it("uses status for bare /goal", () => {
		expect(parseComposerCommand("/goal")).toEqual({ kind: "goal", action: { op: "get" } });
	});

	it.each(["/goal --budget 5000 objective", "/goal create --budget 1 objective", "/goal resume --budget 9000"])(
		"rejects removed leading budget syntax: %s",
		(text) => {
			expect(() => parseComposerCommand(text)).toThrow("使い方");
		},
	);

	it("keeps command-like text inside an objective as user content", () => {
		expect(parseComposerCommand("/goal Remove --budget from the API")).toEqual({
			kind: "goal",
			action: { op: "create", objective: "Remove --budget from the API" },
		});
	});

	it.each([
		"/goal create",
		"/goal --budget 20",
		"/goal pause extra",
		"/goal drop --budget 2",
		"/goal status extra",
		"/goal resume unexpected",
		"/goal resume --budget 2 extra",
		"/goal --unknown 2 objective",
	])("rejects malformed goal syntax %s", (text) => {
		expect(() => parseComposerCommand(text)).toThrow();
	});

	it("enforces the existing goal objective limit", () => {
		expect(() => parseComposerCommand(`/goal ${"a".repeat(1024 * 1024 + 1)}`)).toThrow("文字以内");
	});

	it.each(["/unknown objective", "/canvas-extra", "/Hyakki objective", "/", "/goal/status"])(
		"reports unknown slash input %s instead of sending it to a model",
		(text) => {
			expect(() => parseComposerCommand(text)).toThrow("不明なコマンド");
		},
	);
});
