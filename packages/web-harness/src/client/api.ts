export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		credentials: "same-origin",
		headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
	});
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			const body: unknown = await response.json();
			if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string")
				message = body.error;
		} catch {
			// Non-JSON transport errors still retain the HTTP status.
		}
		throw new ApiError(response.status, message);
	}
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export function command<T>(path: string, body: unknown, method = "POST"): Promise<T> {
	return api<T>(path, { method, body: JSON.stringify(body) });
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function websocketUrl(path: string): string {
	const url = new URL(path, window.location.href);
	url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}
