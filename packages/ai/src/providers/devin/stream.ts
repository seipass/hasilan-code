import { createHash, randomUUID } from "node:crypto";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type Model,
	parseStreamingJson,
	parseToolCallArguments,
	type SimpleStreamOptions,
	type ThinkingContent,
	type ToolCall,
	type TranscriptContext,
	toToolDeclaration,
} from "../../index.ts";
import {
	apiServer,
	blobs,
	DEVIN_CHAT_PATH,
	decode,
	double,
	encode,
	frame,
	headers,
	integer,
	metadata,
	normalizeToken,
	readFrames,
	text,
} from "./protocol.ts";

function stableId(seed: string): string {
	const hash = createHash("sha256").update(seed).digest();
	hash[6] = (hash[6] & 15) | 0x50;
	hash[8] = (hash[8] & 63) | 0x80;
	const hex = hash.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function request(
	model: Model<"devin-connect">,
	context: TranscriptContext,
	options: SimpleStreamOptions,
	uid: string,
): Buffer {
	const cascade = stableId(`hasilan-code:devin:${options.sessionId || randomUUID()}`);
	const prompts: Buffer[] = [];
	for (const [index, message] of context.messages.entries()) {
		if (message.role === "system") continue;
		const parts =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const imageParts: Buffer[] = [];
		const calls: Buffer[] = [];
		let content = "";
		let thinking = "";
		let signature = "";
		for (const part of parts) {
			if (part.type === "text") content += part.text;
			else if (part.type === "image") {
				if (!model.input.includes("image")) throw new Error("このDevinモデルは画像入力に対応していません。");
				imageParts.push(
					encode([
						[1, part.data],
						[2, part.mimeType],
					]),
				);
			} else if (part.type === "toolCall")
				calls.push(
					encode([
						[1, part.id],
						[2, part.name],
						[3, JSON.stringify(part.arguments)],
					]),
				);
			else if (part.type === "thinking" && message.role === "assistant" && message.provider === "devin") {
				thinking += part.thinking;
				if (part.thinkingSignature) signature += part.thinkingSignature;
			}
		}
		prompts.push(
			encode([
				[
					1,
					message.role === "assistant" && message.provider === "devin" && message.responseId
						? message.responseId
						: stableId(`${cascade}\0${index}\0${message.role}`),
				],
				[2, message.role === "assistant" ? 2 : message.role === "toolResult" ? 4 : 1],
				[3, content],
				...calls.map((call) => [6, call] as const),
				[7, message.role === "toolResult" ? message.toolCallId : undefined],
				[9, message.role === "toolResult" && message.isError ? true : undefined],
				...imageParts.map((image) => [10, image] as const),
				[11, thinking || undefined],
				[12, signature || undefined],
			]),
		);
	}
	const tools = getCurrentTools(context.messages).map((tool) => {
		if (tool.constrainedSampling && tool.constrainedSampling.type === "grammar")
			throw new Error("Devin does not support grammar-constrained tools");
		const declaration = toToolDeclaration(tool);
		return encode([
			[1, tool.name],
			[2, tool.description],
			[3, JSON.stringify(declaration.parameters)],
			[
				12,
				tool.constrainedSampling &&
				tool.constrainedSampling.type === "json_schema" &&
				tool.constrainedSampling.strict === "require"
					? true
					: undefined,
			],
		]);
	});
	const temperature = options.temperature ?? 0.4;
	const configuration = Buffer.concat([
		encode([
			[1, 1],
			[2, Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens)],
			[3, 200],
		]),
		double(5, temperature === 0 ? 1e-6 : temperature),
		double(6, temperature === 0 ? 1e-6 : temperature),
		encode([[7, 50]]),
		double(8, 1),
		encode([
			...["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"].map(
				(stop) => [9, stop] as const,
			),
		]),
		double(11, 1),
	]);
	return encode([
		[2, getCurrentSystemPrompt(context.messages)],
		...prompts.map((prompt) => [3, prompt] as const),
		[7, 5],
		[8, configuration],
		...tools.map((tool) => [10, tool] as const),
		[11, true],
		[12, encode([[1, options.toolChoice ?? "auto"]])],
		[13, encode([[1, 1]])],
		[16, cascade],
		[20, 1],
		[21, uid],
		[22, randomUUID()],
	]);
}

