import { EventEmitter } from "node:events";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { ChatPane } from "../src/client/ChatPane.tsx";
import type { SessionDetail } from "../src/client/types.ts";
import { EventHub } from "../src/server/events.ts";

function transcript(count: number): SessionDetail {
	return {
		sessionId: "long-session", workspaceId: "workspace", cwd: "/workspace",
		materialized: true, availability: "ready", pendingInput: [], activity: {}, toolCalls: [],
		messages: Array.from({ length: count }, (_, index) => ({
			messageId: `message-${index}`, role: index % 2 ? "assistant" : "user", partial: false,
			content: `Message ${index}\n\n${"Long **Markdown** conversation. ".repeat(12)}`,
		})),
	};
}

class Socket extends EventEmitter {
	readyState = 1;
	bufferedAmount = 0;
	messages: string[] = [];
	send(data: string) { this.messages.push(data); }
	close() { this.readyState = 3; this.emit("close"); }
}

describe("long session work is bounded by the visible history", () => {
	it("does not render the entire transcript into the initial document", () => {
		const started = performance.now();
		const html = renderToStaticMarkup(<ChatPane session={transcript(1000)} connected draftKey="fixture"
			modelControl={null} goalControl={null} onDraftInserted={() => {}} onSend={async () => ({})}
			onPendingInputAction={async () => {}} onFile={() => {}} onStop={() => {}} onParent={() => {}}
			onModelSelect={() => {}} onProviderSettings={() => {}} />);
		const rows = (html.match(/class="message role-/g) ?? []).length;
		console.info(JSON.stringify({ renderedRows: rows, renderMs: Math.round(performance.now() - started) }));
		expect(rows).toBeGreaterThan(0);
		expect(rows).toBeLessThan(40);
		expect(html).toContain("Message 999");
	});
	it("sends a bounded initial page and only the changed message on update", async () => {
		vi.useFakeTimers();
		const session = transcript(1000);
		const hub = new EventHub(() => session);
		try {
			const socket = new Socket();
			hub.attach(socket as unknown as WebSocket);
			socket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", subscriptionId: "s", channel: "session", id: session.sessionId })), false);
			const initial = JSON.parse(socket.messages[0]) as { data: SessionDetail };
			session.messages[999] = { ...session.messages[999], content: "Changed last message" };
			hub.publish("session", session.sessionId);
			await vi.advanceTimersByTimeAsync(50);
			console.info(JSON.stringify({ initialBytes: socket.messages[0].length, updateBytes: socket.messages[1].length, initialMessages: initial.data.messages.length }));
			expect(initial.data.messages).toHaveLength(50);
			expect(socket.messages[1].length).toBeLessThan(10000);
			expect(socket.messages[1]).toContain("Changed last message");
			expect(socket.messages[1]).not.toContain("Message 998");
		} finally {
			hub.close();
			vi.useRealTimers();
		}
	});
});
