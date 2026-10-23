import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import { fauxAssistantMessage, fauxProvider, type Message } from "@hasilan-code/pi-ai";
import { transformMessages } from "@hasilan-code/pi-ai/api/transform-messages";
import { SessionManager } from "@hasilan-code/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { createHttpHost } from "../src/server/http-host.ts";
import { record } from "../src/server/session-import/common.ts";
import { parseClaude, parseCodex, parseOhMyPi } from "../src/server/session-import/jsonl-formats.ts";
import { parseGrok, parseOpenCode } from "../src/server/session-import/other-formats.ts";
import { handleSessionImport } from "../src/server/session-import/routes.ts";
import { readSessionDatabase, SessionImportService } from "../src/server/session-import/service.ts";
import { SessionRegistry } from "../src/server/session-registry.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";

const roots: string[] = [];
const executeFile = promisify(execFile);
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("replays parallel Codex calls as one assistant turn without synthetic or duplicate tool results", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const rows = [
		{ type: "session_meta", payload: { id: "parallel", cwd: root } },
		{ type: "response_item", payload: { type: "message", role: "user", content: "read both" } },
		{
			type: "response_item",
			payload: { type: "function_call", name: "read", call_id: "one", arguments: '{"path":"one"}' },
		},
		{
			type: "response_item",
			payload: { type: "function_call", name: "read", call_id: "two", arguments: '{"path":"two"}' },
		},
		{ type: "response_item", payload: { type: "function_call_output", call_id: "one", output: "first result" } },
		{ type: "response_item", payload: { type: "function_call_output", call_id: "two", output: "second result" } },
	];
	const registry = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(workspace.id, parseCodex(rows, "parallel", []), "r");
	const messages = SessionManager.open(imported.path!)
		.buildSessionContext()
		.messages.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
	const transformed = transformMessages(messages, fauxProvider().getModel());
	expect(transformed.filter((message) => message.role === "toolResult")).toHaveLength(2);
	expect(JSON.stringify(transformed)).not.toContain("No result provided");
	expect(JSON.stringify(transformed)).toContain("first result");
	expect(JSON.stringify(transformed)).toContain("second result");
	await registry.close();
});

it("keeps identical tool IDs on different source branches and later local turns separate", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const rows = [
		{ type: "user", uuid: "u", parentUuid: null, cwd: root, message: { content: "read" } },
		{
			type: "assistant",
			uuid: "old",
			parentUuid: "u",
			message: { content: [{ type: "tool_use", id: "same", name: "read", input: { path: "old" } }] },
		},
		{
			type: "assistant",
			uuid: "new",
			parentUuid: "u",
			message: { content: [{ type: "tool_use", id: "same", name: "read", input: { path: "new" } }] },
		},
		{ type: "progress", uuid: "progress", parentUuid: "old" },
		{
			type: "user",
			uuid: "new-result",
			parentUuid: "new",
			message: { content: [{ type: "tool_result", tool_use_id: "same", content: "new result" }] },
		},
		{
			type: "user",
			uuid: "old-result",
			parentUuid: "progress",
			message: { content: [{ type: "tool_result", tool_use_id: "same", content: "old result" }] },
		},
		{ type: "assistant", uuid: "done", parentUuid: "new-result", message: { content: "done" } },
	];
	const options = { agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() };
	let registry = new SessionRegistry(options);
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(workspace.id, parseClaude(rows, "branches", []), "r");
	const before = registry.get(imported.sessionId).toolCalls;
	expect(before.map((tool) => record(tool.result).content)).toEqual([
		[{ type: "text", text: "old result" }],
		[{ type: "text", text: "new result" }],
	]);
	await registry.close();
	const manager = SessionManager.open(imported.path!);
	manager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
	manager.appendMessage(
		fauxAssistantMessage([{ type: "toolCall", id: "same", name: "read", arguments: { path: "local" } }], {
			stopReason: "toolUse",
		}),
	);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "same",
		toolName: "read",
		content: [{ type: "text", text: "local result" }],
		isError: true,
		timestamp: Date.now(),
	});
	registry = new SessionRegistry({ ...options, workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const after = registry.get(imported.sessionId).toolCalls;
	expect(after).toHaveLength(3);
	expect(after.slice(0, 2)).toEqual(before);
	expect(after[2]).toMatchObject({ status: "error", result: { content: [{ type: "text", text: "local result" }] } });
	await registry.close();
});

