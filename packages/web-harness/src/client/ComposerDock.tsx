import type { ReactNode } from "react";
import "./ComposerDock.css";

export function ComposerDock({ children }: { children?: ReactNode }) {
	if (!children) return null;
	return <div className="composer-dock">{children}</div>;
}
