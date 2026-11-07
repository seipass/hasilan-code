import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cacheReadPercent, type ModelUsage } from "../shared/usage.ts";
import { MotionItems, Presence } from "./Motion.tsx";
import { MotionSize } from "./MotionSwap.tsx";
import { Icon } from "./Icon.tsx";
import "./UsagePanel.css";

const tokens = new Intl.NumberFormat("ja-JP");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });

export function UsagePanel({ title, groups, trigger }: {
	title: string;
	groups: { id: string; label: string; usage?: ModelUsage[] }[];
	trigger?: ReactNode;
}) {
	const root = useRef<HTMLDivElement>(null);
	const popover = useRef<HTMLDivElement>(null);
	const popoverId = useId();
	const isPopover = trigger !== undefined;
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<{ left: number; bottom: number; maxHeight: number }>();
	useLayoutEffect(() => {
		if (!isPopover || !open) return;
		const button = root.current?.querySelector<HTMLButtonElement>(".usage-popover-trigger");
		if (!button) return;
		function updatePosition() {
			const bounds = button!.getBoundingClientRect();
			const width = Math.min(520, window.innerWidth - 32);
			setPosition({
				left: Math.max(16, Math.min(bounds.right - width, window.innerWidth - width - 16)),
				bottom: window.innerHeight - bounds.top + 10,
				maxHeight: Math.max(0, Math.min(560, window.innerHeight * 0.65, bounds.top - 26)),
			});
		}
		updatePosition();
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [isPopover, open]);
	const total = { input: 0, cacheRead: 0, cacheWrite: 0, cost: 0, responses: 0, failures: 0, auxiliary: 0 };
	let unpriced = false;
	for (const group of groups) for (const usage of group.usage ?? []) {
		total.input += usage.input;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.responses += usage.responses;
		total.failures += usage.failures;
		total.auxiliary += usage.auxiliary;
		if (usage.provider === "devin") unpriced = true;
	}
	const percent = cacheReadPercent(total);
	const rows = groups.flatMap((group) => (group.usage ?? []).map((usage) => ({ id: JSON.stringify([group.id, usage.provider, usage.model]), label: group.label, usage })));
	useEffect(() => {
		if (!isPopover || !open) return;
		function onPointerDown(event: PointerEvent) {
			if (!root.current?.contains(event.target as Node | null) && !popover.current?.contains(event.target as Node | null)) setOpen(false);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			setOpen(false);
			root.current?.querySelector<HTMLButtonElement>(".usage-popover-trigger")?.focus();
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [isPopover, open]);
	const body = <MotionSize>
		<p className="usage-summary">{tokens.format(total.responses)}応答{total.failures > 0 && ` · 失敗・中止 ${tokens.format(total.failures)}件`}{total.auxiliary > 0 && ` · 補助処理 ${tokens.format(total.auxiliary)}記録`}</p>
		{isPopover && rows.length > 0 && <dl className="usage-totals">
			<div><dt>概算費用</dt><dd>{money.format(total.cost)}</dd>{unpriced && <small>一部未計測</small>}</div>
			<div><dt>キャッシュヒット率</dt><dd>{percent === null ? "—" : `${percent.toFixed(1)}%`}</dd><progress max={100} value={percent ?? 0} aria-label="キャッシュヒット率" /></div>
		</dl>}
		{isPopover && rows.length > 0 && <div className="usage-model-list" aria-label="モデル別の使用量">{rows.map(({ id, label, usage }) => {
			const hit = cacheReadPercent(usage);
			return <details className="usage-model" key={id}><summary><span className="usage-model-identity"><strong title={usage.model}>{usage.model.split("/").at(-1) || "補助処理"}</strong><span>{label}{usage.provider && ` · ${usage.provider}`}</span></span><span className="usage-model-cost">{usage.provider === "devin" ? "未計測" : money.format(usage.cost)}</span><Icon name="chevronRight" size="inline" /></summary><dl className="usage-model-metrics">
				<div><dt>未キャッシュ入力</dt><dd>{tokens.format(usage.input)}</dd></div><div><dt>キャッシュ読取</dt><dd>{tokens.format(usage.cacheRead)}</dd></div><div><dt>キャッシュ書込</dt><dd>{tokens.format(usage.cacheWrite)}</dd></div><div><dt>出力</dt><dd>{tokens.format(usage.output)}</dd></div><div><dt>ヒット率</dt><dd>{hit === null ? "—" : `${hit.toFixed(1)}%`}</dd></div><div><dt>応答</dt><dd>{tokens.format(usage.responses)}</dd></div>
			</dl><p className="usage-model-id">{usage.model}</p></details>;
		})}</div>}
		<div className="usage-data-slot"><Presence show={!isPopover && rows.length > 0}><div className="usage-table-scroll" tabIndex={0} role="region" aria-label={`${title}のモデル別集計`}>
			<table><thead><tr><th scope="col">担当</th><th scope="col">モデル</th><th scope="col">ヒット率</th><th scope="col">未キャッシュ入力</th><th scope="col">読取</th><th scope="col">書込</th><th scope="col">出力</th><th scope="col">概算USD</th></tr></thead>
				<tbody><MotionItems items={rows} itemKey={(row) => row.id}>{({ id, label, usage }) => {
					const hit = cacheReadPercent(usage);
					return <tr key={id}><th scope="row">{label}</th><td>{usage.provider && <span className="usage-provider">{usage.provider} / </span>}{usage.model}</td><td>{hit === null ? "—" : `${hit.toFixed(1)}%`}</td><td>{tokens.format(usage.input)}</td><td>{tokens.format(usage.cacheRead)}</td><td>{tokens.format(usage.cacheWrite)}</td><td>{tokens.format(usage.output)}</td><td>{usage.provider === "devin" ? "未計測" : money.format(usage.cost)}</td></tr>;
				}}</MotionItems></tbody>
			</table>
		</div></Presence><Presence show={rows.length === 0}><p>モデルの使用量はまだ記録されていません。</p></Presence></div>
	</MotionSize>;
	if (trigger !== undefined) return <div className="usage-panel usage-popover" ref={root}>
		<button type="button" className="usage-popover-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={popoverId} onClick={() => setOpen((value) => !value)}>{trigger}</button>
		{typeof document !== "undefined" && createPortal(<div ref={popover} className="usage-popover-content" id={popoverId} role="dialog" aria-label={title} style={position} hidden={!open} inert={!open}>
			<header className="usage-popover-header"><strong>{title}</strong><button type="button" aria-label={`${title}を閉じる`} title="閉じる" onClick={() => { setOpen(false); root.current?.querySelector<HTMLButtonElement>(".usage-popover-trigger")?.focus(); }}><Icon name="close" size="control" /></button></header>
			<div className="usage-panel-body">{body}</div>
		</div>, document.body)}
	</div>;
	return <details className="usage-panel">
		<summary><span>{title}</span><span>キャッシュ {percent === null ? "—" : `${percent.toFixed(1)}%`} · {!unpriced && (total.responses || total.auxiliary) ? money.format(total.cost) : "未計測"}</span></summary>
		<div className="usage-panel-body">{body}</div>
	</details>;
}
