/** Two folders with the same name are common; add the parent when the basename is ambiguous. */
export function workspaceLabel(path: string, all: readonly string[]): string {
	const split = /[\\/]/;
	const parts = path.split(split).filter(Boolean);
	const base = parts.at(-1) ?? path;
	const parent = parts.at(-2);
	const ambiguous = all.filter((other) => (other.split(split).filter(Boolean).at(-1) ?? other) === base).length > 1;
	return ambiguous && parent ? `${parent}/${base}` : base;
}
