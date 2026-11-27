import { useEffect, useRef } from "react";
import { Icon } from "./Icon.tsx";
import "./ConversationFindBar.css";

export function ConversationFindBar({
	query,
	total,
	activeIndex,
	focusToken,
	onQueryChange,
	onNext,
	onPrev,
	onClose,
}: {
	query: string;
	total: number;
	activeIndex: number;
	focusToken: number;
	onQueryChange: (value: string) => void;
	onNext: () => void;
	onPrev: () => void;
	onClose: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const element = inputRef.current;
		if (!element) return;
		element.focus();
		element.select();
	}, [focusToken]);
	const hasQuery = query.trim().length > 0;
	const countText = !hasQuery ? "" : total > 0 ? `${activeIndex + 1} / ${total}` : "0件";
	return (
		<div className="conversation-find-bar" role="search" aria-label="会話内検索">
			<Icon name="search" size="inline" className="conversation-find-icon" />
			<input
				ref={inputRef}
				type="search"
				className="conversation-find-input"
				aria-label="会話内を検索"
				placeholder="会話内を検索…"
				value={query}
				onChange={(event) => onQueryChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) return;
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onClose();
						return;
					}
					if (event.key === "Enter") {
						event.preventDefault();
						if (event.shiftKey) onPrev();
						else onNext();
					}
				}}
			/>
			{countText && (
				<span className={`conversation-find-count${total === 0 ? " is-empty" : ""}`} aria-live="polite">
					{countText}
				</span>
			)}
			<div className="conversation-find-actions">
				<button
					type="button"
					className="conversation-find-btn"
					aria-label="前の候補"
					title="前の候補（Shift + Enter）"
					disabled={total === 0}
					onClick={onPrev}
				>
					<Icon name="chevronUp" size="inline" />
				</button>
				<button
					type="button"
					className="conversation-find-btn"
					aria-label="次の候補"
					title="次の候補（Enter）"
					disabled={total === 0}
					onClick={onNext}
				>
					<Icon name="chevronDown" size="inline" />
				</button>
				<button
					type="button"
					className="conversation-find-btn"
					aria-label="検索を閉じる"
					title="閉じる（Esc）"
					onClick={onClose}
				>
					<Icon name="close" size="inline" />
				</button>
			</div>
		</div>
	);
}
