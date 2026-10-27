import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HOME_BACKGROUND_KEY,
	parseHomeBackground,
	prepareHomeBackground,
	readHomeBackground,
	saveHomeBackground,
} from "../src/client/home-background.ts";

const background = { image: "data:image/webp;base64,YWJj", name: "wallpaper.webp" };
afterEach(() => vi.unstubAllGlobals());

describe("home background persistence", () => {
	it("restores a saved image and removes only its own preference", () => {
		const values = new Map([["draft", "keep"]]);
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
			removeItem: (key: string) => {
				values.delete(key);
			},
		};
		saveHomeBackground(background, storage);
		expect(readHomeBackground(storage)).toEqual(background);
		saveHomeBackground(undefined, storage);
		expect(readHomeBackground(storage)).toBeUndefined();
		expect(values.get("draft")).toBe("keep");
		expect(values.has(HOME_BACKGROUND_KEY)).toBe(false);
	});
	it.each([
		{ label: "missing", value: null },
		{ label: "malformed", value: "broken" },
		{ label: "wrong shape", value: "[]" },
		{ label: "remote URL", value: JSON.stringify({ image: "https://example.com/image.png", name: "remote" }) },
		{ label: "non-raster image", value: JSON.stringify({ image: "data:image/svg+xml;base64,YWJj", name: "vector" }) },
		{
			label: "oversized image",
			value: JSON.stringify({ ...background, image: background.image + "A".repeat(1_400_000) }),
		},
	])("ignores an invalid stored background: $label", ({ value }) => {
		expect(parseHomeBackground(value)).toBeUndefined();
	});
	it("falls back when storage cannot be read and reports failed writes", () => {
		expect(
			readHomeBackground({
				getItem: () => {
					throw new Error("blocked");
				},
			}),
		).toBeUndefined();
		expect(() =>
			saveHomeBackground(background, {
				setItem: () => {
					throw new Error("quota");
				},
				removeItem: vi.fn(),
			}),
		).toThrow("背景を保存できませんでした");
	});
});

describe("home background image preparation", () => {
	it("bounds image dimensions while preserving aspect ratio and releasing the decoded image", async () => {
		const bitmap = { width: 4000, height: 2000, close: vi.fn() };
		const draw = vi.fn();
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ({ drawImage: draw }),
			toDataURL: () => background.image,
		};
		vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
		vi.stubGlobal("document", { createElement: () => canvas });
		expect(await prepareHomeBackground(new File(["image"], "landscape.png", { type: "image/png" }))).toEqual({
			...background,
			name: "landscape.png",
		});
		expect([canvas.width, canvas.height]).toEqual([1920, 960]);
		expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 1920, 960);
		expect(bitmap.close).toHaveBeenCalledOnce();
	});
	it("reduces dimensions further when the encoded image exceeds the storage budget", async () => {
		const bitmap = { width: 4000, height: 2000, close: vi.fn() };
		const encode = vi
			.fn()
			.mockReturnValueOnce(`data:image/webp;base64,${"A".repeat(1_400_000)}`)
			.mockReturnValue(background.image);
		const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: encode };
		vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
		vi.stubGlobal("document", { createElement: () => canvas });
		await prepareHomeBackground(new File(["image"], "landscape.png"));
		expect([canvas.width, canvas.height]).toEqual([1440, 720]);
		expect(bitmap.close).toHaveBeenCalledOnce();
	});
	it("rejects invalid files and decoding failures", async () => {
		await expect(prepareHomeBackground(new File(["text"], "text.txt", { type: "text/plain" }))).rejects.toThrow(
			"画像ファイル",
		);
		await expect(prepareHomeBackground(new File([], "empty.png"))).rejects.toThrow("20 MB");
		vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode")));
		await expect(prepareHomeBackground(new File(["invalid"], "image.png"))).rejects.toThrow(
			"画像を読み込めませんでした",
		);
	});
});