it("keeps pre-compaction and rolled-back history visible without putting it back into execution context", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const rows = [
		{ type: "session_meta", payload: { id: "source", cwd: root } },
		{ type: "response_item", payload: { type: "message", role: "user", content: "original prompt" } },
		{ type: "response_item", payload: { type: "message", role: "assistant", content: "original answer" } },
		{ type: "compacted", payload: { replacement_history: [{ type: "message", role: "user", content: "summary" }] } },
		{ type: "response_item", payload: { type: "message", role: "assistant", content: "continued" } },
		{ type: "response_item", payload: { type: "message", role: "user", content: "abandoned branch" } },
		{ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
	];
	const registry = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(workspace.id, parseCodex(rows, "source", []), "revision");
	const visible = JSON.stringify(registry.get(imported.sessionId).messages);
	expect(visible).toContain("original answer");
	expect(visible).toContain("abandoned branch");
	const context = SessionManager.open(imported.path!).buildSessionContext().messages;
	expect(JSON.stringify(context)).toContain("summary");
	expect(JSON.stringify(context)).not.toContain("original answer");
	expect(JSON.stringify(context)).not.toContain("abandoned branch");
	await registry.close();
	const restored = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await restored.initialize();
	expect(JSON.stringify(restored.get(imported.sessionId).messages)).toContain("original answer");
	expect(await readFile(imported.path!, "utf8")).toContain("thread_rolled_back");
	await restored.close();
});

it("retains Claude tool pairing, thinking signatures, image bytes and branch parents across persistence", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5r8AAAAASUVORK5CYII=";
	const source = parseClaude(
		[
			{
				type: "user",
				uuid: "u",
				parentUuid: null,
				cwd: root,
				message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: image } }] },
			},
			{ type: "assistant", uuid: "old", parentUuid: "u", message: { content: "other branch" } },
			{
				type: "assistant",
				uuid: "a",
				parentUuid: "u",
				message: {
					model: "original-model",
					stop_reason: "tool_use",
					usage: { input_tokens: 12 },
					content: [
						{ type: "thinking", thinking: "inspect", signature: "original-signature" },
						{ type: "tool_use", id: "call-1", name: "read", input: { path: "main.ts" } },
					],
				},
			},
			{
				type: "user",
				uuid: "r",
				parentUuid: "a",
				message: {
					content: [{ type: "tool_result", tool_use_id: "call-1", content: "source code", is_error: true }],
				},
			},
		],
		"claude",
		[],
	);
	const registry = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(workspace.id, source, "revision");
	const snapshot = registry.get(imported.sessionId);
	expect(snapshot.toolCalls).toContainEqual(
		expect.objectContaining({ callId: "call-1", name: "read", input: { path: "main.ts" }, status: "error" }),
	);
	expect(JSON.stringify(snapshot.messages)).toContain('"type":"thinking"');
	expect(JSON.stringify(snapshot.messages)).toContain("other branch");
	const stored = await readFile(imported.path!, "utf8");
	expect(stored).toContain("original-signature");
	expect(stored).toContain("original-model");
	expect(stored).toContain('"parentUuid":"u"');
	const context = SessionManager.open(imported.path!).buildSessionContext().messages;
	expect(context).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "call-1", isError: true }));
	expect(JSON.stringify(context)).toContain(image);
	await registry.close();
});

