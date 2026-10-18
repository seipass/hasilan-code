import type { AccountUsage } from "@hasilan-code/pi-ai";

export interface ProviderAccountUsageView {
	provider: string;
	name: string;
	status: "ok" | "unsupported" | "error";
	checkedAt: number;
	usage?: AccountUsage;
	error?: string;
}
