import type { ThinkingLevel } from "@hasilan-code/pi-agent-core";
import type { AttachmentUpload } from "../shared/attachments.ts";
import {
	type ComposerDestination,
	type ConversationDestination,
	canContinueSession,
	type WorkspaceRouteResult,
} from "../shared/workspace-routing.ts";
import { api, command } from "./api.ts";
import type { Model, SessionDetail, Workspace } from "./types.ts";

/** Resolve before sending. Existing sessions retain their history, model and thinking level. */
export async function sendWorkspacePrompt(input: {
	text: string;
	attachments: AttachmentUpload[];
	destination: ComposerDestination;
	workspaces: Workspace[];
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	beforeStart: (workspace: Workspace, destination: ConversationDestination) => void;
}): Promise<
	| Extract<WorkspaceRouteResult, { kind: "candidates" }>
	| {
			kind: "sent";
			workspace: Workspace;
			sessionId: string;
			disposition: "queued" | "started";
			continued: boolean;
			title?: string;
	  }
> {
	let destination: ConversationDestination;
	if (input.destination.kind === "auto") {
		const route = await command<WorkspaceRouteResult>("/api/workspaces/route", {
			text: input.text,
			attachments: input.attachments.map(({ name, mimeType }) => ({ name, mimeType })),
		});
		if (route.kind === "candidates") return route;
		destination = route.destination;
	} else destination = input.destination;
	const workspace = input.workspaces.find((entry) => entry.workspaceId === destination.workspaceId);
	if (!workspace) throw new Error("選択したワークスペースが見つかりません。画面を再読み込みしてください。");
	input.beforeStart(workspace, destination);
	let sessionId: string;
	let title: string | undefined;
	if (destination.kind === "session") {
		const existing = await api<SessionDetail>(`/api/sessions/${encodeURIComponent(destination.sessionId)}`);
		if (existing.sessionId !== destination.sessionId || existing.workspaceId !== workspace.workspaceId)
			throw new Error("選択した会話が見つかりません。候補を選び直してください。");
		if (!canContinueSession(existing))
			throw new Error("選択した会話は続行できません。実行状況を確認し、候補を選び直してください。");
		sessionId = existing.sessionId;
		title = existing.title ?? "無題の会話";
	} else {
		if (!input.model) throw new Error("送信するモデルを選択してください。");
		const created = await command<{ sessionId: string }>("/api/sessions", {
			workspaceId: workspace.workspaceId,
			model: { provider: input.model.provider, id: input.model.id },
			...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		});
		sessionId = created.sessionId;
	}
	const { disposition } = await command<{ disposition: "queued" | "started" }>(
		`/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
		{
			text: input.text,
			mode: "prompt",
			...(input.attachments.length ? { attachments: input.attachments } : {}),
		},
	);
	return { kind: "sent", workspace, sessionId, disposition, continued: destination.kind === "session", title };
}
