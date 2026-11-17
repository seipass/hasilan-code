import { useState } from "react";
import { CanvasPane } from "../CanvasPane.tsx";
import { Select } from "../Select.tsx";
import { usePluginProfile } from "./profile.tsx";
import type { WorkspacePanel, WorkspacePanelProps } from "./workspace-panels.ts";

function CanvasView({ workspaceId, opened, onDraft, onDirtyChange }: WorkspacePanelProps) {
	const [chosenDestination, setDestination] = useState<"chat" | "swarm">("chat");
	const swarmEnabled = usePluginProfile()?.activeIds.includes("hyakki") ?? false;
	const destination = swarmEnabled ? chosenDestination : "chat";
	if (!workspaceId || !opened) return null;
	return <CanvasPane
		key={workspaceId}
		workspaceId={workspaceId}
		destinationControl={<label className="canvas-destination">
			<span className="sr-only">入力欄に追加する設計の送信先</span>
			<Select aria-label="入力欄に追加する設計の送信先" value={destination} onChange={(value) => setDestination(value === "swarm" ? "swarm" : "chat")}>
				<option value="chat">会話</option>
				{swarmEnabled && <option value="swarm">Hyakki-Yako</option>}
			</Select>
		</label>}
		onComposeDesign={(path) => {
			const text = `設計ファイル ${JSON.stringify(path)} を読み、内容に沿って進めてください。`;
			onDraft(destination === "swarm" ? `/hyakki ${text}` : text);
		}}
		onDirtyChange={onDirtyChange}
	/>;
}

export const canvasPanel = {
	id: "canvas",
	title: "設計キャンバス",
	icon: "graph",
	View: CanvasView,
} as const satisfies WorkspacePanel;
