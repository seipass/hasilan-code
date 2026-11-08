export interface FileDraft {
	text: string;
	saved: string;
	revision: string;
	newline: "\n" | "\r\n";
}

const drafts = new Map<string, FileDraft>();
const listeners = new Map<string, Set<(draft: FileDraft) => void>>();
const dirtyListeners = new Set<() => void>();
let dirtyVersion = 0;

export function draftKey(workspaceId: string, path: string): string {
	return JSON.stringify([workspaceId, path]);
}

function notifyDirty(): void {
	dirtyVersion++;
	for (const listener of dirtyListeners) listener();
}

export function getDraft(key: string): FileDraft | undefined {
	return drafts.get(key);
}

export function setDraft(key: string, draft: FileDraft): void {
	const previous = drafts.get(key);
	if (previous?.text === draft.text && previous.saved === draft.saved && previous.revision === draft.revision) return;
	if (draft.text === draft.saved && !listeners.has(key)) drafts.delete(key);
	else drafts.set(key, draft);
	for (const listener of listeners.get(key) ?? []) listener(draft);
	if ((previous?.text !== previous?.saved) !== (draft.text !== draft.saved)) notifyDirty();
}

export function subscribeDraft(key: string, listener: (draft: FileDraft) => void): () => void {
	const group = listeners.get(key) ?? new Set<(draft: FileDraft) => void>();
	group.add(listener);
	listeners.set(key, group);
	return () => {
		group.delete(listener);
		if (!group.size) {
			listeners.delete(key);
			// Closed clean files can be read again. Unsaved text must survive workspace changes.
			if (!isDraftDirty(key)) drafts.delete(key);
		}
	};
}

/** True while a tab holds edits that differ from the last read or saved content. */
export function isDraftDirty(key: string): boolean {
	const draft = drafts.get(key);
	return !!draft && draft.text !== draft.saved;
}

export function anyDraftDirty(): boolean {
	return [...drafts.values()].some((draft) => draft.text !== draft.saved);
}

/** Drop the in-memory draft so the next open reads the file again from disk. */
export function discardDraft(key: string): void {
	const previous = drafts.get(key);
	if (!previous) return;
	drafts.delete(key);
	if (previous.text !== previous.saved) notifyDirty();
}

export function subscribeDraftStatus(listener: () => void): () => void {
	dirtyListeners.add(listener);
	return () => {
		dirtyListeners.delete(listener);
	};
}

/** Snapshot identity for useSyncExternalStore; changes only when a draft becomes dirty or clean. */
export function draftStatusVersion(): number {
	return dirtyVersion;
}
