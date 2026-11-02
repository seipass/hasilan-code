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
	const css = ["styles.css", "Motion.css", "MotionSwap.css", "TeamPane.css"]
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
			.poll(() => page.locator(".team-focus").evaluate((element) => element.scrollHeight > element.clientHeight))
			.toBe(true);
		await page.waitForTimeout(350);
		const width = await page.locator(".team-focus > .motion-size").evaluate((element) => element.clientWidth);
		expect(Math.abs(width - initial)).toBeLessThanOrEqual(1);
	} finally {
		await page.close();
	}
}, 30000);
