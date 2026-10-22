import { useLayoutEffect, useRef } from "react";
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
	useLayoutEffect(() => {
		const element = panel.current;
		const anchor = element?.parentElement;
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
		<div className="command-picker-heading"><span>何を始めますか？</span><span className="command-picker-label">コマンド</span></div>
		<div id={id} role="listbox" aria-label="スラッシュコマンド" className="command-picker-options">
			{commands.map((entry, index) => {
				return <button id={`${id}-${index}`} key={entry.command} type="button" role="option" aria-selected={index === activeIndex} tabIndex={-1} className={`command-picker-option command-${entry.command.slice(1)}`} onPointerMove={() => onActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(entry.command)}>
					<span className="command-picker-copy"><code className="command-picker-title">{entry.command}</code><span className="command-picker-description">{entry.description}</span></span>
					<span className="command-picker-enter" aria-hidden="true">↵</span>
				</button>;
			})}
			{commands.length === 0 && <div className="command-picker-empty"><strong>コマンドが見つかりません</strong><span>入力を消して / から選び直してください。</span></div>}
		</div>
		<div className="command-picker-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 選択 <kbd>Enter</kbd> 入力</span><span><kbd>Esc</kbd> 閉じる</span></div>
	</div>;
}
