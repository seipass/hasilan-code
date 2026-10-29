import { useId, useState } from "react";
import { type ComputerActivityGroup, computerAction, computerDetails, computerFrames, computerPointer } from "./computer-activity.ts";
import { ToolCard } from "./ToolInspector.tsx";
import { mediaReady, Presence } from "./Motion.tsx";
import "./ComputerActivity.css";

export function ComputerActivity({ group, onFile }: { group: ComputerActivityGroup; onFile: (path: string, line?: number) => void }) {
	const [selectedKey, setSelectedKey] = useState<string>();
	const [showCalls, setShowCalls] = useState(false);
	const [failedImage, setFailedImage] = useState<string>();
	const id = useId();
	const frames = computerFrames(group.tools);
	const selectedIndex = selectedKey ? frames.findIndex((frame) => frame.tool.key === selectedKey) : -1;
	const browsing = selectedIndex >= 0;
	const index = browsing ? selectedIndex : frames.length - 1;
	const frame = frames[index];
	const latest = group.tools.at(-1)!;
	const operation = frame && (browsing || latest.name === "jev_computer") ? frame.tool : latest;
	const failed = latest.status === "error" || latest.status === "cancelled" || latest.status === "incomplete";
	const jevDetails = latest.name === "jev_computer" ? computerDetails(latest) : undefined;
	const state = browsing ? "履歴を表示中" : failed ? latest.status === "cancelled" ? "停止" : "操作エラー" : jevDetails?.stale ? "画面の再取得が必要" : jevDetails?.outcome === "handoff" ? "主AIに引き継ぎ" : group.released ? "操作終了" : group.live ? "AIが操作中" : "終了";
	const pointer = frame ? computerPointer(operation, frames) : undefined;
	const pending = latest.status === "running";
	return <section className="computer-activity" aria-label="AIのデスクトップ操作" data-live={group.live}>
		<header className="computer-activity-header"><div><strong>{latest.name === "jev_computer" ? "判断モデル Computer use" : "Computer use"}</strong><span key={state} className="computer-activity-state motion-label" data-error={failed} role="status">{state}</span></div>
			{frame && <a href={frame.url} target="_blank" rel="noopener noreferrer" aria-label="画面を大きく開く" title="画面を大きく開く"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></svg></a>}
		</header>
		<div className="computer-activity-screen">
			{frame && failedImage !== frame.url ? <div className="computer-activity-image" style={{ aspectRatio: `${frame.width} / ${frame.height}`, maxWidth: `${480 * frame.width / frame.height}px` }}>
				<img src={frame.url} alt={`AIが操作する画面${frame.monitor ?? ""}`} onLoad={(event) => mediaReady(event.currentTarget)} onError={() => setFailedImage(frame.url)} />
				{pointer && <svg className="computer-activity-pointer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" data-pending={pending}>
					{pointer.toX !== undefined && pointer.toY !== undefined && <><line x1={pointer.x} y1={pointer.y} x2={pointer.toX} y2={pointer.toY} /><circle cx={pointer.x} cy={pointer.y} r="1" /></>}
				</svg>}
				{pointer && <span key={operation.key} className="computer-activity-cursor" data-pending={pending} style={{ left: `${pointer.toX ?? pointer.x}%`, top: `${pointer.toY ?? pointer.y}%` }} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4 3 5 17 3-6 7-2z" /></svg></span>}
			</div> : <div className="computer-activity-placeholder" role="status">{frame ? "画面を読み込めません。呼び出し履歴から結果を確認できます。" : failed ? "画面を取得できませんでした。" : group.live ? "画面を取得しています…" : "この履歴の範囲に画面はありません。"}</div>}
		</div>
		<div className="computer-activity-operation" aria-live="polite"><span key={operation.key} className="motion-label" data-error={failed}>{computerAction(operation)}{pending ? "…" : ""}</span>{frame?.monitor !== undefined && <small>画面 {frame.monitor}</small>}</div>
		<Presence show={!!frame && frames.length > 1} collapse>{frame && <div className="computer-activity-history"><input type="range" min={0} max={frames.length - 1} step={1} value={index} aria-label="操作の履歴" aria-valuetext={`${index + 1} / ${frames.length}: ${computerAction(frame.tool)}`} onChange={(event) => { setSelectedKey(frames[Number(event.currentTarget.value)]?.tool.key); }} /><span>{index + 1} / {frames.length}</span><button type="button" disabled={!browsing} onClick={() => setSelectedKey(undefined)}>{group.live ? "最新に戻る" : "最後の画面"}</button></div>}</Presence>
		<details className="computer-activity-calls" onToggle={(event) => setShowCalls(event.currentTarget.open)}><summary aria-controls={`${id}-calls`}>呼び出し履歴 · {group.tools.length}</summary><Presence show={showCalls}><div id={`${id}-calls`}>{showCalls && group.tools.map((tool) => <ToolCard key={tool.key} tool={tool} onFile={onFile} />)}</div></Presence></details>
	</section>;
}
