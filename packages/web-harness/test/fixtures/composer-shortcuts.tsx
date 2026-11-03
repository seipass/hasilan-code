import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ComposerDestination } from "../../src/shared/workspace-routing.ts";
import { ChatPane } from "../../src/client/ChatPane.tsx";
import type { SessionDetail } from "../../src/client/types.ts";

function Fixture() {
	const [busy, setBusy] = useState(false);
	const [sent, setSent] = useState<{ text: string; mode: string; destination?: ComposerDestination }[]>([]);
	const session: SessionDetail | undefined = busy ? {
		sessionId: "session", workspaceId: "workspace", cwd: "/workspace", materialized: true,
		availability: "ready", messages: [], toolCalls: [], pendingInput: [], activity: {},
		currentRun: { runId: "run", agentId: "agent", task: "working", status: "running" },
	} : undefined;
	return <>
		<button type="button" onClick={() => setBusy((value) => !value)}>Toggle busy</button>
		<pre data-testid="sent">{JSON.stringify(sent)}</pre>
		<ChatPane session={session} connected draftKey="fixture" modelControl={null} goalControl={null}
			onDraftInserted={() => {}} onPendingInputAction={async () => {}} onFile={() => {}} onStop={() => {}}
			onParent={() => {}} onModelSelect={() => {}} onProviderSettings={() => {}}
			onSend={async (text, mode, _attachments, destination) => {
				setSent((current) => [...current, { text, mode, destination }]);
				return destination?.kind === "auto" ? { destinationCandidates: [{ kind: "new", workspaceId: "workspace", name: "workspace", path: "/workspace", probability: 1 }] } : {};
			}} />
	</>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
