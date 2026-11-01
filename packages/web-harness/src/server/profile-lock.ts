import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import lockfile from "proper-lockfile";

/** OS ownership disappears on process death, unlike a fresh heartbeat directory. */
async function acquireProcessLease(profile: string): Promise<() => Promise<void>> {
	const hash = createHash("sha256")
		.update(process.platform === "win32" ? profile.toLowerCase() : profile)
		.digest();
	const identity = hash.toString("hex");
	const port = 20_000 + (hash.readUInt32BE(0) % 20_000);
	const address =
		process.platform === "win32"
			? { path: `\\\\.\\pipe\\hasilan-code-profile-${identity}` }
			: { host: "127.0.0.1", port };
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
		socket.setTimeout(1000, () => socket.destroy());
		socket.end(`${JSON.stringify({ profile: identity, pid: process.pid })}\n`);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ ...address, exclusive: true }, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			!(error.code === "EADDRINUSE" || (process.platform === "win32" && error.code === "EACCES"))
		)
			throw error;
		const owner = await new Promise<number | undefined>((resolve) => {
			const socket = createConnection(address);
			let data = "";
			const finish = (pid?: number) => {
				socket.destroy();
				resolve(pid);
			};
			socket.setEncoding("utf8");
			socket.setTimeout(500, () => finish());
			socket.on("error", () => finish());
			socket.on("end", () => finish());
			socket.on("data", (chunk: string) => {
				data += chunk;
				if (data.length > 512) {
					finish();
					return;
				}
				if (!data.includes("\n")) return;
				try {
					const value: unknown = JSON.parse(data);
					if (
						value &&
						typeof value === "object" &&
						"profile" in value &&
						value.profile === identity &&
						"pid" in value &&
						typeof value.pid === "number" &&
						Number.isSafeInteger(value.pid) &&
						value.pid > 0
					) {
						finish(value.pid);
						return;
					}
				} catch {
					/* A different service may own this port. */
				}
				finish();
			});
		});
		if (owner !== undefined)
			throw new Error(
				`このデータを使うHasilan Codeが既に起動しています（PID: ${owner}）。Web版または別のデスクトップ版を終了してください。`,
			);
		throw new Error(
			process.platform === "win32"
				? "起動確認用の通信経路が使用中です。Hasilan Codeの起動状態を確認できません。"
				: `起動確認用ポート ${port} が別のプロセスに使われています。Hasilan Codeの起動状態を確認できません。`,
		);
	}
	server.unref();
	return () =>
		new Promise<void>((resolve, reject) => {
			for (const socket of sockets) socket.destroy();
			server.close((error) => {
				if (error) reject(error);
				else resolve();
			});
		});
}

/** The disk lease still protects shared data against an older running host. */
export async function acquireProfile(agentDir: string): Promise<() => Promise<void>> {
	await mkdir(join(agentDir, "web-harness"), { recursive: true });
	const directory = await realpath(join(agentDir, "web-harness"));
	const releaseProcess = await acquireProcessLease(directory);
	const ownerPath = join(directory, "profile-owner.json");
	let releaseFile: (() => Promise<void>) | undefined;
	try {
		try {
			const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
			const previous = await stat(`${directory}.lock`);
			if (
				owner &&
				typeof owner === "object" &&
				"version" in owner &&
				owner.version === 1 &&
				"inode" in owner &&
				owner.inode === previous.ino &&
				"createdAt" in owner &&
				owner.createdAt === previous.birthtimeMs
			) {
				// We own the kernel lease, so this exact marked directory belongs to a dead owner.
				// Never recursively remove it or remove a different directory created by an older host.
				await rmdir(`${directory}.lock`);
			}
		} catch (error) {
			if (
				!(error instanceof SyntaxError) &&
				(!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
			)
				throw error;
		}
		releaseFile = await lockfile.lock(directory, { stale: 60_000, update: 10_000, retries: 0 });
		const owned = await stat(`${directory}.lock`);
		await writeFile(
			ownerPath,
			JSON.stringify({ version: 1, pid: process.pid, inode: owned.ino, createdAt: owned.birthtimeMs }),
			{ mode: 0o600 },
		);
		let releasing: Promise<void> | undefined;
		return () => {
			releasing ??= (async () => {
				try {
					await releaseFile!();
					await rm(ownerPath, { force: true });
				} finally {
					await releaseProcess();
				}
			})();
			return releasing;
		};
	} catch (error) {
		try {
			await releaseFile?.();
		} finally {
			await releaseProcess();
		}
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			throw new Error(
				"このデータの起動ロックを確認できません。旧版が起動中か、前回のロックが残っています。旧版を終了し、最大1分後に再試行してください。",
			);
		}
		throw error;
	}
}
