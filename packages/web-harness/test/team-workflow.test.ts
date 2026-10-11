import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../src/server/team-workflow.ts";

describe("workflow preflight", () => {
	it("rejects cycles and missing prerequisites", () => {
		expect(() =>
			validateWorkflow([
				{ name: "first", task: "First", dependsOn: ["second"] },
				{ name: "second", task: "Second", dependsOn: ["first"] },
			]),
		).toThrow("cycle");
		expect(() => validateWorkflow([{ name: "review", task: "Review", dependsOn: ["missing"] }])).toThrow("Unknown");
	});
	it("rejects ambiguous task names and duplicate dependencies", () => {
		expect(() =>
			validateWorkflow([
				{ name: "same", task: "A" },
				{ name: "same", task: "B" },
			]),
		).toThrow("Duplicate workflow task");
		expect(() =>
			validateWorkflow([
				{ name: "source", task: "A" },
				{ name: "review", task: "B", dependsOn: ["source", "source"] },
			]),
		).toThrow("Duplicate workflow dependency");
	});
});
