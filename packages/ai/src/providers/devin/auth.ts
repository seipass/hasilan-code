import { createHash, randomBytes } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type OAuthCallbackServer,
	startOAuthCallbackServer,
	waitForCallbackOrManualInput,
} from "../../auth/oauth/callback-server.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../../auth/types.ts";
import { apiServer, DEVIN_MODELS_PATH, normalizeToken, unary } from "./protocol.ts";

const YEAR = 365 * 24 * 60 * 60 * 1000;

function credential(token: string, server?: string): OAuthCredential {
	const access = normalizeToken(token);
	return { type: "oauth", access, refresh: access, expires: Date.now() + YEAR, apiServer: apiServer(server) };
}

async function importCredentials(signal: AbortSignal): Promise<OAuthCredential> {
	const home = homedir();
	const paths =
		process.platform === "win32"
			? [
					...new Set(
						[
							process.env.APPDATA && join(process.env.APPDATA, "devin", "credentials.toml"),
							process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "devin", "credentials.toml"),
							join(home, "AppData", "Roaming", "devin", "credentials.toml"),
							join(home, "AppData", "Local", "devin", "credentials.toml"),
						].filter((path): path is string => Boolean(path)),
					),
				]
			: [join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "devin", "credentials.toml")];
	for (const path of paths) {
		signal.throwIfAborted();
		let file: FileHandle;
		try {
			file = await open(path, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error("Devin CLIの資格情報ファイルを読み込めません。", { cause: error });
		}
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > 65536)
				throw new Error("Devin CLIの資格情報ファイルの形式またはサイズが不正です。");
			const source = await file.readFile({ encoding: "utf8", signal });
			const values = new Map<string, string>();
			for (const line of source.split(/\r?\n/)) {
				if (/^\s*\[/.test(line)) break;
				const match = /^\s*(windsurf_api_key|api_server_url)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(
					line,
				);
				if (!match) continue;
				if (values.has(match[1])) throw new Error("Devin CLIの資格情報に重複する設定があります。");
				let value: unknown;
				try {
					value = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].slice(1, -1);
				} catch {
					throw new Error("Devin CLIの資格情報の文字列形式が不正です。");
				}
				if (typeof value !== "string") throw new Error("Devin CLIの資格情報が不正です。");
				values.set(match[1], value);
			}
			const token = values.get("windsurf_api_key");
			if (!token) throw new Error("Devin CLIの資格情報にセッショントークンがありません。");
			return credential(token, values.get("api_server_url"));
		} finally {
			await file.close();
		}
	}
	throw new Error(
		"Devin CLIのcredentials.tomlが見つかりません。Devin CLIでログインするか、ブラウザーでログインしてください。",
	);
}

async function browserLogin(interaction: ProviderAuthInteraction, fetcher: typeof fetch): Promise<OAuthCredential> {
	const verifier = randomBytes(32).toString("base64url");
	const state = randomBytes(24).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	async function exchange(code: string): Promise<OAuthCredential> {
		const response = await fetcher("https://api.devin.ai/auth/cli/token", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier, cli_pkce_marker: 1 }),
			signal: interaction.signal,
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Devinログインのトークン交換に失敗しました（HTTP ${response.status}）。`);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error("Devinログインの応答形式が不正です。");
		}
		if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string")
			throw new Error("Devinログインの応答にトークンがありません。");
		return credential(body.token);
	}
	const options = {
		providerName: "Devin",
		host: "127.0.0.1",
		port: 59653,
		path: "/callback",
		state,
		complete: exchange,
		signal: interaction.signal,
		timeoutMs: 10 * 60 * 1000,
	};
	let callback: OAuthCallbackServer<OAuthCredential>;
	try {
		callback = await startOAuthCallbackServer(options);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		callback = await startOAuthCallbackServer({ ...options, port: 0 });
	}
	try {
		const url = new URL("https://app.devin.ai/auth/cli/continue");
		url.search = new URLSearchParams({
			redirect_uri: callback.redirectUri,
			state,
			cli_pkce_marker: "1",
			prompt: "select_account",
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();
		interaction.notify({ type: "auth_url", url: url.href, instructions: "Devinアカウントでログインしてください。" });
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "ブラウザーから戻らない場合は、ログイン後のコールバックURLを貼り付けてください。",
			placeholder: callback.redirectUri,
		});
		if (result.type === "callback") return result.value;
		const pasted = new URL(result.input);
		const expected = new URL(callback.redirectUri);
		if (
			pasted.origin !== expected.origin ||
			pasted.pathname !== expected.pathname ||
			pasted.searchParams.get("state") !== state ||
			pasted.searchParams.has("error")
		)
			throw new Error("DevinログインのコールバックURLが一致しません。");
		const code = pasted.searchParams.get("code");
		if (!code) throw new Error("DevinログインのコールバックURLにコードがありません。");
		return await exchange(code);
	} finally {
		callback.close();
	}
}

export function devinAuth(fetcher: typeof fetch = fetch): OAuthAuth {
	return {
		name: "Devinアカウント",
		loginLabel: "Devinでログイン",
		isSubscription: true,
		async login(interaction) {
			const method = await interaction.prompt({
				type: "select",
				message: "Devinへの接続方法",
				options: [
					{ id: "browser", label: "ブラウザーでログイン" },
					{ id: "import", label: "このPCのDevin CLIから読み込む" },
					{ id: "token", label: "セッショントークンを入力" },
				],
			});
			if (method === "browser") return browserLogin(interaction, fetcher);
			if (method === "import") return importCredentials(interaction.signal);
			if (method === "token")
				return credential(
					await interaction.prompt({
						type: "secret",
						message: "Devinのセッショントークン",
						placeholder: "devin-session-token$…",
					}),
				);
			throw new Error("Devinの接続方法を選択してください。");
		},
		async refresh(stored, signal) {
			await unary(apiServer(stored.apiServer), DEVIN_MODELS_PATH, stored.access, signal, fetcher);
			return { ...stored, expires: Date.now() + YEAR };
		},
		async toAuth(stored) {
			return { apiKey: normalizeToken(stored.access), baseUrl: apiServer(stored.apiServer) };
		},
	};
}
