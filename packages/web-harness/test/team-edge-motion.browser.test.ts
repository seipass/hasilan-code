import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("moves the waiting edge toward its destination without moving nodes", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TeamPane } from "./src/client/TeamPane.tsx";
function Fixture() {
 const [waiting, setWaiting] = useState(true);
 window.finishWaiting = () => setWaiting(false);
 const childRun = { runId: "child-run", agentId: "child", task: "Work", status: "running" };
 const rootRun = { runId: "root-run", agentId: "root", task: "Wait", status: waiting ? "waiting" : "running", waitingOnRunIds: waiting ? ["child-run"] : [] };
 const agents = [
  { agentId: "root", teamId: "team", sessionId: "session", name: "Root", role: "root", currentRun: rootRun },
  { agentId: "child", teamId: "team", sessionId: "child-session", parentAgentId: "root", name: "Child", role: "worker", currentRun: childRun },
 ];
 return <div className="detail-auxiliary"><TeamPane snapshot={{ teams: [], agents, runs: [rootRun, childRun] }} sessions={[]} selectedSessionId="session" onSelect={() => {}} onStop={() => {}} onFile={() => {}} /></div>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const css = ["styles.css", "TeamPane.css", "TeamGraphAppearance.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: "no-preference" });
		await page.setContent(
			`<style>${css} .detail-auxiliary { position: relative; width: 1100px; height: 900px; }</style><div id="root"></div>`,
		);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const edge = page.locator(".team-graph-edge.is-waiting");
		await edge.waitFor({ state: "attached" });
		const sample = await edge.evaluate(async (element) => {
			const firstNode = document.querySelector(".team-graph-node")!;
			const before = firstNode.getBoundingClientRect();
			const offsets: number[] = [];
			for (let index = 0; index < 8; index++) {
				await new Promise(requestAnimationFrame);
				offsets.push(Number.parseFloat(getComputedStyle(element).strokeDashoffset));
			}
			const after = firstNode.getBoundingClientRect();
			return { offsets, nodeMovement: Math.abs(after.x - before.x) + Math.abs(after.y - before.y) };
		});
		expect(sample.offsets.at(-1)).toBeLessThan(sample.offsets[0]);
		expect(sample.nodeMovement).toBeLessThan(1);
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(await edge.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await page.evaluate(() => (window as unknown as { finishWaiting: () => void }).finishWaiting());
		await expect.poll(() => page.locator(".team-graph-edge.is-parent").count()).toBe(1);
		expect(
			await page
				.locator(".team-graph-edge.is-parent")
				.evaluate((element) => getComputedStyle(element).animationName),
		).toBe("none");
	} finally {
		await browser.close();
	}
}, 30000);
