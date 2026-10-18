import type { AuthEvent } from "@hasilan-code/pi-ai";

export interface AuthLoginPrompt {
	id: string;
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: readonly { id: string; label: string; description?: string }[];
}

/** Login interaction only. Never carries credentials or entered prompt values. */
export interface AuthLoginView {
	loginId: string;
	provider: string;
	status: "pending" | "completed" | "failed" | "cancelled";
	events: AuthEvent[];
	prompt?: AuthLoginPrompt;
	error?: string;
}
