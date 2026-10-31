import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/client/Conversation.tsx";
import type { ChatMessage } from "../src/client/types.ts";

function render(message: ChatMessage): string {
	return renderToStaticMarkup(<Conversation messages={[message]} tools={[]} onFile={() => {}} followRequest={0} />);
}

describe("thinking display", () => {
	it("opens the streaming thinking block but keeps earlier thinking collapsed", () => {
		const html = render({
			messageId: "streaming",
			role: "assistant",
			partial: true,
			content: [
				{ type: "thinking", thinking: "Earlier thought" },
				{ type: "text", text: "Intermediate answer" },
				{ type: "thinking", thinking: "Current thought" },
			],
		});
		expect(html.match(/<details class="thinking" open="">/g)).toHaveLength(1);
		expect(html).toContain("<p>Current thought</p>");
		expect(html).not.toContain("<p>Earlier thought</p>");
	});

	it("keeps completed history and non-thinking streamed content collapsed", () => {
		const thought = { type: "thinking", thinking: "Previous thought" };
		for (const message of [
			{ messageId: "finished", role: "assistant", partial: false, content: [thought] },
			{ messageId: "answering", role: "assistant", partial: true, content: [thought, { type: "text", text: "Answer" }] },
			{ messageId: "tool", role: "assistant", partial: true, content: [thought, { type: "toolCall", id: "call", name: "read" }] },
			{ messageId: "user", role: "user", partial: true, content: [thought] },
		]) {
			const html = render(message);
			expect(html).toContain('<details class="thinking">');
			expect(html).not.toContain('<details class="thinking" open="">');
		}
	});
});
