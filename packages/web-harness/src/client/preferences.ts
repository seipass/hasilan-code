import { type Dispatch, type SetStateAction, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { type UiPreferencesSnapshot, validUiPreference } from "../shared/ui-preferences.ts";
import { api, errorMessage } from "./api.ts";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Synchronous UI cache with serialized, debounced writes to the shared agent profile. */
export class PreferenceStorage {
	private readonly request: Request;
	private values = new Map<string, string | null>();
	private readonly pending = new Map<string, string | null>();
	private readonly listeners = new Map<string, Set<() => void>>();
	private attachmentVersions: Record<string, string> = {};
	private readonly loads = new Map<string, Promise<void>>();
	private readonly loaded = new Set<string>();
	private readonly keyGenerations = new Map<string, number>();
	private revision = "";
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private writing: Promise<void> | undefined;
	private syncing: Promise<void> | undefined;
	private error: string | null = null;
	private readonly statusListeners = new Set<() => void>();

	constructor(request: Request = api) {
		this.request = request;
	}

	async initialize(legacy?: Storage): Promise<void> {
		const snapshot = await this.request<UiPreferencesSnapshot>("/api/ui-preferences");
		// Import only absent keys; shared values and deletion tombstones always take precedence.
		if (legacy) {
			const entries: { key: string; value: string }[] = [];
			try {
				for (let index = 0; index < legacy.length; index++) {
					const key = legacy.key(index);
					if (!key || Object.hasOwn(snapshot.values, key)) continue;
					const value = legacy.getItem(key);
					if (value !== null && validUiPreference(key, value)) entries.push({ key, value });
				}
			} catch {
				/* A browser may disable local storage; the shared profile still works. */
			}
			for (const entry of entries)
				await this.request("/api/ui-preferences", {
					method: "PATCH",
					body: JSON.stringify({ entries: [{ ...entry, onlyIfMissing: true }] }),
				});
			if (entries.length) {
				this.apply(await this.request<UiPreferencesSnapshot>("/api/ui-preferences"));
				return;
			}
		}
		this.apply(snapshot);
	}

	getItem = (key: string): string | null => this.values.get(key) ?? null;
	setItem = (key: string, value: string): void => {
		this.change(key, value);
	};
	removeItem = (key: string): void => {
		this.change(key, null);
	};
	subscribe = (key: string, listener: () => void): (() => void) => {
		const group = this.listeners.get(key) ?? new Set();
		group.add(listener);
		this.listeners.set(key, group);
		return () => {
			group.delete(listener);
			if (!group.size) this.listeners.delete(key);
		};
	};
	subscribeStatus = (listener: () => void): (() => void) => {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	};
	getError = (): string | null => this.error;

	private change(key: string, value: string | null): void {
		if (!validUiPreference(key, value)) throw new Error("保存できる設定・下書きのサイズを超えています。");
		if (this.values.has(key) && this.getItem(key) === value) return;
		this.values.set(key, value);
		this.pending.set(key, value);
		this.emit(key);
		this.generation++;
		this.keyGenerations.set(key, this.generation);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.flush().catch(() => undefined);
		}, 250);
	}

	flush = (): Promise<void> => {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.writing) return this.writing;
		this.writing = (async () => {
			while (this.pending.size) {
				const entries: { key: string; value: string | null }[] = [];
				let bytes = 0;
				for (const [key, value] of this.pending) {
					const size = new Blob([JSON.stringify({ key, value })]).size;
					if (entries.length && bytes + size > 50_000) break;
					entries.push({ key, value });
					bytes += size;
					if (bytes > 50_000 || entries.length === 128) break;
				}
				const body = JSON.stringify({ entries });
				await this.request("/api/ui-preferences", {
					method: "PATCH",
					body,
					keepalive: new Blob([body]).size < 60_000,
				});
				for (const { key, value } of entries) if (this.pending.get(key) === value) this.pending.delete(key);
			}
			this.setError(null);
		})()
			.catch((reason: unknown) => {
				this.setError(`設定・下書きを保存できません: ${errorMessage(reason)}`);
				this.timer = setTimeout(() => {
					void this.flush().catch(() => undefined);
				}, 3000);
				throw reason;
			})
			.finally(() => {
				this.writing = undefined;
			});
		return this.writing;
	};

	/** Attachment base64 stays out of startup snapshots and browser localStorage. */
	load(key: string): Promise<void> {
		this.loaded.add(key);
		if (this.values.has(key)) return Promise.resolve();
		const existing = this.loads.get(key);
		if (existing) return existing;
		const generation = this.keyGenerations.get(key);
		const operation = this.request<{ value: string | null }>(`/api/ui-preferences?key=${encodeURIComponent(key)}`)
			.then(({ value }) => {
				if (!this.pending.has(key) && generation === this.keyGenerations.get(key)) {
					this.values.set(key, value);
					this.emit(key);
				}
			})
			.finally(() => {
				this.loads.delete(key);
			});
		this.loads.set(key, operation);
		return operation;
	}

	sync(): Promise<void> {
		if (this.syncing) return this.syncing;
		if (this.writing || this.pending.size) return Promise.resolve();
		const generation = this.generation;
		this.syncing = this.request<UiPreferencesSnapshot | null>(
			`/api/ui-preferences?since=${encodeURIComponent(this.revision)}`,
		)
			.then(async (snapshot) => {
				if (!snapshot || generation !== this.generation) return;
				const changedAttachments = Object.keys(snapshot.attachments).filter(
					(key) =>
						(this.loaded.has(key) || this.values.has(key)) &&
						this.attachmentVersions[key] !== snapshot.attachments[key] &&
						!this.pending.has(key),
				);
				const previousVersions = this.attachmentVersions;
				this.apply(snapshot);
				try {
					for (const key of changedAttachments) {
						if (this.pending.has(key)) continue;
						this.values.delete(key);
						await this.load(key);
					}
				} catch (reason) {
					this.attachmentVersions = previousVersions;
					this.revision = "";
					throw reason;
				}
			})
			.finally(() => {
				this.syncing = undefined;
			});
		return this.syncing;
	}

	private apply(snapshot: UiPreferencesSnapshot): void {
		this.revision = snapshot.revision;
		this.attachmentVersions = snapshot.attachments;
		for (const [key, value] of Object.entries(snapshot.values)) {
			if (this.pending.has(key) || this.values.get(key) === value) continue;
			this.values.set(key, value);
			this.emit(key);
		}
	}
	private emit(key: string): void {
		for (const listener of this.listeners.get(key) ?? []) listener();
	}
	private setError(error: string | null): void {
		this.error = error;
		for (const listener of this.statusListeners) listener();
	}
}

