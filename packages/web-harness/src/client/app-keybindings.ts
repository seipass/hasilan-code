export const DEFAULT_APP_KEYBINDINGS = {
	"composer.send": ["ctrl+enter", "meta+enter"],
	"composer.routeWorkspace": ["ctrl+shift+enter", "meta+shift+enter"],
} as const;
export type AppKeybinding = keyof typeof DEFAULT_APP_KEYBINDINGS;
type KeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/** Browser-specific overrides are stored as action-to-key arrays in pi-web-keybindings. */
export function matchesAppKeybinding(event: KeyEvent, action: AppKeybinding): boolean {
	let keys: readonly string[] = DEFAULT_APP_KEYBINDINGS[action];
	try {
		const config: unknown = JSON.parse(localStorage.getItem("pi-web-keybindings") ?? "{}");
		if (config && typeof config === "object" && action in config) {
			const configured = Reflect.get(config, action) as unknown;
			if (Array.isArray(configured) && configured.every((value: unknown) => typeof value === "string"))
				keys = configured;
		}
	} catch {
		/* Defaults remain usable without browser storage. */
	}
	return keys.some((binding) => {
		const parts = binding.toLowerCase().split("+");
		return (
			parts.at(-1) === event.key.toLowerCase() &&
			parts.includes("ctrl") === event.ctrlKey &&
			parts.includes("meta") === event.metaKey &&
			parts.includes("shift") === event.shiftKey &&
			parts.includes("alt") === event.altKey
		);
	});
}
