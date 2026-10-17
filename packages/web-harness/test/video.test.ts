import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpHost } from "../src/server/http-host.ts";
import { serveVideo, videoView } from "../src/server/video.ts";
import { WorkspaceFiles } from "../src/server/workspace-files.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "hasilan-video-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const bytes = Buffer.alloc(512);
	bytes.write("ftyp", 4);
	bytes.write("isom", 8);
	for (let i = 16; i < bytes.length; i++) bytes[i] = i % 251;
	await writeFile(join(root, "clip.mp4"), bytes);
	const files = new WorkspaceFiles();
	const workspace = await files.register(root);
	const view = (await videoView(files, workspace.id, "clip.mp4"))!;
	const host = createHttpHost({
		port: 0,
		handleApi: (request, response, url) =>
			serveVideo(
				files,
				workspace.id,
				url.searchParams.get("path") ?? "clip.mp4",
				url.searchParams.get("revision"),
				request,
				response,
			),
	});
	const launch = await host.listen();
	cleanups.push(() => host.close());
	const auth = await fetch(launch.launchUrl, { redirect: "manual" });
	const cookie = auth.headers.get("set-cookie")!.split(";")[0];
	const url = `${launch.origin}/api/video?revision=${encodeURIComponent(view.revision)}`;
	return { root, bytes, files, workspace, view, url, cookie };
}

describe("workspace video streaming", () => {
	it.each([
		["bytes=16-31", 16, 31],
		["bytes=500-", 500, 511],
		["bytes=-12", 500, 511],
		["bytes=500-999", 500, 511],
	] as const)("serves seek range %s with exact content boundaries", async (range, start, end) => {
		const f = await fixture();
		const response = await fetch(f.url, { headers: { cookie: f.cookie, range } });
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/512`);
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes.subarray(start, end + 1));
	});
	it.each(["bytes=512-", "bytes=31-16", "bytes=-0", "bytes=0-1,8-9", "bytes=-", "invalid"])(
		"rejects unsatisfiable range %s",
		async (range) => {
			const f = await fixture();
			const response = await fetch(f.url, { headers: { cookie: f.cookie, range } });
			expect(response.status).toBe(416);
			expect(response.headers.get("content-range")).toBe("bytes */512");
			expect(await response.text()).toBe("");
		},
	);
	it("supports full content and HEAD while rejecting stale revisions and unauthenticated access", async () => {
		const f = await fixture();
		const full = await fetch(f.url, { headers: { cookie: f.cookie } });
		expect(full.status).toBe(200);
		expect(full.headers.get("accept-ranges")).toBe("bytes");
		expect(Buffer.from(await full.arrayBuffer())).toEqual(f.bytes);
		const head = await fetch(f.url, { method: "HEAD", headers: { cookie: f.cookie } });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("512");
		expect(await head.text()).toBe("");
		expect((await fetch(f.url)).status).toBe(401);
		await writeFile(join(f.root, "clip.mp4"), Buffer.concat([f.bytes, Buffer.from("changed")]));
		expect((await fetch(f.url, { headers: { cookie: f.cookie } })).status).toBe(409);
	});
	it("does not classify renamed HTML as video and preserves workspace path confinement", async () => {
		const f = await fixture();
		await writeFile(join(f.root, "fake.mp4"), "<html>not a video</html>");
		expect(await videoView(f.files, f.workspace.id, "fake.mp4")).toBeUndefined();
		await expect(videoView(f.files, f.workspace.id, "../outside.mp4")).rejects.toThrow("Path escapes workspace");
	});
});
