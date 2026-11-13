/** Normalize typed Mistral text/thinking chunks for the OpenAI SSE adapter. */
export function normalizeMistralDelta(delta: Record<string, unknown>): void {
	if (!Array.isArray(delta.content)) return;
	let text = "";
	let thinking = "";
	const unpack = (value: unknown): string => {
		if (typeof value === "string") return value;
		if (!Array.isArray(value)) throw new Error("Unsupported Mistral content block");
		return value.map((block) => {
			if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") {
				throw new Error("Unsupported Mistral content block");
			}
			return block.text;
		}).join("");
	};
	for (const block of delta.content) {
		if (!block || typeof block !== "object") throw new Error("Unsupported Mistral streamed content block");
		if (block.type === "text") text += unpack(block.text);
		else if (block.type === "thinking") thinking += unpack(block.thinking);
		else throw new Error("Unsupported Mistral streamed content block");
	}
	delta.content = text;
	if (thinking) {
		delta.reasoning_content = (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "") + thinking;
	}
}

export function normalizeMistralStream(response: Response): Response {
	if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
		return response;
	}
	let pending = "";
	const normalizeLine = (line: string): string => {
		if (!line.startsWith("data:")) return line;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return line;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return line;
		}
		if (parsed && typeof parsed === "object" && "choices" in parsed && Array.isArray(parsed.choices)) {
			for (const choice of parsed.choices) {
				if (choice?.delta && typeof choice.delta === "object") normalizeMistralDelta(choice.delta);
			}
		}
		return "data: " + JSON.stringify(parsed);
	};
	const body = response.body
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(new TransformStream<string, string>({
			transform(chunk, controller) {
				pending += chunk;
				let index = pending.indexOf("\n");
				while (index !== -1) {
					controller.enqueue(normalizeLine(pending.slice(0, index).replace(/\r$/, "")) + "\n");
					pending = pending.slice(index + 1);
					index = pending.indexOf("\n");
				}
			},
			flush(controller) {
				if (pending) controller.enqueue(normalizeLine(pending));
			},
		}))
		.pipeThrough(new TextEncoderStream());
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
