import { Children, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
import "./Select.css";

interface Choice { value: string; label: string; group?: string; disabled?: boolean }
function choices(children: ReactNode, group?: string): Choice[] {
	return Children.toArray(children).flatMap((child) => {
		if (!isValidElement<{ children?: ReactNode; value?: string; label?: string; disabled?: boolean }>(child)) return [];
		if (child.type === "optgroup") return choices(child.props.children, child.props.label);
		if (child.type !== "option") return choices(child.props.children, group);
		const label = Children.toArray(child.props.children).join("");
		return [{ value: child.props.value ?? label, label, group, disabled: child.props.disabled }];
	});
}

/** Shared, searchable selection menu. Option elements are data only, never native controls. */
export function Select({ children, value, onChange, disabled, id, "aria-label": label }: {
	children: ReactNode; value: string; onChange: (value: string) => void; disabled?: boolean; id?: string; "aria-label"?: string;
}) {
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const listId = useId();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const [bounds, setBounds] = useState({ left: 0, top: 0, width: 200, height: 280 });
	const options = useMemo(() => choices(children), [children]);
	const filtered = options.filter((option) => `${option.group ?? ""} ${option.label}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
	const selected = options.find((option) => option.value === value);
	function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
	function choose(option: Choice) { if (option.disabled || trigger.current?.matches(":disabled")) return; onChange(option.value); close(true); }
	useLayoutEffect(() => {
		if (!open) return;
		popup.current?.showPopover();
		const update = () => {
			const rect = trigger.current?.getBoundingClientRect();
			if (!rect) return;
			const below = window.innerHeight - rect.bottom - 12;
			const above = rect.top - 12;
			const height = Math.min(320, Math.max(below, above));
			const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
			setBounds({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: below >= Math.min(240, height) ? rect.bottom + 4 : Math.max(12, rect.top - height - 4), width, height });
		};
		update();
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
	}, [open]);
	useEffect(() => {
		if (!open) return;
		(popup.current?.querySelector<HTMLInputElement>("input") ?? popup.current)?.focus();
		const dismiss = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close(); };
		document.addEventListener("pointerdown", dismiss, true);
		return () => document.removeEventListener("pointerdown", dismiss, true);
	}, [open]);
	useEffect(() => { if (open) document.getElementById(`${listId}-${cursor}`)?.scrollIntoView({ block: "nearest" }); }, [open, cursor, listId]);
	const menu = open && <div ref={popup} popover="manual" className="select-menu" tabIndex={-1} style={{ left: bounds.left, top: bounds.top, width: bounds.width, maxHeight: bounds.height }} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
		if (event.nativeEvent.isComposing) return;
		event.stopPropagation();
		if (event.key === "Escape") { event.preventDefault(); close(true); }
		else if (event.key === "Tab") { close(true); }
		else if (event.key === "Enter" || event.key === " " && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); if (filtered[cursor]) choose(filtered[cursor]); }
		else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
			event.preventDefault();
			const indices = filtered.flatMap((option, index) => option.disabled ? [] : [index]);
			const position = indices.indexOf(cursor);
			setCursor(event.key === "Home" ? indices[0] ?? 0 : event.key === "End" ? indices.at(-1) ?? 0 : indices[(position + (event.key === "ArrowDown" ? 1 : -1) + indices.length) % indices.length] ?? 0);
		}
	}}>
		{options.length > 10 && <input type="search" aria-label="選択肢を検索" placeholder="検索…" value={query} onChange={(event) => { setQuery(event.target.value); setCursor(0); }} />}
		<div className="select-options" role="listbox" id={listId} aria-label={label ?? "選択肢"} aria-activedescendant={filtered[cursor] ? `${listId}-${cursor}` : undefined}>
			{filtered.map((option, index) => <div key={option.value}>{option.group && option.group !== filtered[index - 1]?.group && <div className="select-group">{option.group}</div>}<button type="button" role="option" id={`${listId}-${index}`} aria-selected={option.value === value} disabled={option.disabled} tabIndex={-1} data-highlighted={index === cursor} onMouseMove={() => setCursor(index)} onClick={() => choose(option)}><span>{option.label}</span>{option.value === value && <Icon name="check" size="inline" />}</button></div>)}
			{!filtered.length && <p>一致する項目はありません。</p>}
		</div>
	</div>;
	return <span className="select-control"><button ref={trigger} type="button" id={id} className="select-trigger" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => { setQuery(""); setCursor(Math.max(0, options.findIndex((option) => option.value === value))); setOpen(!open); }} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setCursor(Math.max(0, options.findIndex((option) => option.value === value))); setQuery(""); setOpen(true); } }}><span>{selected?.label ?? "選択してください"}</span><Icon name="chevronDown" size="inline" /></button>{menu && createPortal(menu, trigger.current?.closest("dialog, [role='dialog']") ?? document.body)}</span>;
}
