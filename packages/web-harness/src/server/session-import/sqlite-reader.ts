import { DatabaseSync } from "node:sqlite";
import { record } from "./common.ts";

/** Runs in a short-lived child process so database work never blocks the HTTP event loop. */
process.once("message", (raw: unknown) => {
	const request = record(raw);
	let db: DatabaseSync | undefined;
	let reply: { result: unknown } | { error: string };
	try {
		if (typeof request.path !== "string") throw new Error("Database path is required");
		db = new DatabaseSync(request.path, { readOnly: true, allowExtension: false, timeout: 3000 });
		db.exec("PRAGMA query_only = ON; BEGIN");
		const tables = new Set(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map((row) => row.name),
		);
		let result: unknown;
		if (request.source === "codex") {
			if (!tables.has("threads")) throw new Error("Codex の会話一覧が見つかりません。");
			const columns = new Set(
				db
					.prepare("PRAGMA table_info(threads)")
					.all()
					.map((row) => row.name),
			);
			result = db
				.prepare(
					`SELECT id, title, ${columns.has("name") ? "name" : "NULL AS name"} FROM threads ORDER BY updated_at DESC LIMIT 20001`,
				)
				.all();
		} else {
			const sessionTables = ["session_v2", "session"].filter((name) => tables.has(name));
			if (!sessionTables.length) throw new Error("OpenCode のセッションテーブルが見つかりません。");
			if (request.op === "list") {
				const rows = sessionTables.flatMap((table) =>
					db!
						.prepare(
							`SELECT id, directory, title, time_updated FROM ${table} ORDER BY time_updated DESC LIMIT 20001`,
						)
						.all(),
				);
				const unique = new Map<string, Record<string, unknown>>();
				for (const row of rows) if (!unique.has(String(row.id))) unique.set(String(row.id), row);
				result = [...unique.values()]
					.sort((a, b) => Number(b.time_updated) - Number(a.time_updated))
					.slice(0, 20001);
			} else if (request.op === "read" && typeof request.sessionId === "string") {
				let info: Record<string, unknown> | undefined;
				for (const table of sessionTables) {
					info = db
						.prepare(`SELECT id, directory, title, revert FROM ${table} WHERE id = ?`)
						.get(request.sessionId);
					if (info) break;
				}
				if (!info) throw new Error("OpenCode のセッションが見つかりません。");
				if (typeof info.revert === "string") info.revert = JSON.parse(info.revert);
				const modern = tables.has("session_message")
					? db
							.prepare("SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq")
							.all(request.sessionId)
					: [];
				let messages: unknown[];
				if (modern.length)
					messages = modern.map((row) => ({
						...record(JSON.parse(String(row.data))),
						id: row.id,
						type: row.type,
					}));
				else if (tables.has("message") && tables.has("part")) {
					const parts = db
						.prepare("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id")
						.all(request.sessionId);
					const byMessage = new Map<string, unknown[]>();
					for (const part of parts) {
						const key = String(part.message_id);
						const items = byMessage.get(key) ?? [];
						items.push({ ...record(JSON.parse(String(part.data))), id: part.id });
						byMessage.set(key, items);
					}
					messages = db
						.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
						.all(request.sessionId)
						.map((row) => ({
							info: { ...record(JSON.parse(String(row.data))), id: row.id },
							parts: byMessage.get(String(row.id)) ?? [],
						}));
				} else messages = [];
				result = { info, messages };
			} else throw new Error("Unknown database request");
		}
		reply = { result };
	} catch (error) {
		reply = { error: error instanceof Error ? error.message : String(error) };
	} finally {
		db?.close();
	}
	// Large IPC messages are queued; disconnecting before the callback truncates the snapshot.
	process.send?.(reply, (error) => {
		if (error) process.exitCode = 1;
		process.disconnect?.();
	});
});
