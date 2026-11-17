export interface ExternalPanelEntry {
	id: string;
	title: string;
}

export interface PluginProfile {
	activeIds: string[];
	panels: ExternalPanelEntry[];
}
