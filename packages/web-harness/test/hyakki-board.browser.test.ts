import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";

let browser: Browser;
let script: string;

beforeAll(async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HyakkiPanel } from "./src/client/HyakkiPanel.tsx";
import { TeamPane } from "./src/client/TeamPane.tsx";
function Fixture() {
 const [paused, setPaused] = useState(false);
 const [boardRequest, setBoardRequest] = useState(0);
 const swarm = {
  id: "swarm-1",
  objective: "認証基盤と設定画面を並列実装して検証する",
  createdAt: "2026-11-28T00:00:00.000Z",
  updatedAt: "2026-11-28T00:05:00.000Z",
  status: paused ? "paused" : "active",
  rootRunId: "r1",
  tasks: [
   {
    id: "t1",
    title: "認証トークン検証を実装",
    status: "done",
    ownerAgentId: "a2",
    ownerName: "Backend",
    ownedPaths: ["src/auth"],
    acceptanceCriteria: ["JWT検証テストが通る"],
    needsReview: true,
    reviews: [{ id: "rev1", reviewerAgentId: "a3", reviewerName: "Reviewer", verdict: "approved", summary: "境界値チェック良好", createdAt: "2026-11-28T00:03:00.000Z" }],
    updatedAt: "2026-11-28T00:03:00.000Z",
   },
   {
    id: "t2",
    title: "設定画面 UI を構築",
    status: "in_progress",
    ownerAgentId: "a3",
    ownerName: "Reviewer",
    ownedPaths: ["src/ui/settings.tsx"],
    needsReview: true,
    updatedAt: "2026-11-28T00:04:00.000Z",
   },
  ],
  checks: [
   { id: "c1", name: "typecheck", command: "npm run check", status: "passed", exitCode: 0, runByName: "Root", summary: "0 errors", updatedAt: "2026-11-28T00:04:30.000Z" },
  ],
  notes: [
   { id: "n1", kind: "contract", authorAgentId: "a2", authorName: "Backend", title: "Session API contract", body: "GET /api/session returns userId", paths: ["src/auth/api.ts"], createdAt: "2026-11-28T00:02:00.000Z" },
  ],
  events: [
   { id: "e1", kind: "plan", actorAgentId: "a1", actorName: "Root", summary: "ボード計画を更新（タスク 2件・検証 1件）", createdAt: "2026-11-28T00:01:00.000Z" },
  ],
 };
 const agents = [
  { agentId: "a1", teamId: "t1", sessionId: "s1", name: "Root", role: "root", responsibility: "全体統括" },
  { agentId: "a2", teamId: "t1", parentAgentId: "a1", sessionId: "s2", name: "Backend", role: "Backend", responsibility: "認証API", worktree: "adopted" },
  { agentId: "a3", teamId: "t1", parentAgentId: "a1", sessionId: "s3", name: "Reviewer", role: "Reviewer", responsibility: "レビューとUI", worktree: "active" },
 ];
 const sessions = [{ sessionId: "s1", workspaceId: "w1", cwd: "/tmp", materialized: true, availability: "ready", pendingInput: [], swarm }];
 return (
  <div style={{ display: "grid", gap: "16px", padding: "12px" }}>
   <HyakkiPanel
    swarm={swarm}
    runningWorkers={1}
    busy={false}
    connected={true}
    unavailable={false}
    onPause={async () => setPaused(true)}
    onContinue={async () => setPaused(false)}
    onOpenBoard={() => setBoardRequest((v) => v + 1)}
    onDismiss={() => {}}
   />
   <div className="detail-auxiliary" style={{ position: "relative", width: "960px", height: "640px" }}>
    <TeamPane
     snapshot={{ teams: [{ teamId: "t1", rootAgentId: "a1", workspaceId: "w1", scope: "workspace" }], agents, runs: [] }}
     sessions={sessions}
     selectedSessionId="s1"
     onSelect={() => {}}
     onStop={() => {}}
     onFile={() => {}}
     onPauseSwarm={async () => setPaused(true)}
     onContinueSwarm={async () => setPaused(false)}
     boardRequest={boardRequest}
    />
   </div>
  </div>
 );
}
createRoot(document.getElementById("root")).render(<Fixture />);`,
		},
		bundle: true,
		write: false,
		jsx: "automatic",
		loader: { ".css": "empty" },
		format: "iife",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	script = bundle.outputFiles[0].text;
	browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
	await browser?.close();
});

it("renders HyakkiPanel progress and opens the interactive SwarmBoard inside TeamPane", async () => {
	const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
	try {
		const css = [
			"styles.css",
			"Motion.css",
			"MotionSwap.css",
			"HyakkiPanel.css",
			"SwarmBoard.css",
			"TeamPane.css",
			"TeamGraphAppearance.css",
			"CleanAppearance.css",
			"NoMotion.css",
		]
			.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
			.join("\n");
		await page.setContent(`<style>${css}</style><div id="root"></div>`);
		await page.addScriptTag({ content: script });

		await page.locator(".hyakki-panel > summary").waitFor();
		const summaryText = await page.locator(".hyakki-panel > summary").textContent();
		expect(summaryText).toContain("タスク 1/2");
		expect(summaryText).toContain("検証 1/1");
		await page.locator(".hyakki-panel > summary").click();
		const taskListText = await page.locator(".hyakki-task-list").textContent();
		expect(taskListText).toContain("認証トークン検証を実装");
		expect(taskListText).toContain("承認済");

		// Open the shared board via HyakkiPanel's action button.
		await page.getByRole("button", { name: "チーム・ボードを開く" }).click();
		await page.locator(".team-board-layout").waitFor();
		expect(await page.locator(".team-board-layout").isVisible()).toBe(true);
		const boardText = await page.locator(".team-board-layout").textContent();
		expect(boardText).toContain("Session API contract");
		expect(boardText).toContain("境界値チェック良好");
		expect(boardText).toContain("npm run check");

		// Clicking an owner on the board focuses that specialist and shows its worktree section.
		await page.locator(".team-board-layout").getByRole("button", { name: "Backend" }).click();
		await page.locator(".team-worktree-section").waitFor();
		expect(await page.locator(".team-focus").textContent()).toContain("Backend");
		expect(await page.locator(".team-worktree-section").textContent()).toContain("採用済み");

		// Pause button updates swarm status live.
		await page.locator(".hyakki-panel").getByRole("button", { name: "一時停止" }).click();
		await expect.poll(() => page.locator(".hyakki-panel > summary").textContent()).toContain("一時停止");
	} finally {
		await page.close();
	}
}, 30_000);
