import { useEffect, useState } from "react";
import type { DraftAttachment } from "../shared/attachments.ts";
import { canResizeAttachment } from "./composer-image.ts";

export function ComposerAttachmentImage({ attachment }: { attachment: DraftAttachment }) {
	const original = `data:${attachment.mimeType};base64,${attachment.data}`;
	const supported = typeof window !== "undefined" && typeof createImageBitmap === "function";
	const [source, setSource] = useState<string | undefined>(() => supported ? undefined : original);
	useEffect(() => {
		if (!supported) { setSource(original); return; }
		let active = true;
		setSource(undefined);
		void (async () => {
			const decoded = atob(attachment.data);
			const bytes = new Uint8Array(decoded.length);
			for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
			if (!canResizeAttachment(attachment.mimeType, bytes)) return original;
			const blob = new Blob([bytes], { type: attachment.mimeType });
			const bitmap = await createImageBitmap(blob, { resizeWidth: 128, resizeQuality: "high" });
			try {
				if (bitmap.height > 2048) return original;
				const canvas = document.createElement("canvas");
				canvas.width = bitmap.width; canvas.height = bitmap.height;
				const context = canvas.getContext("2d");
				if (!context) return original;
				context.drawImage(bitmap, 0, 0);
				return canvas.toDataURL("image/png");
			} finally { bitmap.close(); }
		})().catch(() => original).then((result) => { if (active) setSource(result); });
		return () => { active = false; };
	}, [attachment.data, attachment.mimeType, original, supported]);
	return source ? <img src={source} alt={attachment.name} /> : <span className="composer-attachment-icon" aria-hidden="true" />;
}
