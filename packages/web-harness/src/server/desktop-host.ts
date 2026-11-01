import { startHarness } from "./main.ts";

// Only the owning Electron main process can use this channel. Never expose it through HTTP.
if (!process.send) throw new Error("Desktop host requires an IPC parent");
let runtime: Awaited<ReturnType<typeof startHarness>> | undefined;
let stopping = false;
let picker: { id: number; resolve: (path: string | undefined) => void; reject: (error: Error) => void } | undefined;
let nextPicker = 0;

async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	picker?.reject(new Error("Desktop host is stopping"));
	try {
		await runtime?.shutdown();
	} finally {
		if (process.connected) process.disconnect();
	}
}

process.once("disconnect", () => {
	void stop().then(
		() => process.exit(),
		() => process.exit(1),
	);
});
process.once("SIGTERM", () => {
	void stop();
});
process.once("SIGINT", () => {
	void stop();
});
process.on("message", (message: unknown) => {
	if (!message || typeof message !== "object") return;
	const value = message as Record<string, unknown>;
	if (value.type === "shutdown") {
		void stop().catch(() => {
			process.exitCode = 1;
		});
	} else if (value.type === "activity" && typeof value.id === "number") {
		process.send?.({ type: "activity", id: value.id, ...runtime?.activity() });
	} else if (value.type === "folder" && value.id === picker?.id) {
		picker?.resolve(typeof value.path === "string" ? value.path : undefined);
	}
});

try {
	runtime = await startHarness(
		{
			cwd: process.cwd(),
			port: 0,
			noOpen: true,
			help: false,
			lan: false,
			development: false,
		},
		{
			pickFolder: async (cwd, signal) => {
				const pending = Promise.withResolvers<string | undefined>();
				const id = ++nextPicker;
				picker = { id, ...pending };
				const abort = () => pending.reject(new Error("Folder picker cancelled"));
				signal.addEventListener("abort", abort, { once: true });
				process.send?.({ type: "pick-folder", id, cwd });
				try {
					return await pending.promise;
				} finally {
					signal.removeEventListener("abort", abort);
					picker = undefined;
				}
			},
		},
	);
	if (stopping || !process.connected) await runtime.shutdown();
	else process.send?.({ type: "ready", ...runtime.launch });
} catch (error) {
	process.send?.({ type: "fatal", message: error instanceof Error ? error.message : "Host startup failed" });
	process.exitCode = 1;
	await stop();
}
