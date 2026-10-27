export interface HomeBackground {
	image: string;
	name: string;
}

export const HOME_BACKGROUND_KEY = "hasilan-home-background";
const MAX_IMAGE_LENGTH = 1_400_000;

export function parseHomeBackground(stored: string | null): HomeBackground | undefined {
	if (!stored || stored.length > MAX_IMAGE_LENGTH + 1024) return undefined;
	try {
		const value: unknown = JSON.parse(stored);
		if (
			!value ||
			typeof value !== "object" ||
			!("image" in value) ||
			!("name" in value) ||
			typeof value.image !== "string" ||
			typeof value.name !== "string" ||
			value.image.length > MAX_IMAGE_LENGTH ||
			!/^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(value.image)
		)
			return undefined;
		return { image: value.image, name: value.name.slice(0, 200) };
	} catch {
		return undefined;
	}
}

export function readHomeBackground(storage?: Pick<Storage, "getItem">): HomeBackground | undefined {
	try {
		return parseHomeBackground((storage ?? localStorage).getItem(HOME_BACKGROUND_KEY));
	} catch {
		return undefined;
	}
}

export function saveHomeBackground(
	background: HomeBackground | undefined,
	storage?: Pick<Storage, "setItem" | "removeItem">,
): void {
	try {
		const target = storage ?? localStorage;
		if (background) target.setItem(HOME_BACKGROUND_KEY, JSON.stringify(background));
		else target.removeItem(HOME_BACKGROUND_KEY);
	} catch {
		throw new Error("背景を保存できませんでした。ブラウザーの保存容量や設定を確認してください。");
	}
}

/** Store a bounded raster image so large originals do not fill browser storage. */
export async function prepareHomeBackground(file: File): Promise<HomeBackground> {
	if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("20 MB 以下の画像を選択してください。");
	if (file.type && !file.type.startsWith("image/")) throw new Error("画像ファイルを選択してください。");
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		throw new Error("画像を読み込めませんでした。別の画像を選択してください。");
	}
	try {
		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");
		if (!context || !bitmap.width || !bitmap.height) throw new Error("画像を読み込めませんでした。");
		for (const maximum of [1920, 1440, 1080, 810]) {
			const scale = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const image = canvas.toDataURL("image/webp", 0.85);
			if (image.length <= MAX_IMAGE_LENGTH && image.startsWith("data:image/"))
				return { image, name: file.name.slice(0, 200) || "背景画像" };
		}
		throw new Error("画像を保存できるサイズに縮小できませんでした。別の画像を選択してください。");
	} finally {
		bitmap.close();
	}
}
