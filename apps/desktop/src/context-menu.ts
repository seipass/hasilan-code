import { Menu, type WebContents } from "electron";

export function installContextMenu(contents: WebContents, browser: boolean): void {
	contents.on("context-menu", (_event, params) => {
		if (!browser && !params.isEditable && !params.selectionText) return;
		const items: Electron.MenuItemConstructorOptions[] = [];
		if (browser)
			items.push(
				{
					label: "戻る",
					enabled: contents.navigationHistory.canGoBack(),
					click: () => contents.navigationHistory.goBack(),
				},
				{
					label: "進む",
					enabled: contents.navigationHistory.canGoForward(),
					click: () => contents.navigationHistory.goForward(),
				},
				{ label: "再読み込み", click: () => contents.reload() },
				{ type: "separator" },
			);
		if (params.isEditable)
			items.push(
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut", enabled: params.editFlags.canCut },
			);
		items.push({ role: "copy", enabled: params.editFlags.canCopy });
		if (params.isEditable) items.push({ role: "paste", enabled: params.editFlags.canPaste });
		items.push({ role: "selectAll", enabled: params.editFlags.canSelectAll });
		Menu.buildFromTemplate(items).popup({ frame: contents.mainFrame });
	});
}
