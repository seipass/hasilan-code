import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryModelsStore,
} from "@hasilan-code/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@hasilan-code/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { afterEach, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import {
	projectAttachmentContent,
	readAttachmentImages,
	savePromptAttachments,
} from "../src/server/prompt-attachments.ts";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { TeamManager } from "../src/server/team-manager.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";
import {
	ATTACHMENT_LIMITS,
	type AttachmentUpload,
	attachmentPrompt,
	isPromptAttachments,
	parseAttachmentPrompt,
} from "../src/shared/attachments.ts";
import { promptSchema } from "../src/shared/contracts.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const image: AttachmentUpload = { name: "画面.png", mimeType: "image/png", data: png };
const document: AttachmentUpload = {
	name: "仕様 メモ.txt",
	mimeType: "text/plain",
	data: Buffer.from("requirements\n", "utf8").toString("base64"),
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function storage() {
	const root = await mkdtemp(join(tmpdir(), "hasilan-attachments-"));
	const files = new WorkspaceFiles();
	const workspace = await files.register(root);
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	return { root, files, workspace };
}

it("stores originals under the workspace and keeps names and content distinct across retries", async () => {
	const f = await storage();
	const attachments = await savePromptAttachments(f.files, f.workspace.id, [image, document]);
	expect(isPromptAttachments(attachments)).toBe(true);
	expect(await readFile(join(f.root, attachments[0]!.path))).toEqual(Buffer.from(png, "base64"));
	expect(await readFile(join(f.root, attachments[1]!.path), "utf8")).toBe("requirements\n");
	expect(await savePromptAttachments(f.files, f.workspace.id, [image, document])).toEqual(attachments);
	const [other] = await savePromptAttachments(f.files, f.workspace.id, [
		{ ...document, data: Buffer.from("different").toString("base64") },
	]);
	expect(other?.path).not.toBe(attachments[1]?.path);
	expect(other?.name).toBe(document.name);
	const [safe] = await savePromptAttachments(f.files, f.workspace.id, [{ ...document, name: "../../CON?.txt" }]);
	expect(safe?.path).toMatch(/^\.hasilan-code\/attachments\/[a-f0-9]{64}-[^/\\]+$/);
	expect((await readAttachmentImages(f.files, f.workspace.id, attachments))[0]).toEqual({
		type: "image",
		mimeType: "image/png",
		data: png,
	});
});

it("rejects malformed uploads and size/count limits before storing the batch", async () => {
	const f = await storage();
	await expect(
		savePromptAttachments(f.files, f.workspace.id, [{ ...document, data: "!!not-base64!!" }]),
	).rejects.toThrow("不正");
	await expect(savePromptAttachments(f.files, f.workspace.id, [{ ...image, data: document.data }])).rejects.toThrow(
		"画像データ",
	);
	await expect(
		savePromptAttachments(
			f.files,
			f.workspace.id,
			Array.from({ length: 11 }, () => document),
		),
	).rejects.toThrow("10ファイル");
	const oversized = { ...document, data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1).toString("base64") };
	await expect(savePromptAttachments(f.files, f.workspace.id, [oversized])).rejects.toThrow("10 MB");
	const tenMb = { ...document, data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes).toString("base64") };
	await expect(savePromptAttachments(f.files, f.workspace.id, [tenMb, tenMb, document])).rejects.toThrow("20 MB");
	expect(await f.files.list(f.workspace.id)).toEqual([]);
	expect(Check(promptSchema, { text: "", mode: "prompt", attachments: [image] })).toBe(true);
});

it("preserves text while projecting small image references for history and detects changed originals", async () => {
	const f = await storage();
	const attachments = await savePromptAttachments(f.files, f.workspace.id, [image, document]);
	const text = attachmentPrompt("この画像と仕様を使って", attachments);
	expect(parseAttachmentPrompt(text)).toEqual({ text: "この画像と仕様を使って", attachments });
	const projected = projectAttachmentContent(
		[
			{ type: "text", text },
			{ type: "image", mimeType: "image/png", data: png },
		],
		f.workspace.id,
	);
	expect(projected).toEqual([
		{ type: "text", text: "この画像と仕様を使って" },
		...attachments.map((attachment) => ({
			type: "fileAttachment",
			...attachment,
			url: expect.stringContaining(`/api/workspaces/${f.workspace.id}/file-content?`),
		})),
	]);
	expect(JSON.stringify(projected)).not.toContain(png);
	const literal = "literal\n\n<hasilan-code-attachments>\nnot-json\n</hasilan-code-attachments>";
	expect(parseAttachmentPrompt(literal)).toEqual({ text: literal, attachments: [] });
	await writeFile(join(f.root, attachments[0]!.path), "changed");
	await expect(readAttachmentImages(f.files, f.workspace.id, attachments)).rejects.toThrow("変更");
});

