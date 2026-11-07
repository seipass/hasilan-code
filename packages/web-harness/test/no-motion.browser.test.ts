import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("switches pages and closes overlays without animation calls or transition events", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Presence, mediaReady } from "./src/client/Motion.tsx";
import { MotionSwap } from "./src/client/MotionSwap.tsx";
import { MobileSheet } from "./src/client/MobileSheet.tsx";
import { SettingsDialog } from "./src/client/SettingsDialog.tsx";
import { transitionItems } from "./src/client/item-transition.ts";
import { useComposerSize } from "./src/client/use-composer-size.ts";
import { useAnimatedView } from "./src/client/animated-view.ts";
function Fixture() {
 const [show, setShow] = useState(true), [identity, setIdentity] = useState("first");
 const [sheet, setSheet] = useState(false), [settings, setSettings] = useState(false), [text, setText] = useState("");
 const anchor = useRef(null), input = useRef(null);
 const { view, animateView } = useAnimatedView({ x: 0, y: 0, zoom: 1 });
 useComposerSize(input, text);
 return <>
 <button onClick={() => setShow(value => !value)}>Toggle notice</button>
 <Presence show={show} collapse><p>Notice</p></Presence>
 <button onClick={() => transitionItems(() => setIdentity("second"))}>Switch page</button>
 <MotionSwap identity={identity}><p>{identity} page</p></MotionSwap>
 <button ref={anchor} onClick={event => { mediaReady(event.currentTarget); setSheet(true); }}>Open sheet</button>
 <MobileSheet open={sheet} side="top" title="Example" motionAnchor={anchor} onClose={() => setSheet(false)}>Sheet body</MobileSheet>
 <button onClick={() => setSettings(true)}>Open settings</button>
 {settings && <SettingsDialog onClose={() => setSettings(false)} onSaved={() => {}} onHomeBackgroundChange={() => {}} />}
 <textarea ref={input} aria-label="Draft" value={text} onChange={event => setText(event.target.value)} />
 <button onClick={() => animateView({ x: 100, y: 50, zoom: 2 })}>Move view</button>
 <output>{view.x}:{view.zoom}</output>
 <p className="turn-activity-waiting"><span className="turn-activity-label">Thinking</span></p>
 </>;
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
	const css = [
		"Motion.css",
		"MotionSwap.css",
		"MobileSheet.css",
		"SettingsMotion.css",
		"Conversation.css",
		"NoMotion.css",
	]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.route("**/api/**", (route) =>
			route.fulfill({
				json: route.request().url().endsWith("/models")
					? { providers: [], models: [] }
					: {
							translation: { language: "日本語" },
							search: { defaultProvider: "brave", rustxngUrl: "", configured: {} },
							teams: { maxConcurrentAgents: 4, maxDepth: 2 },
						},
			}),
		);
		await page.setContent(`<style>${css}</style><div id="root"></div>`);
		const metrics = await page.evaluateHandle(() => {
			const metrics = { animations: 0, snapshots: 0 };
			const animate = Element.prototype.animate;
			Element.prototype.animate = function (...args) {
				metrics.animations++;
				return animate.apply(this, args);
			};
			const transition = document.startViewTransition.bind(document);
			document.startViewTransition = (...args) => {
				metrics.snapshots++;
				return transition(...args);
			};
			return metrics;
		});
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		await page.getByRole("button", { name: "Switch page", exact: true }).click();
		await page.getByText("second page", { exact: true }).waitFor();
		await page.getByRole("button", { name: "Toggle notice", exact: true }).click();
		await expect.poll(() => page.getByText("Notice", { exact: true }).count()).toBe(0);
		await page.getByRole("button", { name: "Open sheet", exact: true }).click();
		await page.getByRole("button", { name: "Exampleを閉じる", exact: true }).click();
		await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
		await page.getByRole("button", { name: "Open settings", exact: true }).click();
		await page.getByRole("button", { name: "設定を閉じる", exact: true }).click();
		await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
		await page.getByRole("textbox", { name: "Draft" }).fill("One\nTwo\nThree\nFour");
		await page.getByRole("button", { name: "Move view", exact: true }).click();
		await page.getByText("100:2", { exact: true }).waitFor();
		expect(await metrics.jsonValue()).toEqual({ animations: 0, snapshots: 0 });
		expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
		expect(
			await page
				.locator(".turn-activity-label")
				.evaluate((element) => getComputedStyle(element).webkitTextFillColor),
		).not.toBe("rgba(0, 0, 0, 0)");
	} finally {
		await browser.close();
	}
}, 30000);
