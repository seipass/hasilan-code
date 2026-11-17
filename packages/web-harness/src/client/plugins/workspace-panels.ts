import type { ComponentType } from "react";

export interface WorkspacePanelProps {
	workspaceId?: string;
	opened: boolean;
	onDraft: (text: string) => void;
	onDirtyChange: (dirty: boolean) => void;
}

export interface WorkspacePanel {
	id: string;
	title: string;
	View: ComponentType<WorkspacePanelProps>;
}
