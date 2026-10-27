import { useLayoutEffect, useRef } from "react";
import { MotionItems, Presence, useLayoutMotion } from "./Motion.tsx";
import type { COMPOSER_COMMANDS } from "./slash-command.ts";
import "./CommandPicker.css";

export function CommandPicker({ id, commands, activeIndex, onActive, onChoose }: {
	id: string;
	commands: readonly (typeof COMPOSER_COMMANDS)[number][];
	activeIndex: number;
	onActive: (index: number) => void;
	onChoose: (command: string) => void;
}) {
	const panel = useRef<HTMLDivElement>(null);
	useLayoutMotion(panel, commands, true, true);
	useLayoutEffect(() => {
		const element = panel.current;
		const anchor = element?.closest<HTMLElement>(".command-picker-anchor");
		if (!element || !anchor) return;
		const updateAvailableHeight = () => {
			element.style.setProperty("--command-picker-available-height", `${Math.max(0, anchor.getBoundingClientRect().top - 20)}px`);
		};
		updateAvailableHeight();
		const observer = new ResizeObserver(updateAvailableHeight);
		observer.observe(anchor);
		window.addEventListener("resize", updateAvailableHeight);
		document.addEventListener("scroll", updateAvailableHeight, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", updateAvailableHeight);
			document.removeEventListener("scroll", updateAvailableHeight, true);
		};
	}, []);
	return <div ref={panel} className="command-picker">
		<div id={id} role="listbox" aria-label="スラッシュコマンド" className="command-picker-options">
			<MotionItems items={commands} itemKey={(entry) => entry.command}>{(entry) => {
				const index = commands.indexOf(entry);
				return <button id={index >= 0 ? `${id}-${index}` : undefined} key={entry.command} type="button" role="option" aria-selected={index === activeIndex} tabIndex={-1} className={`command-picker-option command-${entry.command.slice(1)}`} onPointerMove={() => { if (index >= 0) onActive(index); }} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(entry.command)}>
					<span className="command-picker-copy"><code className="command-picker-title">{entry.command}</code><span className="command-picker-description">{entry.description}</span></span>
					<span className="command-picker-enter" aria-hidden="true">↵</span>
				</button>;
			}}</MotionItems>
			<Presence show={commands.length === 0}><div className="command-picker-empty"><strong>コマンドが見つかりません</strong><span>入力を消して / から選び直してください。</span></div></Presence>
		</div>
	</div>;
}