it("reads more than 64 MiB and 50,000 messages instead of rejecting the session", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	await mkdir(join(root, ".codex/sessions"), { recursive: true });
	const path = join(root, ".codex/sessions/large.jsonl");
	await writeFile(
		path,
		`${JSON.stringify({ type: "session_meta", payload: { id: "large", cwd: root } })}\n${Array.from({ length: 50001 }, (_, index) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: `message ${index}` } })).join("\n")}\n${JSON.stringify({ type: "source-metadata", padding: "x".repeat(64 * 1024 * 1024) })}\n`,
	);
	const service = new SessionImportService({ home: root, env: {} });
	const found = await service.discover({ source: "codex" }, root);
	expect(found.candidates).toHaveLength(1);
	const { data } = await service.read(found.candidates[0].candidateId);
	expect(data.messages).toHaveLength(50001);
}, 30000);

it("reads concatenated compressed frames whose decoded content exceeds 64 MiB", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	await mkdir(join(root, ".codex/sessions"), { recursive: true });
	await writeFile(
		join(root, ".codex/sessions/compressed.jsonl.zst"),
		Buffer.concat([
			zstdCompressSync(
				Buffer.from(`${JSON.stringify({ type: "session_meta", payload: { id: "compressed", cwd: root } })}\n`),
			),
			zstdCompressSync(
				Buffer.from(
					`${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "x".repeat(64 * 1024 * 1024 + 1) } })}\n`,
				),
			),
		]),
	);
	const service = new SessionImportService({ home: root, env: {} });
	const found = await service.discover({ source: "codex" }, root);
	const { data } = await service.read(found.candidates[0].candidateId);
	expect(data.messages[0].text.length).toBe(64 * 1024 * 1024 + 1);
}, 30000);

it.each(["modern-large", "legacy-large"])(
	"reads an entire %s SQLite history beyond the former row and byte caps",
	async (mode) => {
		const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
		roots.push(root);
		const path = join(root, "source.db");
		await executeFile(process.execPath, [
			"--disable-warning=ExperimentalWarning",
			fileURLToPath(new URL("./session-import-sqlite-fixture.ts", import.meta.url)),
			path,
			mode,
			root,
		]);
		const data = record(await readSessionDatabase(path, "opencode", "oc-synthetic"));
		expect(data.messages).toHaveLength(50001);
		expect(JSON.stringify(data).length).toBeGreaterThan(64 * 1024 * 1024);
	},
	30000,
);

it("retains oh my pi's inactive branch, native tool IDs and compaction archive", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const rows = [
		{ type: "session", version: 3, id: "omp", cwd: root },
		{ type: "message", id: "u", parentId: null, message: { role: "user", content: "old prompt" } },
		{
			type: "message",
			id: "old",
			parentId: "u",
			message: { role: "assistant", content: [{ type: "text", text: "other branch" }] },
		},
		{ type: "message", id: "keep", parentId: "u", message: { role: "user", content: "keep" } },
		{ type: "compaction", id: "compact", parentId: "keep", summary: "summary", firstKeptEntryId: "keep" },
		{
			type: "message",
			id: "a",
			parentId: "compact",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "inspect", thinkingSignature: "signature" },
					{ type: "toolCall", id: "c", name: "read", arguments: { path: "one" } },
				],
			},
		},
		{
			type: "message",
			id: "r",
			parentId: "a",
			message: {
				role: "toolResult",
				toolCallId: "c",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "file" }],
			},
		},
	];
	const registry = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(workspace.id, parseOhMyPi(rows, "omp", []), "r");
	expect([...registry.importRecords(imported.sessionId)]).toEqual(rows);
	expect(JSON.stringify(registry.page(imported.sessionId).messages)).toContain("other branch");
	expect(registry.get(imported.sessionId).toolCalls[0]).toMatchObject({
		callId: "c",
		status: "success",
		result: { content: [{ type: "text", text: "file" }] },
	});
	expect(JSON.stringify(SessionManager.open(imported.path!).buildSessionContext().messages)).not.toContain(
		"other branch",
	);
	await registry.close();
});

