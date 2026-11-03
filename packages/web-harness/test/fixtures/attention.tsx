import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useAttention } from "../../src/client/attention.ts";
import type { SessionSummary } from "../../src/client/types.ts";

function session(title: string, status?: "running" | "completed" | "failed"): SessionSummary {
	return {
		sessionId: title, title, workspaceId: "w", cwd: "/w", materialized: true, availability: "ready",
		pendingInput: [],
		...(status === "running" ? { currentRun: { runId: `r-${title}`, agentId: "a", task: title, status: "running" } } : {}),
		...(status && status !== "running" ? { latestRun: { runId: `r-${title}`, agentId: "a", task: title, status, settledAt: new Date().toISOString() } } : {}),
	};
}

function Fixture() {
	const [first, setFirst] = useState<"running" | "completed">("running");
	const [second, setSecond] = useState<"running" | "completed">("completed");
	const [notifications, setNotifications] = useState(false);
	const sessions = [session("first", first), session("second", second)];
	useAttention({ sessions, selectedSessionId: "second", selectedTitle: "first", notificationsEnabled: notifications, onSelect: () => {} });
	return <>
		<button type="button" onClick={() => setFirst((value) => value === "running" ? "completed" : "running")}>toggle first</button>
		<button type="button" onClick={() => setSecond((value) => value === "running" ? "completed" : "running")}>toggle second</button>
		<button type="button" onClick={() => setNotifications((value) => !value)}>toggle notifications</button>
		<output data-testid="title">{document.title}</output>
		<output data-testid="favicon">{document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? ""}</output>
	</>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
