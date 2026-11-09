import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Content } from "../src/client/Content.tsx";
import { canResizeAttachment } from "../src/client/composer-image.ts";
import { jsonLines } from "../src/server/session-import/common.ts";

describe("memory-saving projections", () => {
	it("keeps thinking previews identical for long text and Unicode whitespace", () => {
		for (const text of ["", "  a\n  b  ", "😀\t日本語 ".repeat(80), " ".repeat(5000), `${"x".repeat(180)}  最後`]) {
			const normalized = text.replace(/\s+/g, " ").trim();
			const expected = normalized.length > 180 ? `…${normalized.slice(-180)}` : normalized;
			const html = renderToStaticMarkup(<Content value={{ type: "thinking", thinking: text }} onFile={() => {}} />);
			expect(html).toContain(`<span class="thinking-preview"><span>${expected}</span></span>`);
		}
	});

	it("preserves JSONL line numbers, BOM, CRLF and torn final lines", () => {
		const warnings: string[] = [];
		expect(jsonLines('\uFEFF{"id":1}\r\n\r\n{"id":2}\n{"incomplete":', warnings)).toEqual([{ id: 1 }, { id: 2 }]);
		expect(warnings).toHaveLength(1);
		expect(() => jsonLines('{"id":1}\r\n\r\nBAD\n{"id":2}\n', [])).toThrow("3 行目");
		expect(jsonLines('{"id":1}\n{"incomplete":', [], true)).toEqual([{ id: 1 }]);
	});

	it("keeps animated and unrecognized images on their original preview", () => {
		const signature = [137, 80, 78, 71, 13, 10, 26, 10];
		const chunk = (name: string) => [0, 0, 0, 0, ...Array.from(name, (letter) => letter.charCodeAt(0)), 0, 0, 0, 0];
		expect(canResizeAttachment("image/png", Uint8Array.from([...signature, ...chunk("IDAT")]))).toBe(true);
		expect(canResizeAttachment("image/png", Uint8Array.from([...signature, ...chunk("acTL"), ...chunk("IDAT")]))).toBe(false);
		const webp = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 0, 0, 0, 0, 0]);
		expect(canResizeAttachment("image/webp", webp)).toBe(true);
		webp[20] = 2;
		expect(canResizeAttachment("image/webp", webp)).toBe(false);
		expect(canResizeAttachment("image/gif", Uint8Array.from(Buffer.from("GIF89a")))).toBe(false);
		expect(canResizeAttachment("image/png", Uint8Array.from(signature))).toBe(false);
	});
});
