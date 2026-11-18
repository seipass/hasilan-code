import type { ToolDefinition } from "@hasilan-code/pi-coding-agent";
import type { SessionDescriptor } from "../session-registry.ts";

export interface ToolSession {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly cwd: string;
	readonly isolated?: boolean;
	readonly selectedTools?: readonly string[];
}

export type ToolFactory = (session: ToolSession) => readonly ToolDefinition[];
export type RuntimeContextFactory = (session: ToolSession) => readonly string[];

export function pluginSession(descriptor: SessionDescriptor): ToolSession {
	return {
		sessionId: descriptor.sessionId,
		workspaceId: descriptor.workspaceId,
		cwd: descriptor.cwd,
		isolated: !!descriptor.worktree,
		selectedTools: descriptor.tools?.slice(),
	};
}
