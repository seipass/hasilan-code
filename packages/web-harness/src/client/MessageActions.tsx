import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import type { ChatMessage } from "./types.ts";

/** Flattens message content to copyable plain text without tool payloads. */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(messageText).filter(Boolean).join("\n\n");
	if (typeof content !== "object" || content === null) return "";
	const value = content as Record<string, unknown>;
	if (value.type === "text" && typeof value.text === "string") return value.text;
	if (value.type === "thinking") return "";
	if (value.type === "toolCall" || value.type === "toolResult") return "";
	return "";
}

export function userText(message: ChatMessage): string | undefined {
	if (message.role !== "user" || message.contextInjection || message.importedContext) return undefined;
	const text = messageText(message.content).trim();
	return text || undefined;
}

export function MessageActions({ message, content, onRetry, onEdit }: {
	message: ChatMessage;
	content: unknown;
	onRetry?: () => void;
	onEdit?: (text: string) => void;
}) {
	const text = messageText(content).trim();
	const editable = userText(message);
	const [copied, setCopied] = useState<"idle" | "done" | "error">("idle");
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			setCopied("done");
		} catch {
			setCopied("error");
		}
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied("idle"), 1600);
	}
	const assistant = message.role === "assistant";
	const visible = copied !== "idle" || !!text || (!!assistant && !!onRetry) || (!!editable && !!onEdit);
	if (!visible) return null;
	return <div className="message-actions">
		{text && <button type="button" aria-label={copied === "done" ? "コピーしました" : copied === "error" ? "コピーできません" : "コピー"} title={copied === "done" ? "コピーしました" : "コピー"} onClick={() => { void copy(); }} disabled={!text}>
			<Icon name={copied === "done" ? "check" : "copy"} size={13} />{copied === "error" ? "コピーできません" : copied === "done" ? "コピーしました" : "コピー"}
		</button>}
		{editable && onEdit && <button type="button" aria-label="入力欄に戻す" title="この依頼を入力欄に戻します" onClick={() => onEdit(editable)}><Icon name="undo" size={13} />入力欄に戻す</button>}
		{assistant && onRetry && <button type="button" aria-label="最後の依頼を再送" title="同じ依頼をもう一度送ります" onClick={onRetry}><Icon name="retry" size={13} />最後の依頼を再送</button>}
		{message.importedOrigin?.url && <a href={message.importedOrigin.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} />元の記録</a>}
	</div>;
}
