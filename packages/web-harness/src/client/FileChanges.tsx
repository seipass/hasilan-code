import type { FileChangeSummary } from "./file-changes.ts";
import "./FileChanges.css";

export function FileChanges({ files }: { files: FileChangeSummary[] }) {
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	return <details className="file-changes" open>
		<summary><strong>{files.length}件のファイルを編集</strong><span className="file-changes-count"><span>+{added}</span> <span>−{removed}</span>{files.some((file) => file.truncated) && " 以上"}</span></summary>
		<div className="file-changes-list">{files.map((file) => <details className="file-changes-file" key={file.path}>
			<summary><span title={file.path}>{file.path}</span><span className="file-changes-count"><span>+{file.added}</span> <span>−{file.removed}</span>{file.truncated && " 以上"}</span><span className="file-changes-view">変更内容を表示</span></summary>
			<div className="file-changes-patches">{file.patches.map((patch, index) => <pre key={index}>{patch.split("\n").map((line, lineIndex) => <span key={lineIndex} data-kind={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : undefined}>{line}{"\n"}</span>)}</pre>)}</div>
		</details>)}</div>
		<p>編集・作成ツールに記録された変更</p>
	</details>;
}
