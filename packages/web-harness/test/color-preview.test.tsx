import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/client/Conversation.tsx";
import type { ChatMessage } from "../src/client/types.ts";

function render(message: ChatMessage): string {
	return renderToStaticMarkup(<Conversation messages={[message]} tools={[]} onFile={() => {}} followRequest={0} />);
}

describe("assistant color previews", () => {
	it("shows color squares for plain text and inline code", () => {
		const html = render({ messageId: "assistant", role: "assistant", partial: false, content: "背景は #f8fafc、文字は `#abc`、アクセントは rgb(12, 34, 56)。" });
		expect(html.match(/class="color-preview-swatch"/g)).toHaveLength(3);
		expect(html).toContain("background-color:#f8fafc");
		expect(html).toContain("background-color:#abc");
		expect(html).toContain("background-color:rgb(12, 34, 56)");
	});

	it("shows colors in code blocks while leaving user messages, links and invalid hex values unchanged", () => {
		const user = render({ messageId: "user", role: "user", partial: false, content: "#f8fafc" });
		expect(user).not.toContain("color-preview-swatch");
		const assistant = render({
			messageId: "assistant",
			role: "assistant",
			partial: false,
			content: "不正な #abcd123 と [#fff](https://example.com/#fff)\n\n```css\ncolor: #fff;\n```",
		});
		expect(assistant.match(/class="color-preview-swatch"/g)).toHaveLength(1);
		expect(assistant).toContain("color: <span");
	});
});
