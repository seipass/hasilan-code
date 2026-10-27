import { useLayoutEffect, useRef } from "react";
import { MotionItems, Presence, useLayoutMotion } from "./Motion.tsx";
import "./CommandPicker.css";

export function CommandPicker({ id, commands, activeIndex, onActive, onChoose, below = false, label = "スラッシュコマンド", disabled = false }: {
	id: string;
	commands: readonly { command: string; description: string; label?: string }[];
	activeIndex: number;
	onActive: (index: number) => void;
	onChoose: (command: string) => void;
	below?: boolean;
	label?: string;
	disabled?: boolean;
}) {
	const panel = useRef<HTMLDivElement>(null);
	useLayoutMotion(panel, commands, true, true);
	useLayoutEffect(() => {
		const element = panel.current;
		const anchor = element?.closest<HTMLElement>(".command-picker-anchor");
		if (!element || !anchor) return;
		const updateAvailableHeight = () => {
			const bounds = anchor.getBoundingClientRect();
			const viewport = window.visualViewport;
			const top = viewport?.offsetTop ?? 0;
			const bottom = top + (viewport?.height ?? window.innerHeight);
			element.style.setProperty("--command-picker-available-height", `${Math.max(0, (below ? bottom - bounds.bottom : bounds.top - top) - 20)}px`);
		};
		updateAvailableHeight();
		const observer = new ResizeObserver(updateAvailableHeight);
		observer.observe(anchor);
		window.addEventListener("resize", updateAvailableHeight);
		window.visualViewport?.addEventListener("resize", updateAvailableHeight);
		window.visualViewport?.addEventListener("scroll", updateAvailableHeight);
		document.addEventListener("scroll", updateAvailableHeight, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", updateAvailableHeight);
			window.visualViewport?.removeEventListener("resize", updateAvailableHeight);
			window.visualViewport?.removeEventListener("scroll", updateAvailableHeight);
			document.removeEventListener("scroll", updateAvailableHeight, true);
		};
	}, [below]);
	useLayoutEffect(() => {
		const list = panel.current?.querySelector<HTMLElement>(".command-picker-options");
		const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
		if (!list || !active) return;
		const bounds = list.getBoundingClientRect();
		const option = active.getBoundingClientRect();
		if (option.bottom > bounds.bottom) list.scrollTop += option.bottom - bounds.bottom;
		else if (option.top < bounds.top) list.scrollTop -= bounds.top - option.top;
	}, [activeIndex]);
	return <div ref={panel} className={`command-picker${below ? " is-below" : ""}`}>
		<div id={id} role="listbox" aria-label={label} aria-busy={disabled} className="command-picker-options">
			<MotionItems items={commands} itemKey={(entry) => entry.command}>{(entry) => {
				const index = commands.indexOf(entry);
				return <button id={index >= 0 ? `${id}-${index}` : undefined} key={entry.command} type="button" role="option" aria-selected={index === activeIndex} disabled={disabled} tabIndex={-1} className={`command-picker-option${entry.command.startsWith("/") ? ` command-${entry.command.slice(1)}` : ""}`} onPointerMove={() => { if (!disabled && index >= 0) onActive(index); }} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(entry.command)}>
					<span className="command-picker-copy">{entry.label ? <span className="command-picker-title">{entry.label}</span> : <code className="command-picker-title">{entry.command}</code>}<span className="command-picker-description" title={entry.description}>{entry.description}</span></span>
					<span className="command-picker-enter" aria-hidden="true">↵</span>
				</button>;
			}}</MotionItems>
			<Presence show={commands.length === 0}><div className="command-picker-empty"><strong>コマンドが見つかりません</strong><span>入力を消して / から選び直してください。</span></div></Presence>
		</div>
	</div>;
}
