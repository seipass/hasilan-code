import type { ComponentType } from "react";
import type { IconName } from "../Icon.tsx";

export interface WorkspacePanelProps {
	workspaceId?: string;
	opened: boolean;
	onDraft: (text: string) => void;
	onDirtyChange: (dirty: boolean) => void;
}

export interface WorkspacePanel {
	id: string;
	title: string;
	icon: IconName;
	View: ComponentType<WorkspacePanelProps>;
}
