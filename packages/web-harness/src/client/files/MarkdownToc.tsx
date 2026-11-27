import { useEffect, useRef } from "react";
import "./MarkdownToc.css";

export interface MarkdownHeading {
	index: number;
	depth: 1 | 2 | 3 | 4;
	text: string;
	element: HTMLElement;
}

/** Picks the heading whose top has most recently scrolled past the reading threshold. */
export function activeHeadingIndex(relativeTops: readonly number[], threshold = 64): number {
	let active = 0;
	for (let index = 0; index < relativeTops.length; index++) {
		if (relativeTops[index] <= threshold) active = index;
		else break;
	}
	return active;
}

export function MarkdownToc({
	headings,
	activeIndex,
	floating,
	onSelect,
}: {
	headings: readonly MarkdownHeading[];
	activeIndex: number;
	floating: boolean;
	onSelect: (heading: MarkdownHeading) => void;
}) {
	const navRef = useRef<HTMLElement>(null);
	useEffect(() => {
		const activeButton = navRef.current?.querySelector<HTMLElement>('[aria-current="location"]');
		activeButton?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);
	if (headings.length < 2) return null;
	return (
		<nav ref={navRef} className={`markdown-toc${floating ? " is-floating" : ""}`} aria-label="目次">
			<div className="markdown-toc-title">目次</div>
			<ol>
				{headings.map((heading) => (
					<li key={heading.index} data-depth={heading.depth}>
						<button
							type="button"
							aria-current={heading.index === activeIndex ? "location" : undefined}
							title={heading.text}
							onClick={() => onSelect(heading)}
						>
							<span>{heading.text}</span>
						</button>
					</li>
				))}
			</ol>
		</nav>
	);
}