export const preferences = new PreferenceStorage();

export function usePreferenceString(key: string): string | null {
	const subscribe = useCallback((listener: () => void) => preferences.subscribe(key, listener), [key]);
	const snapshot = useCallback(() => preferences.getItem(key), [key]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function usePreferenceState<T>(
	key: string,
	fallback: T | (() => T),
	parse?: (raw: string | null) => T,
): [T, Dispatch<SetStateAction<T>>] {
	const initial = useRef<{ value: T } | null>(null);
	if (!initial.current)
		initial.current = { value: typeof fallback === "function" ? (fallback as () => T)() : fallback };
	const defaultValue = initial.current.value;
	const raw = usePreferenceString(key);
	const read = useCallback(
		(stored: string | null): T => {
			if (parse) return parse(stored);
			try {
				return stored === null ? defaultValue : (JSON.parse(stored) as T);
			} catch {
				return defaultValue;
			}
		},
		[defaultValue, parse],
	);
	const value = useMemo(() => read(raw), [raw, read]);
	const setValue: Dispatch<SetStateAction<T>> = useCallback(
		(next) => {
			const value = typeof next === "function" ? (next as (previous: T) => T)(read(preferences.getItem(key))) : next;
			preferences.setItem(key, JSON.stringify(value));
		},
		[key, read],
	);
	return [value, setValue];
}

export function usePreferenceText(key: string): [string, Dispatch<SetStateAction<string>>] {
	const value = usePreferenceString(key) ?? "";
	const setValue: Dispatch<SetStateAction<string>> = useCallback(
		(next) => {
			const value = typeof next === "function" ? next(preferences.getItem(key) ?? "") : next;
			if (value) preferences.setItem(key, value);
			else preferences.removeItem(key);
		},
		[key],
	);
	return [value, setValue];
}
