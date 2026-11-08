import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
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
import { TeamPane } from "./src/client/TeamPane.tsx";
function Fixture() {
 const [responsibility, setResponsibility] = useState("短い担当範囲");
 const [minutes, setMinutes] = useState(9);
 window.updateResponsibility = setResponsibility;
 window.updateMinutes = setMinutes;
 const run = { runId: "run", agentId: "root", task: "作業を進める", status: "running", startedAt: new Date(Date.now() - minutes * 60000).toISOString() };
 const root = { agentId: "root", teamId: "team", sessionId: "session", name: "Root", role: "root", responsibility, currentRun: run };
 return <div className="detail-auxiliary"><TeamPane snapshot={{ teams: [], agents: [root], runs: [run] }} sessions={[]} selectedSessionId="session" onSelect={() => {}} onStop={() => {}} onFile={() => {}} /></div>;
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
}, 30000);

afterAll(async () => {
	await browser?.close();
});

async function showTeam(page: Page, width: number) {
	const css = [
		"styles.css",
		"Motion.css",
		"MotionSwap.css",
		"TeamPane.css",
		"TeamGraphAppearance.css",
		"CleanAppearance.css",
		"NoMotion.css",
	]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	await page.setContent(
		`<style>${css}\n.detail-auxiliary { position: relative; width: ${width}px; height: 900px; }</style><div id="root"></div>`,
	);
	await page.addScriptTag({ content: script });
	await page.locator(".team-focus-actions button").waitFor();
	await page.waitForTimeout(350);
}

it.each([320, 700])(
	"keeps the elapsed time on one line while its value changes at %ipx",
	async (width) => {
		const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
		try {
			await showTeam(page, width);
			const heights = await page.evaluate(async () => {
				const label = document.querySelector(".team-run-meta > span:last-child .motion-label-swap") as HTMLElement;
				const update = (window as unknown as { updateMinutes: (minutes: number) => void }).updateMinutes;
				const initial = label.getBoundingClientRect().height;
				update(754);
				let maximum = initial;
				const start = performance.now();
				while (performance.now() - start < 400) {
					await new Promise(requestAnimationFrame);
					maximum = Math.max(maximum, label.getBoundingClientRect().height);
				}
				return { initial, maximum };
			});
			expect(heights.maximum).toBeLessThanOrEqual(heights.initial + 1);
		} finally {
			await page.close();
		}
	},
	30000,
);

it.each([320, 700])(
	"keeps the bottom action visible while content changes at %ipx",
	async (width) => {
		const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
		try {
			await showTeam(page, width);
			const clipped = await page.evaluate(async () => {
				const panel = document.querySelector(".team-focus .motion-size") as HTMLElement;
				const button = document.querySelector(".team-focus-actions button") as HTMLElement;
				const update = (window as unknown as { updateResponsibility: (text: string) => void }).updateResponsibility;
				update("長い担当範囲。".repeat(18));
				let worst = 0;
				const start = performance.now();
				let shortened = false;
				while (performance.now() - start < 700) {
					await new Promise(requestAnimationFrame);
					if (!shortened && performance.now() - start > 300) {
						shortened = true;
						update("短い担当範囲");
					}
					worst = Math.max(worst, button.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom);
				}
				return worst;
			});
			expect(clipped).toBeLessThanOrEqual(1);
		} finally {
			await page.close();
		}
	},
	30000,
);

it("keeps the detail content width when the panel starts scrolling", async () => {
	const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
	try {
		await showTeam(page, 700);
		const initial = await page.locator(".team-focus > .motion-size").evaluate((element) => element.clientWidth);
		await page.evaluate(() => {
			(window as unknown as { updateResponsibility: (text: string) => void }).updateResponsibility(
				"長い担当範囲。".repeat(250),
			);
		});
		await expect
			.poll(() => page.locator(".team-inspector").evaluate((element) => element.scrollHeight > element.clientHeight))
			.toBe(true);
		await page.waitForTimeout(350);
		const width = await page.locator(".team-focus > .motion-size").evaluate((element) => element.clientWidth);
		expect(Math.abs(width - initial)).toBeLessThanOrEqual(1);
	} finally {
		await page.close();
	}
}, 30000);

it("groups status and the selected agent in a sidebar and keeps display controls collapsed on the canvas", async () => {
	const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
	try {
		await showTeam(page, 1100);
		const inspector = page.getByRole("complementary", { name: "チームの概要と担当の詳細" });
		expect(await inspector.locator(".team-overview").count()).toBe(1);
		expect(await inspector.locator(".team-graph-controls").count()).toBe(0);
		expect(await page.getByRole("button", { name: "関係図を拡大", exact: true }).isVisible()).toBe(false);
		await page.locator(".team-graph-controls > summary").click();
		expect(await page.getByRole("button", { name: "関係図を拡大", exact: true }).isVisible()).toBe(true);
		await page.locator(".team-graph-controls > summary").click();
		expect(await inspector.locator(".team-focus").count()).toBe(1);
		const graphBounds = await page.locator(".team-graph-viewport").boundingBox();
		const inspectorBounds = await inspector.boundingBox();
		expect(graphBounds!.x + graphBounds!.width).toBeLessThanOrEqual(inspectorBounds!.x + 1);
		await page.getByRole("button", { name: "担当の詳細を閉じる" }).click();
		expect(await inspector.locator(".team-focus").count()).toBe(0);
		await inspector.getByRole("button", { name: "親AIの詳細", exact: true }).click();
		expect(await inspector.locator(".team-focus").count()).toBe(1);
		await page.getByRole("button", { name: "一覧", exact: true }).click();
		expect(await inspector.locator(".team-overview").count()).toBe(1);
		expect(await inspector.locator(".team-focus").count()).toBe(1);
	} finally {
		await page.close();
	}
}, 30000);