export function streamDevin(
	model: Model<"devin-connect">,
	context: TranscriptContext,
	options: SimpleStreamOptions = {},
	fetcher: typeof fetch = fetch,
): AssistantMessageEventStream {
	const events = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		api: "devin-connect",
		provider: "devin",
		model: model.id,
		timestamp: Date.now(),
		content: [],
		stopReason: "pending",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	void (async () => {
		let token = "";
		let response: Response | undefined;
		try {
			const signal = AbortSignal.any([
				...(options.signal ? [options.signal] : []),
				AbortSignal.timeout(options.timeoutMs ?? 290000),
			]);
			signal.throwIfAborted();
			if (!options.apiKey) throw new Error("Devinへのログインが必要です。");
			if (options.deferred) throw new Error("Devin does not support deferred requests");
			token = normalizeToken(options.apiKey);
			const reasoning = options.reasoning ?? "off";
			if (reasoning !== "off" && (!model.reasoning || model.thinkingLevelMap?.[reasoning] === null))
				throw new Error("このDevinモデルは指定したThinking強度に対応していません。");
			const uid = model.thinkingLevelMap?.[reasoning] ?? model.samplingParams?.chat_model_uid;
			if (typeof uid !== "string" || !uid) throw new Error("Devinモデル一覧を更新してください。");
			output.providerThinkingLevel = uid;
			const built = request(model, context, options, uid);
			// Hooks inspect the wire payload without the credential-bearing metadata.
			const replacement = await options.onPayload?.(built, model);
			if (replacement !== undefined && !(replacement instanceof Uint8Array))
				throw new Error("Devin onPayload must return protobuf bytes or undefined");
			const body = frame(Buffer.concat([encode([[1, metadata(token)]]), replacement ?? built]));
			const requestHeaders = new Headers(headers(token, true));
			for (const [key, value] of Object.entries(options.headers ?? {}))
				if (value === null) requestHeaders.delete(key);
				else requestHeaders.set(key, value);
			response = await (options.fetch ?? fetcher)(`${apiServer(model.baseUrl)}${DEVIN_CHAT_PATH}`, {
				method: "POST",
				headers: requestHeaders,
				body,
				signal,
				redirect: "error",
			});
			await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(`Devin生成リクエストに失敗しました（HTTP ${response.status}）。`);
			}
			if (!response.body) throw new Error("Devinから応答ストリームが返されませんでした。");
			events.push({ type: "start", partial: output });
			let textIndex = -1;
			let thinkingIndex = -1;
			let activeTool: string | undefined;
			let stopReason = 0;
			let ended = false;
			const calls = new Map<string, { index: number; json: string; call: ToolCall }>();
			for await (const item of readFrames(response.body, signal)) {
				if (ended) throw new Error("Devin sent content after the end of its stream");
				if (item.end) {
					const trailerText = item.payload.toString("utf8").trim();
					const trailer: unknown = trailerText ? JSON.parse(trailerText) : {};
					if (!trailer || typeof trailer !== "object" || Array.isArray(trailer))
						throw new Error("Invalid Devin Connect trailer");
					if ("error" in trailer && trailer.error) {
						const error = trailer.error;
						const message =
							typeof error === "object" &&
							error !== null &&
							"message" in error &&
							typeof error.message === "string"
								? error.message
								: "Devin Connect error";
						throw new Error(message);
					}
					ended = true;
					continue;
				}
				const fields = decode(item.payload);
				await options.onProviderStreamEvent?.(fields, model);
				output.responseId ||= text(fields, 1);
				output.responseModel = text(fields, 23) || output.responseModel;
				const thinking = text(fields, 9);
				if (thinking) {
					if (thinkingIndex < 0) {
						thinkingIndex = output.content.length;
						output.content.push({ type: "thinking", thinking: "" });
						events.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
					}
					(output.content[thinkingIndex] as ThinkingContent).thinking += thinking;
					(output.content[thinkingIndex] as ThinkingContent).redacted = undefined;
					events.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: thinking, partial: output });
				}
				const signature = text(fields, 10);
				if (signature) {
					if (thinkingIndex < 0) {
						thinkingIndex = output.content.length;
						output.content.push({ type: "thinking", thinking: "", redacted: true });
						events.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
					}
					const block = output.content[thinkingIndex] as ThinkingContent;
					block.thinkingSignature = (block.thinkingSignature ?? "") + signature;
				}
				const delta = text(fields, 3);
				if (delta) {
					if (textIndex < 0) {
						textIndex = output.content.length;
						output.content.push({ type: "text", text: "" });
						events.push({ type: "text_start", contentIndex: textIndex, partial: output });
					}
					const block = output.content[textIndex];
					if (block.type === "text") block.text += delta;
					events.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
				}
				for (const bytes of blobs(fields, 6)) {
					const part = decode(bytes);
					const id = text(part, 1) || activeTool;
					if (!id) throw new Error("Devin tool call has no id");
					activeTool = id;
					let entry = calls.get(id);
					if (!entry) {
						const call: ToolCall = { type: "toolCall", id, name: text(part, 2) ?? "", arguments: {} };
						entry = { index: output.content.length, json: "", call };
						calls.set(id, entry);
						output.content.push(call);
						events.push({ type: "toolcall_start", contentIndex: entry.index, partial: output });
					}
					entry.call.name = text(part, 2) || entry.call.name;
					const next = text(part, 3);
					if (next) {
						const delta = next.startsWith(entry.json) ? next.slice(entry.json.length) : next;
						entry.json += delta;
						const argumentsValue = parseStreamingJson<JsonObject>(entry.json);
						entry.call.arguments =
							argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
								? argumentsValue
								: {};
						if (delta) events.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: output });
					}
				}
				stopReason = integer(fields, 5) || stopReason;
				const usage = blobs(fields, 7)[0];
				if (usage) {
					const measured = decode(usage);
					output.usage.input = integer(measured, 2);
					output.usage.output = integer(measured, 3);
					output.usage.cacheWrite = integer(measured, 4);
					output.usage.cacheRead = integer(measured, 5);
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					output.responseModel = text(measured, 9) || output.responseModel;
				}
			}
			if (!ended) throw new Error("Devin stream ended without a Connect end frame");
			if (stopReason === 13) throw new Error("Devin reported a generation error");
			if (output.content.length === 0) throw new Error("Devin returned no assistant content");
			for (const entry of calls.values()) {
				if (!entry.call.name) throw new Error("Devin tool call has no name");
				Object.assign(entry.call, parseToolCallArguments(entry.json));
			}
			for (const [index, block] of output.content.entries()) {
				if (block.type === "text")
					events.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
				else if (block.type === "thinking")
					events.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
				else events.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			}
			output.rawStopReason = String(stopReason);
			output.stopReason = stopReason === 3 ? "length" : calls.size || stopReason === 10 ? "toolUse" : "stop";
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			let message = error instanceof Error ? error.message : "Devin request failed";
			if (token) {
				message = message.replaceAll(token, "<redacted>");
				const raw = token.slice("devin-session-token$".length);
				if (raw) message = message.replaceAll(raw, "<redacted>");
			}
			output.errorMessage = message;
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			await response?.body?.cancel().catch(() => undefined);
			events.end();
		}
	})();
	return events;
}
