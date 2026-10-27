import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerAttachments, useComposerAttachments } from "../src/client/ComposerAttachments.tsx";
import { ATTACHMENT_LIMITS } from "../src/shared/attachments.ts";

let composer: ReturnType<typeof useComposerAttachments>;
let failRead = false;
let sequence = 0;
function Probe({ draftKey }: { draftKey: string }) {
	composer = useComposerAttachments(draftKey);
	return createElement(ComposerAttachments, { attachments: composer.attachments, disabled: false, onRemove: (id: string) => composer.remove([id]) });
}
function render(draftKey: string) { return renderToStaticMarkup(createElement(Probe, { draftKey })); }

beforeEach(() => {
	failRead = false;
	vi.stubGlobal("FileReader", class {
		result: string | null = null;
		onload?: () => void;
		onerror?: () => void;
		onabort?: () => void;
		readAsDataURL(file: File) {
			void file.arrayBuffer().then((bytes) => {
				if (failRead) { this.onerror?.(); return; }
				this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
				this.onload?.();
			});
		}
	});
});
afterEach(() => { vi.unstubAllGlobals(); });

it("previews images and filenames, retains each conversation's draft, and clears only sent files", async () => {
	const first = `first-${sequence++}`;
	const second = `second-${sequence++}`;
	render(first);
	await composer.addFiles([new File(["image"], "画面.png", { type: "image/png" }), new File(["notes"], "仕様.txt", { type: "text/plain" })]);
	const markup = render(first);
	expect(markup).toContain("data:image/png;base64,aW1hZ2U=");
	expect(markup).toContain("仕様.txt");
	const sent = composer.attachments.map((attachment) => attachment.id);
	expect(render(second)).not.toContain("仕様.txt");
	expect(render(first)).toContain("仕様.txt");
	await composer.addFiles([new File(["next"], "次の依頼.md")]);
	composer.remove(sent);
	expect(render(first)).not.toContain("仕様.txt");
	expect(composer.attachments.map((attachment) => attachment.name)).toEqual(["次の依頼.md"]);
	composer.remove(composer.attachments.map((attachment) => attachment.id));
});

it("keeps the current draft when file reading or validation fails", async () => {
	const key = `failure-${sequence++}`;
	render(key);
	await composer.addFiles([new File(["keep"], "保持.txt")]);
	render(key);
	failRead = true;
	await expect(composer.addFiles([new File(["broken"], "失敗.txt")])).rejects.toThrow("読み込めません");
	failRead = false;
	await expect(composer.addFiles([new File([new Uint8Array(ATTACHMENT_LIMITS.fileBytes + 1)], "大きい.bin")])).rejects.toThrow("10 MB");
	await expect(composer.addFiles(Array.from({ length: 10 }, () => new File([""], "empty.txt")))).rejects.toThrow("10ファイル");
	expect(render(key)).toContain("保持.txt");
	expect(composer.attachments.map((attachment) => attachment.name)).toEqual(["保持.txt"]);
	composer.remove(composer.attachments.map((attachment) => attachment.id));
});