async function fixture(responses: FauxResponseStep[], vision = true) {
	const root = await mkdtemp(join(tmpdir(), "hasilan-attachment-sdk-"));
	const workspacePath = join(root, "workspace");
	await mkdir(workspacePath);
	const files = new WorkspaceFiles();
	const faux = fauxProvider({
		provider: "attachment-faux",
		models: [{ id: "attachment-model", input: vision ? ["text", "image"] : ["text"] }],
	});
	faux.setResponses(responses);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(faux.provider);
	const gate = Promise.withResolvers<void>();
	let held = false;
	const parameters = Type.Object({});
	const registry = new SessionRegistry({
		agentDir: root,
		modelRuntime: runtime,
		workspaceFiles: files,
		readAttachments: (workspaceId, attachments) => readAttachmentImages(files, workspaceId, attachments),
		customTools: () => [
			{
				name: "hold",
				label: "Hold",
				description: "Wait for a deterministic test gate",
				parameters,
				execute: async (_id, _args, signal) => {
					held = true;
					const abort = () => gate.resolve();
					signal?.addEventListener("abort", abort, { once: true });
					try {
						if (!signal?.aborted) await gate.promise;
					} finally {
						signal?.removeEventListener("abort", abort);
					}
					return { content: [{ type: "text", text: "released" }], details: { released: true } };
				},
			} satisfies ToolDefinition<typeof parameters>,
		],
	});
	const teams = new TeamManager(registry);
	await registry.initialize();
	await teams.initialize();
	const workspace = await registry.addWorkspace(workspacePath);
	const model = faux.getModel();
	const session = await registry.create({
		workspaceId: workspace.id,
		model: { provider: model.provider, id: model.id },
		tools: ["hold"],
	});
	await teams.ensureRoot(session.sessionId);
	cleanups.push(async () => {
		gate.resolve();
		await teams.close();
		await registry.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, files, workspace, session, registry, teams, faux, gate, held: () => held };
}

it("delivers attachment-only images to the actual SDK model request and restores readable history", async () => {
	let request = "";
	const f = await fixture([
		(context) => {
			request = JSON.stringify(context.messages);
			return fauxAssistantMessage("checked");
		},
	]);
	const attachments = await savePromptAttachments(f.files, f.workspace.id, [image, document]);
	await f.teams.prompt(f.session.sessionId, { text: "", mode: "prompt", attachments });
	await expect.poll(() => f.registry.get(f.session.sessionId).currentRun).toBeUndefined();
	expect(f.registry.get(f.session.sessionId).latestRun?.status).toBe("completed");
	expect(request).toContain('"type":"image"');
	expect(request).toContain(attachments[1]!.path);
	expect(f.registry.get(f.session.sessionId).messages.find((message) => message.role === "user")?.content).toEqual(
		expect.arrayContaining([expect.objectContaining({ type: "fileAttachment", name: image.name })]),
	);
	const restored = new SessionRegistry({ agentDir: f.root, workspaceFiles: new WorkspaceFiles() });
	await restored.initialize();
	expect(restored.get(f.session.sessionId).messages.find((message) => message.role === "user")?.content).toEqual(
		f.registry.get(f.session.sessionId).messages.find((message) => message.role === "user")?.content,
	);
	await restored.close();
});

it.each(["steer", "followUp"] as const)(
	"keeps images while editing a queued %s input and removes it after delivery",
	async (mode) => {
		const requests: string[] = [];
		const capture: FauxResponseStep = (context) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("done");
		};
		const f = await fixture([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			capture,
			capture,
		]);
		await f.teams.prompt(f.session.sessionId, { text: "start", mode: "prompt" });
		await expect.poll(f.held).toBe(true);
		const attachments = await savePromptAttachments(f.files, f.workspace.id, [image]);
		const admitted = await f.teams.prompt(f.session.sessionId, { text: "before", mode, attachments });
		await f.teams.updatePendingInput(f.session.sessionId, admitted.inputId!, { type: "edit", text: "after" });
		if (mode === "followUp")
			await f.teams.updatePendingInput(f.session.sessionId, admitted.inputId!, { type: "sendNow" });
		expect(f.registry.get(f.session.sessionId).pendingInput[0]?.attachments).toEqual(attachments);
		f.gate.resolve();
		await expect.poll(() => f.registry.get(f.session.sessionId).currentRun).toBeUndefined();
		expect(f.registry.get(f.session.sessionId).pendingInput).toEqual([]);
		expect(requests.join("\n")).toContain('"type":"image"');
		expect(requests.join("\n")).toContain("after");
		expect(requests.join("\n")).not.toContain("before");
		expect(f.registry.get(f.session.sessionId).messages.filter((message) => message.role === "user")).toHaveLength(2);
	},
);

it("fails explicitly for a text-only model without silently omitting the image", async () => {
	const f = await fixture([fauxAssistantMessage("must not be used")], false);
	const attachments = await savePromptAttachments(f.files, f.workspace.id, [image]);
	await f.teams.prompt(f.session.sessionId, { text: "look", mode: "prompt", attachments });
	await expect.poll(() => f.registry.get(f.session.sessionId).latestRun?.status).toBe("failed");
	expect(f.registry.get(f.session.sessionId).latestRun?.error).toContain("画像入力に対応していません");
	expect(f.faux.state.callCount).toBe(0);
});
