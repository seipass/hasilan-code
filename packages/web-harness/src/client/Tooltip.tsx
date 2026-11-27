import {
	cloneElement,
	type FocusEvent,
	type PointerEvent,
	type ReactElement,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import "./Tooltip.css";

interface TriggerProps {
	onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
	onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
	onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
	onFocus?: (event: FocusEvent<HTMLElement>) => void;
	onBlur?: (event: FocusEvent<HTMLElement>) => void;
	"aria-describedby"?: string;
}

const isMacPlatform =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

export function formatShortcut(shortcut: string): string[] {
	return shortcut
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const lower = part.toLowerCase();
			if (lower === "mod") return isMacPlatform ? "⌘" : "Ctrl";
			if (lower === "ctrl") return "Ctrl";
			if (lower === "meta" || lower === "cmd") return "⌘";
			if (lower === "shift") return isMacPlatform ? "⇧" : "Shift";
			if (lower === "alt") return isMacPlatform ? "⌥" : "Alt";
			if (lower === "enter") return "↵";
			if (lower === "esc" || lower === "escape") return "Esc";
			return part.length === 1 ? part.toUpperCase() : part;
		});
}

export function Tooltip({
	label,
	shortcut,
	placement = "bottom",
	delay = 320,
	children,
}: {
	label: string;
	shortcut?: string;
	placement?: "top" | "bottom";
	delay?: number;
	children: ReactElement<TriggerProps>;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<DOMRect>();
	const [coords, setCoords] = useState<{ left: number; top: number; actualPlacement: "top" | "bottom" }>();
	const timer = useRef<number | undefined>(undefined);
	const popupRef = useRef<HTMLDivElement>(null);

	function cancelTimer() {
		if (timer.current !== undefined) {
			window.clearTimeout(timer.current);
			timer.current = undefined;
		}
	}

	function hide() {
		cancelTimer();
		setOpen(false);
	}

	function show(target: HTMLElement, immediate: boolean) {
		cancelTimer();
		const rect = target.getBoundingClientRect();
		setAnchor(rect);
		if (immediate) {
			setOpen(true);
			return;
		}
		timer.current = window.setTimeout(() => {
			timer.current = undefined;
			setAnchor(target.getBoundingClientRect());
			setOpen(true);
		}, delay);
	}

	useEffect(() => () => cancelTimer(), []);

	useEffect(() => {
		if (!open) return;
		const dismiss = () => setOpen(false);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("scroll", dismiss, true);
		window.addEventListener("resize", dismiss);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("scroll", dismiss, true);
			window.removeEventListener("resize", dismiss);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	useLayoutEffect(() => {
		if (!open || !anchor || !popupRef.current) return;
		const tip = popupRef.current.getBoundingClientRect();
		const gap = 6;
		let actualPlacement = placement;
		let top = placement === "top" ? anchor.top - tip.height - gap : anchor.bottom + gap;
		if (actualPlacement === "bottom" && top + tip.height > window.innerHeight - 8) {
			actualPlacement = "top";
			top = Math.max(8, anchor.top - tip.height - gap);
		} else if (actualPlacement === "top" && top < 8) {
			actualPlacement = "bottom";
			top = Math.min(window.innerHeight - tip.height - 8, anchor.bottom + gap);
		}
		const centeredLeft = anchor.left + anchor.width / 2 - tip.width / 2;
		const left = Math.max(8, Math.min(centeredLeft, window.innerWidth - tip.width - 8));
		setCoords({ left, top, actualPlacement });
	}, [open, anchor, placement, label, shortcut]);

	const keys = shortcut ? formatShortcut(shortcut) : [];
	const existingDescribedBy = children.props["aria-describedby"];
	const describedBy = open ? [existingDescribedBy, id].filter(Boolean).join(" ") : existingDescribedBy;

	const trigger = cloneElement(children, {
		"aria-describedby": describedBy,
		onPointerEnter: (event: PointerEvent<HTMLElement>) => {
			children.props.onPointerEnter?.(event);
			if (event.pointerType === "touch") return;
			show(event.currentTarget, false);
		},
		onPointerLeave: (event: PointerEvent<HTMLElement>) => {
			children.props.onPointerLeave?.(event);
			hide();
		},
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			children.props.onPointerDown?.(event);
			hide();
		},
		onFocus: (event: FocusEvent<HTMLElement>) => {
			children.props.onFocus?.(event);
			if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget, true);
		},
		onBlur: (event: FocusEvent<HTMLElement>) => {
			children.props.onBlur?.(event);
			hide();
		},
	});

	return (
		<>
			{trigger}
			{open &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						ref={popupRef}
						id={id}
						role="tooltip"
						className="ui-tooltip"
						data-placement={coords?.actualPlacement ?? placement}
						style={coords ? { left: coords.left, top: coords.top, visibility: "visible" } : { left: 0, top: 0, visibility: "hidden" }}
					>
						<span className="ui-tooltip-label">{label}</span>
						{keys.length > 0 && (
							<span className="ui-tooltip-keys" aria-hidden="true">
								{keys.map((key, index) => (
									<kbd key={`${key}:${index}`}>{key}</kbd>
								))}
							</span>
						)}
					</div>,
					document.body,
				)}
		</>
	);
}
