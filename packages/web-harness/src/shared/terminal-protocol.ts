export interface TerminalSummary {
	terminalId: string;
	workspaceId: string;
	generation: string;
	cols: number;
	rows: number;
	status: "running" | "exited";
	exitCode?: number;
	signal?: number;
	windowsPty?: { backend: "conpty"; buildNumber: number };
}

export type TerminalStreamEvent =
	| { type: "data"; generation: string; seq: number; data: string }
	| { type: "resized"; generation: string; seq: number; cols: number; rows: number }
	| { type: "exit"; generation: string; seq: number; exitCode: number; signal?: number };

export type TerminalServerMessage =
	| TerminalStreamEvent
	| (TerminalSummary & { type: "snapshot"; seq: number; vt: string })
	| { type: "control"; controller: boolean }
	| { type: "error"; message: string };

export type TerminalClientMessage =
	| { type: "ack"; generation: string; seq: number }
	| { type: "take_control" }
	| { type: "input"; generation: string; data: string }
	| { type: "binary"; generation: string; data: string }
	| { type: "resize"; generation: string; cols: number; rows: number };
