import type { GoalAction } from "../shared/goals.ts";
import { SWARM_OBJECTIVE_MAX_LENGTH } from "../shared/swarm.ts";

export type ComposerCommand =
	| { kind: "prompt"; text: string }
	| { kind: "chat" }
	| { kind: "canvas" }
	| { kind: "hyakki"; objective: string }
	| { kind: "goal"; action: GoalAction };

export const COMPOSER_COMMANDS = [
	{ command: "/hyakki", syntax: "/hyakki 目的", description: "エージェントスウォームを開始" },
	{ command: "/canvas", syntax: "/canvas", description: "設計エディターを開く（モデル不要）" },
	{ command: "/chat", syntax: "/chat", description: "会話に戻る" },
	{
		command: "/goal",
		syntax: "/goal 目標",
		description: "目標を開始 · pause / resume / drop / status",
	},
] as const;

/** Only a leading slash is a command. Ordinary messages retain their original whitespace. */
export function parseComposerCommand(text: string): ComposerCommand {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { kind: "prompt", text };
	const separator = trimmed.search(/\s/);
	const name = separator < 0 ? trimmed : trimmed.slice(0, separator);
	const args = separator < 0 ? "" : trimmed.slice(separator).trim();
	if (name === "/canvas" || name === "/chat") {
		if (args) throw new Error(`${name} に引数は指定できません。`);
		return { kind: name === "/canvas" ? "canvas" : "chat" };
	}
	if (name === "/hyakki") {
		if (!args) throw new Error("使い方: /hyakki 達成したい目的");
		if (args.length > SWARM_OBJECTIVE_MAX_LENGTH)
			throw new Error(`目的は ${SWARM_OBJECTIVE_MAX_LENGTH.toLocaleString("ja-JP")} 文字以内にしてください。`);
		return { kind: "hyakki", objective: args };
	}
	if (name !== "/goal")
		throw new Error(`不明なコマンド: ${name}。/hyakki、/canvas、/chat、/goal を使用してください。`);
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
	const subcommand = match?.[1] ?? "status";
	let rest = match?.[2]?.trim() ?? "";
	if (["status", "pause", "drop"].includes(subcommand)) {
		if (rest) throw new Error(`使い方: /goal ${subcommand}`);
		return { kind: "goal", action: { op: subcommand === "status" ? "get" : (subcommand as "pause" | "drop") } };
	}
	const resume = subcommand === "resume";
	if (!resume && subcommand !== "create") rest = args;
	if (rest.startsWith("--")) throw new Error("使い方: /goal [create] 達成したい目標");
	if (resume) {
		if (rest) throw new Error("使い方: /goal resume");
		return { kind: "goal", action: { op: "resume" } };
	}
	if (!rest) throw new Error("使い方: /goal [create] 達成したい目標");
	if (rest.length > 1024 * 1024) throw new Error("目標は 1,048,576 文字以内にしてください。");
	return { kind: "goal", action: { op: "create", objective: rest } };
}
