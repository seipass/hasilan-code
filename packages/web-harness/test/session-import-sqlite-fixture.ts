import { DatabaseSync } from "node:sqlite";

// Synthetic producer schemas; executed in a child to keep SQLite initialization out of the test runner.
const [path, mode, cwd] = process.argv.slice(2);
const database = new DatabaseSync(path);
try {
	if (mode === "codex") {
		database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, updated_at INTEGER)");
		database
			.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)")
			.run("codex-example", cwd, "Original request", "Renamed Codex session", 1790812800);
	} else {
		const table = mode === "modern" ? "session_v2" : "session";
		database.exec(
			`CREATE TABLE ${table} (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER, revert TEXT)`,
		);
		database
			.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`)
			.run("oc-synthetic", cwd, "SQLite example", 1790812800000, null);
		if (mode === "modern") {
			database.exec(
				"CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
			);
			database
				.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)")
				.run(
					"u",
					"oc-synthetic",
					"user",
					1,
					JSON.stringify({ text: "SQLite user", files: [], agents: [], time: { created: 1790812800000 } }),
				);
			database
				.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)")
				.run(
					"a",
					"oc-synthetic",
					"assistant",
					2,
					JSON.stringify({ content: [{ type: "text", text: "SQLite answer" }], time: { created: 1790812801000 } }),
				);
		} else {
			database.exec(
				"CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT)",
			);
			database
				.prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
				.run("u", "oc-synthetic", 1, JSON.stringify({ role: "user" }));
			database
				.prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
				.run("a", "oc-synthetic", 2, JSON.stringify({ role: "assistant" }));
			database
				.prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
				.run("p1", "oc-synthetic", "u", JSON.stringify({ type: "text", text: "SQLite user" }));
			database
				.prepare("INSERT INTO part VALUES (?, ?, ?, ?)")
				.run("p2", "oc-synthetic", "a", JSON.stringify({ type: "text", text: "SQLite answer" }));
		}
	}
} finally {
	database.close();
}
