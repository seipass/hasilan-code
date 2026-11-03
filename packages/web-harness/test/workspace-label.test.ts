import { expect, it } from "vitest";
import { workspaceLabel } from "../src/client/workspace-label.ts";

// Two checkouts of the same project name must stay distinguishable in the sidebar.
it("shows the basename, adding the parent only when the name collides", () => {
	const backslash = String.fromCharCode(92);
	const win = (...parts: string[]) => parts.join(backslash);
	const all = [
		win("C:", "work", "app"),
		win("C:", "work", "app-old"),
		win("C:", "other", "app"),
		win("D:", "projects", "api"),
	];
	expect(workspaceLabel(win("C:", "work", "app-old"), all)).toBe("app-old");
	expect(workspaceLabel(win("C:", "work", "app"), all)).toBe("work/app");
	expect(workspaceLabel(win("C:", "other", "app"), all)).toBe("other/app");
	expect(workspaceLabel(win("D:", "projects", "api"), all)).toBe("api");
	expect(workspaceLabel("/home/u/src/tool", ["/home/u/src/tool"])).toBe("tool");
});