it("preserves OpenCode's reverted rows, completed tools, model attributes and inline attachments", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const source = {
		info: { id: "oc", location: { directory: root }, revert: { messageID: "reverted" } },
		messages: [
			{
				id: "u",
				type: "user",
				text: "read",
				files: [
					{
						data: Buffer.from("file body").toString("base64"),
						mime: "text/plain",
						name: "notes.txt",
						source: { type: "inline" },
					},
				],
			},
			{
				id: "a",
				type: "assistant",
				model: { id: "model" },
				finish: "tool-calls",
				content: [
					{ type: "reasoning", text: "inspect", native: { signature: "signature" } },
					{
						type: "tool",
						id: "c",
						name: "read",
						state: { status: "completed", input: { path: "notes" }, content: [{ type: "text", text: "result" }] },
					},
				],
			},
			{ id: "reverted", type: "user", text: "reverted request" },
		],
	};
	const registry = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(workspace.id, parseOpenCode(source, "oc", []), "r");
	expect([...registry.importRecords(imported.sessionId)]).toEqual([source.info, ...source.messages]);
	expect(JSON.stringify(registry.get(imported.sessionId).messages)).toContain("reverted request");
	expect(registry.get(imported.sessionId).toolCalls[0]).toMatchObject({
		callId: "c",
		name: "read",
		status: "success",
	});
	expect(JSON.stringify(SessionManager.open(imported.path!).buildSessionContext().messages)).not.toContain(
		"reverted request",
	);
	await registry.close();
});

it("keeps Grok chunks as messages, merges structured tool updates and retains rewound records", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const update = (sessionUpdate: string, values: Record<string, unknown>) => ({
		params: { update: { sessionUpdate, ...values } },
	});
	const rows = [
		update("user_message_chunk", { content: { type: "text", text: "read " }, _meta: { promptIndex: 0 } }),
		update("user_message_chunk", { content: { type: "text", text: "file" }, _meta: { promptIndex: 0 } }),
		update("tool_call", { toolCallId: "c", title: "read", status: "pending", rawInput: { path: "partial" } }),
		update("tool_call_update", {
			toolCallId: "c",
			status: "completed",
			rawInput: { path: "one" },
			rawOutput: "result",
		}),
		update("user_message_chunk", { content: { type: "text", text: "discarded" }, _meta: { promptIndex: 1 } }),
		update("rewind_marker", { target_prompt_index: 1 }),
	];
	const registry = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(
		workspace.id,
		parseGrok(rows, { info: { id: "g", cwd: root } }, [], new Map(), "g", []),
		"r",
	);
	const snapshot = registry.get(imported.sessionId);
	expect(JSON.stringify(snapshot.messages)).toContain("read file");
	expect(JSON.stringify(snapshot.messages)).toContain("discarded");
	expect(snapshot.toolCalls).toHaveLength(1);
	expect(snapshot.toolCalls[0]).toMatchObject({
		callId: "c",
		input: { path: "one" },
		status: "success",
		sourceStatus: "completed",
		result: { content: [{ type: "text", text: "result" }] },
	});
	expect(JSON.stringify(SessionManager.open(imported.path!).buildSessionContext().messages)).not.toContain(
		"discarded",
	);
	await registry.close();
});

