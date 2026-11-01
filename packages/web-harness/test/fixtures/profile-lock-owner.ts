import { acquireProfile } from "../../src/server/profile-lock.ts";

const release = await acquireProfile(process.argv[2]);
process.send?.({ type: "ready" });
const keepAlive = setInterval(() => undefined, 1000);
process.on("message", () => {
	void release().then(() => {
		clearInterval(keepAlive);
		process.disconnect();
	});
});
