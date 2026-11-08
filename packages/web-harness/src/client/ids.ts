let nextId = 0;
const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Persisted tab IDs must also remain distinct after a reload; these are not security tokens. */
export function nextClientId(): string {
	nextId += 1;
	return `c${pageId}-${nextId}`;
}
