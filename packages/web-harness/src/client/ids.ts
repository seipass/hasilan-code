let nextId = 0;

/** UI request and subscription IDs need page-local uniqueness, not secure-context UUIDs. */
export function nextClientId(): string {
	nextId += 1;
	return `c${nextId}`;
}
