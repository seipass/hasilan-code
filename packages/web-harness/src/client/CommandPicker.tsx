import { useLayoutEffect, useRef } from "react";
import type { COMPOSER_COMMANDS } from "./slash-command.ts";
import "./CommandPicker.css";

const PRESENTATION: Record<string, { title: string; detail: string; category: string; path: string }> = {
	"/hyakki": { title: "百鬼夜行", detail: "親AIに依頼して、チームで並行して進める", category: "チーム", path: "M12 8V4m0 4H5v5m7-5h7v5M2 14h6v6H2zm14 0h6v6h-6zM9 1h6v6H9z" },
	"/canvas": { title: "設計キャンバス", detail: "アイデアを並べて、つないで、AIに渡す", category: "設計", path: "M3 3h7v7H3zm11 11h7v7h-7zM7 10v7h7m0-10h7m-3-3 3 3-3 3" },
	"/goal": { title: "Goal", detail: "目標を伝えて、達成まで継続して進める", category: "自律実行", path: "M5 22V3m0 1c5-5 9 5 15 0v11c-6 5-10-5-15 0" },
	"/chat": { title: "会話に戻る", detail: "いつものチャットでAIと話す", category: "会話", path: "M21 15a3 3 0 0 1-3 3H8l-5 4V5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3zM7 7h10M7 12h7" },
};

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
				const presentation = PRESENTATION[entry.command];
				return <button id={`${id}-${index}`} key={entry.command} type="button" role="option" aria-selected={index === activeIndex} tabIndex={-1} className={`command-picker-option command-${entry.command.slice(1)}`} onPointerMove={() => onActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(entry.command)}>
					<span className="command-picker-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={presentation.path} /></svg></span>
					<span className="command-picker-copy"><span className="command-picker-title">{presentation.title}<code>{entry.command}</code></span><span className="command-picker-description">{presentation.detail}</span></span>
					<span className="command-picker-category">{presentation.category}</span><span className="command-picker-enter" aria-hidden="true">↵</span>
				</button>;
			})}
			{commands.length === 0 && <div className="command-picker-empty"><strong>コマンドが見つかりません</strong><span>入力を消して / から選び直してください。</span></div>}
		</div>
		<div className="command-picker-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 選択 <kbd>Enter</kbd> 入力</span><span><kbd>Esc</kbd> 閉じる</span></div>
	</div>;
}