it("resolves DeepSeek attachment objects and preserves replaced surface nodes and replay state", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const image = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5r8AAAAASUVORK5CYII=",
		"base64",
	);
	const hash = createHash("sha256").update(image).digest("hex");
	const objects = join(root, ".dsh/attachments/v1/objects", hash.slice(0, 2));
	await mkdir(objects, { recursive: true });
	await writeFile(join(objects, hash), image);
	await mkdir(join(root, ".dsh/sessions/p/s"), { recursive: true });
	const rows = [
		{ type: "session", version: 4, id: "deep", cwd: root },
		{
			type: "user/message",
			seq: 0,
			surfaceOp: "append",
			data: { id: "old", role: "user", content: [{ type: "text", text: "before replacement" }] },
		},
		{
			type: "user/message",
			seq: 1,
			surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 },
			data: {
				id: "u",
				role: "user",
				content: [
					{
						type: "image",
						attachment: {
							attachmentId: `sha256:${hash}`,
							mediaType: "image/png",
							bytes: image.length,
							width: 1,
							height: 1,
							name: "original.png",
						},
					},
				],
			},
		},
		{
			type: "assistant/message",
			seq: 2,
			surfaceOp: "append",
			data: {
				message: {
					id: "a",
					role: "assistant",
					source: { model: "model", replayState: { blocks: [{ signature: "signature" }] } },
					content: [
						{ type: "reasoning", text: "inspect" },
						{ type: "tool-call", id: "c", name: "read", arguments: '{"path":"one"}' },
					],
				},
			},
		},
		{
			type: "tool/result",
			seq: 3,
			surfaceOp: "append",
			data: {
				message: {
					id: "r",
					role: "tool",
					toolCallId: "c",
					isError: true,
					content: [{ type: "text", text: "failure" }],
				},
			},
		},
	];
	await writeFile(
		join(root, ".dsh/sessions/p/s/session.v4.jsonl"),
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	const service = new SessionImportService({ home: root, env: {} });
	const found = await service.discover({ source: "deepseek-harness" }, root);
	const { data, revision } = await service.read(found.candidates[0].candidateId);
	const registry = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(workspace.id, data, revision);
	expect([...registry.importRecords(imported.sessionId)]).toEqual(rows);
	expect(JSON.stringify(registry.get(imported.sessionId).messages)).toContain("before replacement");
	expect(registry.get(imported.sessionId).toolCalls[0]).toMatchObject({ callId: "c", status: "error" });
	expect(await readFile(registry.importAsset(imported.sessionId, hash).path)).toEqual(image);
	const context = JSON.stringify(SessionManager.open(imported.path!).buildSessionContext().messages);
	expect(context).toContain(image.toString("base64"));
	expect(context).not.toContain("before replacement");
	await registry.close();
});

it("serves copied attachment bodies and original records only through authenticated routes after the source file disappears", async () => {
	const root = await mkdtemp(join(tmpdir(), "hasilan-fidelity-"));
	roots.push(root);
	const path = join(root, "notes.txt");
	await writeFile(path, "original file body");
	const source = parseClaude(
		[
			{
				type: "user",
				uuid: "u",
				parentUuid: null,
				cwd: root,
				message: {
					content: [
						{ type: "text", text: "read attachment" },
						{ type: "document", path, filename: "notes.txt", mimeType: "text/plain" },
					],
				},
			},
		],
		"claude",
		[],
	);
	const registry = new SessionRegistry({ agentDir: join(root, "target"), workspaceFiles: new WorkspaceFiles() });
	await registry.initialize();
	const workspace = await registry.addWorkspace(root);
	const imported = await registry.importSession(workspace.id, source, "r");
	await unlink(path);
	const projected = record((registry.get(imported.sessionId).messages[0].content as unknown[])[1]);
	expect(projected.url).toEqual(expect.stringContaining("/assets/"));
	expect(projected.data).toBeUndefined();
	const host = createHttpHost({
		port: 0,
		handleApi: (request, response, url) =>
			handleSessionImport(request, response, url, new SessionImportService(), registry, async () => {}),
	});
	const launch = await host.listen();
	try {
		expect((await fetch(`${launch.origin}${String(projected.url)}`)).status).toBe(401);
		const login = await fetch(launch.launchUrl, { redirect: "manual" });
		const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0] };
		const body = await fetch(`${launch.origin}${String(projected.url)}`, { headers });
		expect(await body.text()).toBe("original file body");
		expect(body.headers.get("content-disposition")).toContain("attachment");
		const origin = registry.get(imported.sessionId).messages[0].importedOrigin!;
		expect(await (await fetch(`${launch.origin}${origin.url}`, { headers })).json()).toEqual(source.records![0].raw);
		const archive = await fetch(`${launch.origin}/api/session-imports/${imported.sessionId}/records`, { headers });
		expect(
			(await archive.text())
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual(source.records!.map((item) => item.raw));
		expect(
			(
				await fetch(`${launch.origin}/api/session-imports/${imported.sessionId}/assets/${"0".repeat(64)}`, {
					headers,
				})
			).status,
		).toBe(404);
	} finally {
		await host.close();
		await registry.close();
	}
});
