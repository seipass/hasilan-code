import { expect, it } from "vitest";
import { ArtifactStore } from "../src/server/artifacts.ts";

it("bounds screenshot buffers without losing older images or session ownership", () => {
	const store = new ArtifactStore();
	try {
		const png = Buffer.alloc(1024 * 1024);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		const references = Array.from({ length: 24 }, (_, index) =>
			store.put({
				sessionId: index === 0 ? "first" : "other",
				agentId: "agent",
				bytes: png,
				mimeType: "image/png",
			}),
		);
		const entries = Reflect.get(store, "artifacts") as Map<string, { bytes?: Buffer }>;
		const retained = [...entries.values()].reduce((sum, entry) => sum + (entry.bytes?.length ?? 0), 0);
		console.log(`Screenshot cache retained ${retained / 1024 / 1024} MiB for 24 MiB of images`);
		expect(retained).toBeLessThanOrEqual(8 * 1024 * 1024);
		for (const reference of references) expect(store.get(reference.id)?.bytes.equals(png)).toBe(true);
		store.deleteSession("first");
		expect(store.get(references[0].id)).toBeUndefined();
		expect(store.get(references[1].id)?.sessionId).toBe("other");
	} finally {
		store.close();
	}
});
