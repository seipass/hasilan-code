import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type Activity, localOrigin, readActivity } from "./protocol.ts";

export interface HostOptions {
	executable: string;
	entry: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	pickFolder: (cwd: string) => Promise<string | undefined>;
}

/** One owned child, one private IPC channel; launch credentials never enter stdout. */
export class DesktopHost extends EventEmitter {
	private child?: ChildProcess;
	private stopping?: Promise<void>;
	private sequence = 0;
	private pending = new Map<number, { resolve: (activity: Activity) => void; reject: (error: Error) => void }>();
	private ready?: { resolve: (url: string) => void; reject: (error: Error) => void };
	private exited?: Promise<void>;
	private expectedExit = false;
	origin?: string;
	url?: string;

	async start(options: HostOptions): Promise<string> {
		if (this.child) throw new Error("Host is already started");
		const ready = Promise.withResolvers<string>();
		this.ready = ready;
		const exited = Promise.withResolvers<void>();
		this.exited = exited.promise;
		this.child = spawn(options.executable, [options.entry], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: "1" },
			windowsHide: true,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const fail = (error: Error) => {
			this.ready?.reject(error);
			for (const entry of this.pending.values()) entry.reject(error);
			this.pending.clear();
		};
		this.child.once("error", (error) => {
			exited.resolve();
			fail(error);
		});
		this.child.once("exit", () => {
			this.url = undefined;
			exited.resolve();
			fail(new Error("Hasilan Codeサーバーが終了しました。再起動してください。"));
			if (!this.expectedExit) this.emit("crashed");
		});
		this.child.on("message", (message: unknown) => {
			if (!message || typeof message !== "object") return;
			const value = message as Record<string, unknown>;
			if (value.type === "ready" && typeof value.launchUrl === "string" && typeof value.url === "string") {
				try {
					this.origin = localOrigin(value.url);
					if (localOrigin(value.launchUrl) !== this.origin) throw new Error("Launch origin mismatch");
					this.url = value.url;
					ready.resolve(value.launchUrl);
				} catch (error) {
					fail(error instanceof Error ? error : new Error("Invalid launch address"));
				}
			} else if (value.type === "fatal" && typeof value.message === "string") {
				fail(new Error(value.message));
			} else if (value.type === "activity" && typeof value.id === "number") {
				const request = this.pending.get(value.id);
				const activity = readActivity(value);
				if (activity) request?.resolve(activity);
				else request?.reject(new Error("Could not read running work"));
			} else if (value.type === "pick-folder" && typeof value.id === "number" && typeof value.cwd === "string") {
				void options.pickFolder(value.cwd).then(
					(path) => this.send({ type: "folder", id: value.id, path }),
					() => this.send({ type: "folder", id: value.id }),
				);
			}
		});
		const timeout = setTimeout(() => ready.reject(new Error("サーバーの起動が時間内に完了しませんでした。")), 60_000);
		try {
			return await ready.promise;
		} catch (error) {
			await this.stop();
			throw error;
		} finally {
			clearTimeout(timeout);
			this.ready = undefined;
		}
	}

	async activity(): Promise<Activity> {
		const id = ++this.sequence;
		const pending = Promise.withResolvers<Activity>();
		this.pending.set(id, pending);
		const timeout = setTimeout(() => pending.reject(new Error("実行中の作業を確認できませんでした。")), 5_000);
		this.send({ type: "activity", id });
		try {
			return await pending.promise;
		} finally {
			clearTimeout(timeout);
			this.pending.delete(id);
		}
	}

	stop(): Promise<void> {
		this.stopping ??= this.shutdown().catch((error: unknown) => {
			this.stopping = undefined;
			throw error;
		});
		return this.stopping;
	}

	private async shutdown(): Promise<void> {
		this.expectedExit = true;
		if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
		this.send({ type: "shutdown" });
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<false>((resolve) => {
			timeout = setTimeout(() => resolve(false), 20_000);
		});
		const closed = await Promise.race([this.exited?.then(() => true), deadline]);
		clearTimeout(timeout);
		if (!closed) {
			this.child.kill();
			throw new Error("サーバーの終了がタイムアウトしました。処理の状態を確認してから再起動してください。");
		}
	}

	private send(message: object): void {
		if (this.child?.connected) this.child.send(message, () => {});
	}
}
