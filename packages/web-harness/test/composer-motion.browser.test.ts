import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("resizes the composer without animation while preserving input focus", async () => {
	const bundle = await build({
		stdin: {
			resolveDir: fileURLToPath(new URL("../", import.meta.url)),
			loader: "tsx",
			contents: `
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useComposerSize } from "./src/client/use-composer-size.ts";
function Fixture() {
 const [text, setText] = useState("");
 const input = useRef(null);
 useComposerSize(input, text);
 window.setDraft = value => flushSync(() => setText(value));
 return <div className="composer-area"><form className="composer"><div className="composer-input-row"><textarea ref={input} aria-label="Draft" value={text} onChange={event => setText(event.target.value)} rows={2} /></div><div id="toolbar">Toolbar</div></form></div>;
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
	const css = ["styles.css", "CleanAppearance.css", "NoMotion.css"]
		.map((name) => readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), "utf8"))
		.join("\n");
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ reducedMotion: "no-preference" });
		await page.setContent(
			`<style>${css} #root { height: 600px; display: flex; flex-direction: column; justify-content: flex-end; }</style><div id="root"></div>`,
		);
		await page.addScriptTag({ content: bundle.outputFiles[0].text });
		const result = await page.evaluate(async () => {
			const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
			const setDraft = (window as unknown as { setDraft: (text: string) => void }).setDraft;
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const height = () => input.getBoundingClientRect().height;
			input.focus();
			const initial = height();
			setDraft("One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight");
			const opening: number[] = [];
			for (let index = 0; index < 6; index++) {
				await frame();
				opening.push(height());
			}
			const beforeEdit = height();
			setDraft("One\nTwo\nThree\nFour");
			await frame();
			return {
				initial,
				opening,
				beforeEdit,
				afterEdit: height(),
				animations: input.getAnimations().length,
				focused: document.activeElement === input,
			};
		});
		expect(new Set(result.opening.map(Math.round)).size).toBe(1);
		expect(result.opening[0]).toBeGreaterThan(result.initial);
		expect(result.afterEdit).toBeLessThan(result.beforeEdit);
		expect(result.animations).toBe(0);
		expect(result.focused).toBe(true);
		const input = page.getByRole("textbox", { name: "Draft" });
		await input.fill("First line");
		await input.press("End");
		await input.press("Shift+Enter");
		await input.pressSequentially("Second line");
		expect(await input.inputValue()).toBe("First line\nSecond line");
		expect(
			await input.evaluate(
				(element: HTMLTextAreaElement) =>
					document.activeElement === element && element.selectionStart === element.value.length,
			),
		).toBe(true);
		await page.emulateMedia({ reducedMotion: "reduce" });
		await input.fill("One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine");
		expect(await input.evaluate((element) => element.getAnimations().length)).toBe(0);
	} finally {
		await browser.close();
	}
}, 30000);
