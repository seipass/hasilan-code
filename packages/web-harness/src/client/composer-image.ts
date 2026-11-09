/** Animated images keep their original source so the attachment preview keeps moving. */
export function canResizeAttachment(mimeType: string, bytes: Uint8Array): boolean {
	if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
	if (mimeType === "image/webp") {
		if (
			bytes.length < 21 ||
			String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
			String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP"
		)
			return false;
		const kind = String.fromCharCode(...bytes.subarray(12, 16));
		return kind === "VP8 " || kind === "VP8L" || (kind === "VP8X" && (bytes[20] & 2) === 0);
	}
	if (
		mimeType !== "image/png" ||
		bytes.length < 8 ||
		![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
	)
		return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset);
		const next = offset + 12 + length;
		if (next > bytes.length) return false;
		const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		if (kind === "acTL") return false;
		if (kind === "IDAT") return true;
		offset = next;
	}
	return false;
}
