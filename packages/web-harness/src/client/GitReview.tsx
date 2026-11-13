import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api.ts";
import type { FileChangeSummary } from "./file-changes.ts";
import "./GitReview.css";

type Mode = "worktree" | "staged" | "branch" | "turn";
type Line = { text: string; old?: number; next?: number };
type Comment = { location: string; excerpt: string; text: string };

function diffLines(patch: string): Line[] {
	let old: number | undefined;
	let next: number | undefined;
	return patch.split("\n").map((text) => {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
		if (hunk) {
			old = Number(hunk[1]);
			next = Number(hunk[2]);
		} else if (old !== undefined && next !== undefined) {
			if (text.startsWith("+")) return { text, next: next++ };
			if (text.startsWith("-")) return { text, old: old++ };
			if (text.startsWith(" ")) return { text, old: old++, next: next++ };
		}
		return { text };
	});
}

function gitFiles(patches: string[]) {
	return patches.flatMap((patch) => patch.split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith("diff --git ")).map((chunk) => {
		const metadata = chunk.split(/^@@ /m, 1)[0];
		const header = /^\+\+\+ (.+)$/m.exec(metadata)?.[1];
		const original = /^--- (.+)$/m.exec(metadata)?.[1];
		const raw = header && header !== "/dev/null" ? header : original;
		return { path: raw?.replace(/\t$/, "").replace(/^([ab])\//, "") ?? /^rename to (.+)$/m.exec(metadata)?.[1] ?? chunk.split("\n", 1)[0].slice(11), patches: [chunk.replace(/\n$/, "")] };
	}));
}

export function GitReview({ sessionId, turn, onDraft, onClose }: {
	sessionId: string;
	turn: FileChangeSummary[];
	onDraft: (text: string) => void;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [mode, setMode] = useState<Mode>("worktree");
	const [base, setBase] = useState("");
	const [request, setRequest] = useState({ base: "", revision: 0 });
	const [files, setFiles] = useState<{ path: string; patches: string[] }[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [target, setTarget] = useState<Omit<Comment, "text">>();
	const [note, setNote] = useState("");
	const [comments, setComments] = useState<Comment[]>([]);
	useEffect(() => { dialog.current?.showModal(); }, []);
	useEffect(() => {
		if (mode === "turn") return;
		const controller = new AbortController();
		const query = new URLSearchParams({ mode, base: request.base });
		setLoading(true); setError(""); setFiles([]);
		void api<{ patches: string[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/git-review?${query}`, { signal: controller.signal })
			.then((result) => { if (!controller.signal.aborted) setFiles(gitFiles(result.patches)); })
			.catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [mode, request, sessionId]);
	const visible = mode === "turn" ? turn : files;
	const label = { worktree: "作業ツリー", staged: "ステージ", branch: "ブランチ", turn: "直近の応答" };
	return <dialog ref={dialog} className="git-review" aria-label="変更をレビュー" onCancel={onClose}>
		<header><strong>変更をレビュー</strong><button type="button" onClick={onClose}>閉じる</button></header>
		<div className="git-review-modes">{(Object.keys(label) as Mode[]).map((value) => <button type="button" key={value} aria-pressed={value === mode} onClick={() => { setMode(value); setTarget(undefined); }}>{label[value]}</button>)}</div>
		{mode !== "turn" && <form className="git-review-refresh" onSubmit={(event) => { event.preventDefault(); setTarget(undefined); setRequest({ base, revision: request.revision + 1 }); }}>
			{mode === "branch" && <input aria-label="比較先ブランチ" placeholder="比較先（既定: upstream）" value={base} onChange={(event) => setBase(event.target.value)} />}
			<button type="submit">{mode === "branch" ? "比較" : "更新"}</button>
		</form>}
		<div className="git-review-files">
			{mode !== "turn" && error && <p role="alert">{error}</p>}
			{mode !== "turn" && loading ? <p role="status">差分を読み込み中…</p> : !visible.length && (mode === "turn" || !error) ? <p>表示できる変更はありません。</p> : visible.map((file, index) => <ReviewFile key={`${mode}:${request.revision}:${file.path}:${index}`} file={file} onLine={(line) => {
				setTarget({ location: `${file.path}:${line.next ?? line.old}（${label[mode]}${line.next === undefined ? "・変更前" : ""}）`, excerpt: line.text.slice(0, 500) });
				setNote("");
			}} />)}
		</div>
		{target && <form className="git-review-comment" onSubmit={(event) => {
			event.preventDefault();
			if (!note.trim()) return;
			setComments([...comments, { ...target, text: note.trim() }]); setTarget(undefined);
		}}>
			<label>{target.location}<textarea autoFocus required maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="この行へのコメント" /></label>
			<button type="button" onClick={() => setTarget(undefined)}>キャンセル</button><button type="submit">コメントを追加</button>
		</form>}
		{comments.length > 0 && <ol className="git-review-comments">{comments.map((comment, index) => <li key={index}><strong>{comment.location}</strong><span>{comment.text}</span><button type="button" onClick={() => setComments(comments.filter((_, item) => index !== item))}>削除</button></li>)}</ol>}
		<footer><span>行番号を選ぶとコメントできます</span><button type="button" disabled={!comments.length || !!target} onClick={() => onDraft(`差分へのコメント:\n\n${comments.map((comment) => `- ${comment.location}\n  対象行: ${comment.excerpt}\n  コメント: ${comment.text}`).join("\n\n")}`)}>入力欄に追加（{comments.length}）</button></footer>
	</dialog>;
}

function ReviewFile({ file, onLine }: { file: { path: string; patches: string[] }; onLine: (line: Line) => void }) {
	const [open, setOpen] = useState(false);
	return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
		<summary>{file.path}</summary>
		{open && <div className="git-review-lines">{file.patches.map((patch, index) => <div key={index}>{diffLines(patch).map((line, row) => <div key={row} data-kind={line.text[0] === "+" && line.next !== undefined ? "add" : line.text[0] === "-" && line.old !== undefined ? "remove" : undefined}>
			{line.next !== undefined || line.old !== undefined ? <button type="button" onClick={() => onLine(line)} aria-label={`${line.next ?? line.old}行にコメント`}>{line.old ?? ""}{" "}{line.next ?? ""}</button> : <span />}
			<code>{line.text}</code>
		</div>)}</div>)}</div>}
	</details>;
}
