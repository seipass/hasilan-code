import { TextDecoder } from "node:util";
import { Type } from "typebox";
import { HttpError } from "./http-host.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";

const MAX_BYTES = 2 * 1024 * 1024;
export const fileEditSchema = Type.Object(
	{ revision: Type.String({ minLength: 64, maxLength: 64 }), text: Type.String({ maxLength: MAX_BYTES }) },
	{ additionalProperties: false },
);

export async function readEditableFile(files: WorkspaceFiles, workspaceId: string, path: string) {
	const snapshot = await files.read(workspaceId, path);
	if (snapshot.bytes.length > MAX_BYTES) throw new HttpError(413, "2 MB を超えるファイルは編集できません。");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.bytes);
	} catch {
		throw new HttpError(415, "UTF-8 のテキストファイルだけ編集できます。");
	}
	if (text.includes("\0")) throw new HttpError(415, "バイナリファイルは編集できません。");
	return { text, revision: snapshot.revision };
}

export async function saveEditableFile(
	files: WorkspaceFiles,
	workspaceId: string,
	path: string,
	revision: string,
	text: string,
) {
	const afterBytes = Buffer.from(text, "utf8");
	if (afterBytes.length > MAX_BYTES || text.includes("\0"))
		throw new HttpError(400, "テキストは 2 MB 以下にしてください。");
	const snapshot = await files.read(workspaceId, path);
	if (snapshot.revision !== revision)
		throw new HttpError(409, "ファイルが外部で変更されました。内容を確認してください。");
	const result = await files.commit(workspaceId, [
		{ path, expectedRevision: revision, beforeBytes: snapshot.bytes, afterBytes, operation: "update" },
	]);
	const file = result.files[0];
	if (file.status !== "applied" || !file.revision)
		throw new HttpError(409, "保存できませんでした。ファイルの外部変更を確認してください。");
	return { revision: file.revision };
}
