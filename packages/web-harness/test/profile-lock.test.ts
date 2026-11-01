import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { acquireProfile } from "../src/server/profile-lock.ts";

test("Web and desktop cannot write a profile concurrently, including path aliases", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-profile-lock-"));
	const release = await acquireProfile(directory);
	try {
		await expect(acquireProfile(join(directory, "."))).rejects.toThrow("既に起動");
	} finally {
		await release();
	}
	const again = await acquireProfile(directory);
	await again();
	await rm(directory, { recursive: true, force: true });
});

test("an abandoned heartbeat is reclaimed after the stale threshold", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-profile-stale-"));
	const path = join(directory, "web-harness.lock");
	await mkdir(join(directory, "web-harness"));
	await mkdir(path);
	const previous = new Date(Date.now() - 120_000);
	await utimes(path, previous, previous);
	const release = await acquireProfile(directory);
	await release();
	await rm(directory, { recursive: true, force: true });
});

test("a crashed owner does not block immediate restart while its heartbeat is still fresh", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-profile-crash-"));
	const child = fork(fileURLToPath(new URL("./fixtures/profile-lock-owner.ts", import.meta.url)), [directory], {
		execArgv: [],
		silent: true,
	});
	try {
		await once(child, "message");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const release = await acquireProfile(directory);
		await release();
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("an alive owner remains protected even if the disk heartbeat looks stale", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-profile-live-"));
	const child = fork(fileURLToPath(new URL("./fixtures/profile-lock-owner.ts", import.meta.url)), [directory], {
		execArgv: [],
		silent: true,
	});
	try {
		await once(child, "message");
		const past = new Date(Date.now() - 120_000);
		await utimes(join(directory, "web-harness.lock"), past, past);
		await expect(acquireProfile(directory)).rejects.toThrow(`PID: ${child.pid}`);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent restart attempts recover one crashed profile without admitting two owners", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-profile-race-"));
	const child = fork(fileURLToPath(new URL("./fixtures/profile-lock-owner.ts", import.meta.url)), [directory], {
		execArgv: [],
		silent: true,
	});
	try {
		await once(child, "message");
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const results = await Promise.allSettled(Array.from({ length: 4 }, () => acquireProfile(directory)));
		try {
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
		} finally {
			for (const result of results) if (result.status === "fulfilled") await result.value();
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("does not remove an unmarked lock or a new legacy lock with an old ownership record", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hasilan-profile-legacy-"));
	const path = join(directory, "web-harness.lock");
	const ownerPath = join(directory, "web-harness", "profile-owner.json");
	try {
		const release = await acquireProfile(directory);
		const previousOwner = await readFile(ownerPath, "utf8");
		await release();
		await mkdir(path);
		await expect(acquireProfile(directory)).rejects.toThrow("起動ロックを確認できません");
		await writeFile(ownerPath, previousOwner);
		await expect(acquireProfile(directory)).rejects.toThrow("起動ロックを確認できません");
		expect(await readFile(ownerPath, "utf8")).toBe(previousOwner);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
