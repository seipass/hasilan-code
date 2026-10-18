/*!
 * Devin wire field mapping adapted from dsh-plugin-oauth-subs.
 * https://github.com/xxww0098/dsh-plugin-oauth-subs/tree/main/src/oauth/devin
 * MIT License — Copyright (c) 2026 dsh-plugin-oauth-subs contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { AccountUsageError } from "../../account-usage.ts";

export const DEVIN_SERVER = "https://server.codeium.com";
export const DEVIN_MODELS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
export const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const FRAME_LIMIT = 16 * 1024 * 1024;
const CLI_VERSION = "3000.11.3";
type Value = string | number | boolean | Uint8Array;
export type Fields = ReadonlyMap<number, readonly (Buffer | bigint)[]>;

function varint(value: number): Buffer {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Devin protobuf integer");
	const bytes: number[] = [];
	do {
		const low = value % 128;
		value = Math.floor(value / 128);
		bytes.push(low | (value ? 128 : 0));
	} while (value);
	return Buffer.from(bytes);
}

export function encode(fields: readonly (readonly [number, Value | undefined])[]): Buffer<ArrayBuffer> {
	const parts: Uint8Array[] = [];
	for (const [field, value] of fields) {
		if (value === undefined) continue;
		if (typeof value === "number" || typeof value === "boolean") parts.push(varint(field * 8), varint(Number(value)));
		else {
			const bytes = typeof value === "string" ? Buffer.from(value) : value;
			parts.push(varint(field * 8 + 2), varint(bytes.byteLength), bytes);
		}
	}
	return Buffer.concat(parts);
}

export function double(field: number, value: number): Buffer {
	if (!Number.isFinite(value)) throw new Error("Invalid Devin sampling value");
	const bytes = Buffer.allocUnsafe(8);
	bytes.writeDoubleLE(value);
	return Buffer.concat([varint(field * 8 + 1), bytes]);
}

export function decode(bytes: Buffer): Fields {
	const result = new Map<number, (Buffer | bigint)[]>();
	let offset = 0;
	function readVarint(): bigint {
		let value = 0n;
		for (let shift = 0n; shift < 70n; shift += 7n) {
			if (offset >= bytes.length) throw new Error("Truncated Devin protobuf integer");
			const byte = bytes[offset++];
			if (shift === 63n && byte > 1) throw new Error("Invalid Devin protobuf integer");
			value |= BigInt(byte & 127) << shift;
			if (!(byte & 128)) return value;
		}
		throw new Error("Invalid Devin protobuf integer");
	}
	while (offset < bytes.length) {
		const tag = readVarint();
		const field = Number(tag >> 3n);
		const wire = Number(tag & 7n);
		if (field < 1 || field > 536870911) throw new Error("Invalid Devin protobuf field");
		let value: Buffer | bigint;
		if (wire === 0) value = readVarint();
		else {
			const length = wire === 2 ? Number(readVarint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
			if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset)
				throw new Error("Invalid Devin protobuf length");
			value = bytes.subarray(offset, offset + length);
			offset += length;
		}
		const values = result.get(field);
		if (values) values.push(value);
		else result.set(field, [value]);
	}
	return result;
}

export function blobs(fields: Fields, field: number): Buffer[] {
	return (fields.get(field) ?? []).filter((value): value is Buffer => Buffer.isBuffer(value));
}
export function text(fields: Fields, field: number): string | undefined {
	const value = fields.get(field)?.[0];
	return Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
}
export function integer(fields: Fields, field: number): number {
	const value = fields.get(field)?.[0];
	if (typeof value !== "bigint") return 0;
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Devin token count exceeds the safe integer range");
	return Number(value);
}

export function apiServer(value: unknown): string {
	if (value === undefined) return DEVIN_SERVER;
	if (typeof value !== "string") throw new Error("Invalid Devin API server");
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
		throw new Error("Devin API server must be an HTTPS origin");
	return url.origin;
}

export function normalizeToken(value: string): string {
	const token = value.trim();
	if (!token || token === "devin-session-token$" || token.length > 16384 || /\s/.test(token))
		throw new Error("Invalid Devin session token");
	return token.startsWith("devin-session-token$") ? token : `devin-session-token$${token}`;
}

export function metadata(token: string, catalog = false): Buffer {
	return encode([
		[1, "chisel"],
		[2, CLI_VERSION],
		[3, normalizeToken(token)],
		[4, "en"],
		[5, process.platform],
		[7, CLI_VERSION],
		[12, "chisel"],
		[30, catalog ? Buffer.from([3, 4, 6, 7, 8]) : undefined],
	]);
}

export function headers(token: string, streaming: boolean): Record<string, string> {
	const normalized = normalizeToken(token);
	return {
		"content-type": streaming ? "application/connect+proto" : "application/proto",
		"connect-protocol-version": "1",
		authorization: `Basic ${normalized}-${normalized}`,
		...(streaming
			? {
					"connect-content-encoding": "gzip",
					"connect-accept-encoding": "gzip",
					"accept-encoding": "identity",
					"user-agent": "connect-go/1.18.1 (go1.26.3)",
				}
			: {}),
	};
}

export function frame(payload: Buffer, flags = 1): Buffer<ArrayBuffer> {
	const body = flags & 1 ? gzipSync(payload) : payload;
	if (body.length > FRAME_LIMIT) throw new Error("Devin request exceeds the Connect frame limit");
	const header = Buffer.allocUnsafe(5);
	header[0] = flags;
	header.writeUInt32BE(body.length, 1);
	return Buffer.concat([header, body]);
}

export async function* readFrames(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<{ end: boolean; payload: Buffer }> {
	const reader = body.getReader();
	let current: Uint8Array = new Uint8Array(0);
	let offset = 0;
	async function read(size: number, allowEof = false): Promise<Buffer | undefined> {
		let written = 0;
		let output: Buffer | undefined;
		while (written < size) {
			signal.throwIfAborted();
			if (offset === current.length) {
				const next = await reader.read();
				if (next.done) {
					if (allowEof && written === 0) return undefined;
					throw new Error("Truncated Devin Connect frame");
				}
				current = next.value;
				offset = 0;
			}
			const length = Math.min(size - written, current.length - offset);
			if (written === 0 && length === size) {
				const result = Buffer.from(current.buffer, current.byteOffset + offset, size);
				offset += size;
				return result;
			}
			output ??= Buffer.allocUnsafe(size);
			output.set(current.subarray(offset, offset + length), written);
			offset += length;
			written += length;
		}
		return output ?? Buffer.alloc(0);
	}
	const cancel = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			const header = await read(5, true);
			if (!header) return;
			if (header[0] & ~3) throw new Error("Unsupported Devin Connect frame flags");
			const length = header.readUInt32BE(1);
			if (length > FRAME_LIMIT) throw new Error("Devin Connect frame exceeds the size limit");
			const payload = (await read(length))!;
			yield {
				end: Boolean(header[0] & 2),
				payload: header[0] & 1 ? gunzipSync(payload, { maxOutputLength: FRAME_LIMIT }) : payload,
			};
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export async function unary(
	server: string,
	path: string,
	token: string,
	signal: AbortSignal,
	fetcher: typeof fetch = fetch,
): Promise<Fields> {
	const response = await fetcher(`${apiServer(server)}${path}`, {
		method: "POST",
		headers: headers(token, false),
		body: encode([[1, metadata(token, path === DEVIN_MODELS_PATH)]]),
		signal,
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new AccountUsageError(`Devin RPC failed (HTTP ${response.status})`);
	}
	if (!response.body) throw new Error("Devin RPC returned no body");
	const parts: Uint8Array[] = [];
	let size = 0;
	for await (const part of response.body) {
		size += part.length;
		if (size > FRAME_LIMIT) throw new Error("Devin RPC response exceeds the size limit");
		parts.push(part);
	}
	let bytes = Buffer.concat(parts);
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes, { maxOutputLength: FRAME_LIMIT });
	if (bytes.length >= 5 && bytes[0] <= 3) {
		let payload: Buffer<ArrayBuffer> | undefined;
		let ended = false;
		for (let offset = 0; offset < bytes.length; ) {
			if (ended || offset + 5 > bytes.length) throw new Error("Invalid Devin unary Connect framing");
			const flags = bytes[offset];
			const size = bytes.readUInt32BE(offset + 1);
			offset += 5;
			if (flags > 3 || size > FRAME_LIMIT || offset + size > bytes.length)
				throw new Error("Invalid Devin unary Connect frame");
			let part = bytes.subarray(offset, offset + size);
			offset += size;
			if (flags & 1) part = gunzipSync(part, { maxOutputLength: FRAME_LIMIT });
			if (flags & 2) {
				let trailer: unknown;
				try {
					trailer = part.length ? JSON.parse(part.toString("utf8")) : {};
				} catch {
					throw new Error("Invalid Devin unary Connect trailer");
				}
				if (
					!trailer ||
					typeof trailer !== "object" ||
					Array.isArray(trailer) ||
					("error" in trailer && trailer.error)
				)
					throw new Error("Devin RPC returned a Connect error");
				ended = true;
			} else {
				if (payload) throw new Error("Devin unary RPC returned multiple messages");
				payload = part;
			}
		}
		if (!payload) throw new Error("Devin unary RPC returned no message");
		bytes = payload;
	}
	return decode(bytes);
}
