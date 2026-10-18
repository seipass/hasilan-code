import type { AuthType, ModelAuth } from "./auth/types.ts";

/** Account-wide limits reported by a provider, independent of local conversation usage. */
export interface AccountUsageMetric {
	id: string;
	label: string;
	unit?: string;
	used?: number;
	limit?: number;
	remaining?: number;
	usedPercent?: number;
	unlimited?: boolean;
	/** Unix milliseconds. */
	resetsAt?: number;
}

export interface AccountUsage {
	account?: string;
	plan?: string;
	metrics: AccountUsageMetric[];
	notices?: string[];
}

export interface AccountUsageContext {
	auth: ModelAuth;
	authType: AuthType;
	signal: AbortSignal;
	fetch?: typeof fetch;
}

/** Undefined means this authentication method does not expose account usage. */
export type AccountUsageReader = (context: AccountUsageContext) => Promise<AccountUsage | undefined>;

/** Only deliberately public errors may be included in the settings response. */
export class AccountUsageError extends Error {}
