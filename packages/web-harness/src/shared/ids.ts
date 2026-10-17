/** Allocate within the persisted collection; callers serialize insertion with allocation. */
export function nextId<T>(prefix: string, records: readonly T[], key: keyof T): string {
	let maximum = 0;
	for (const record of records) {
		const id = record[key];
		if (typeof id !== "string" || !id.startsWith(prefix)) continue;
		const suffix = id.slice(prefix.length);
		if (/^[1-9]\d*$/.test(suffix)) maximum = Math.max(maximum, Number(suffix));
	}
	if (!Number.isSafeInteger(maximum + 1)) throw new Error("ID sequence exhausted");
	return `${prefix}${maximum + 1}`;
}
