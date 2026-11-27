import type { FileChangeSummary } from "./file-changes.ts";
import { FileIcon } from "./files/FileIcon.tsx";
import { Icon } from "./Icon.tsx";
import "./FileChanges.css";

function fileBasename(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function fileDirname(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const slash = normalized.lastIndexOf("/");
	return slash > 0 ? normalized.slice(0, slash) : "";
}

export function FileChanges({ files, onFile }: { files: FileChangeSummary[]; onFile?: (path: string) => void }) {
	const added = files.reduce((sum, file) => sum + file.added, 0);
	const removed = files.reduce((sum, file) => sum + file.removed, 0);
	const previewNames = files.slice(0, 2).map((file) => fileBasename(file.path)).join(", ");
	const extraCount = files.length > 2 ? ` +${files.length - 2}` : "";
	return <details className="file-changes">
		<summary>
			<Icon name="pencil" size="inline" className="file-changes-icon" />
			<span className="file-changes-heading">{files.length}件のファイルを変更</span>
			<span className="file-changes-preview" title={files.map((file) => file.path).join("\n")}>{previewNames}{extraCount}</span>
			<span className="file-changes-count"><span>+{added}</span> <span>−{removed}</span>{files.some((file) => file.truncated) && "+"}</span>
			<Icon name="chevronRight" size="inline" className="file-changes-chevron" />
		</summary>
		<div className="file-changes-list">{files.map((file) => {
			const name = fileBasename(file.path);
			const dir = fileDirname(file.path);
			return <details className="file-changes-file" key={file.path}>
				<summary>
					<FileIcon name={name} />
					<span className="file-changes-file-copy" title={file.path}>
						<span className="file-changes-file-name">{name}</span>
						{dir && <span className="file-changes-file-dir">{dir}</span>}
					</span>
					<span className="file-changes-count"><span>+{file.added}</span> <span>−{file.removed}</span>{file.truncated && "+"}</span>
					{onFile && <button type="button" className="file-changes-open" aria-label={`${file.path} を開く`} title="エディタで開く" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onFile(file.path); }}>
						<Icon name="arrowUpRight" size="inline" />
					</button>}
					<Icon name="chevronRight" size="inline" className="file-changes-chevron" />
				</summary>
				<div className="file-changes-patches">{file.patches.map((patch, index) => <pre key={index}>{patch.split("\n").map((line, lineIndex) => <span key={lineIndex} data-kind={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : undefined}>{line}{"\n"}</span>)}</pre>)}</div>
			</details>;
		})}</div>
	</details>;
}
