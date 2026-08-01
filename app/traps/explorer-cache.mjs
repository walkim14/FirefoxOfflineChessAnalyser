/**
 * A two-tier cache for explorer responses: a Map for this page's lifetime, and
 * `chrome.storage.local` so a search run tomorrow costs no requests.
 *
 * This is the main reason the trap finder is cheap to run repeatedly. Opening
 * statistics move on the scale of months, so entries are good for weeks, and the
 * second search over the same repertoire sends nothing at all.
 *
 * Everything lives under one storage key, written behind a debounce, because
 * `storage.local` round-trips are far more expensive than the objects involved.
 */

const STORAGE_KEY = "trapExplorerCache";
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Summaries are ~1 KB, so this bounds the cache at a couple of megabytes. */
const DEFAULT_MAX_ENTRIES = 1500;
const FLUSH_DEBOUNCE_MS = 2000;

export function createExplorerCache({
	storageGet,
	storageSet,
	ttlMs = DEFAULT_TTL_MS,
	maxEntries = DEFAULT_MAX_ENTRIES,
	now = () => Date.now(),
	setTimeoutImpl = setTimeout,
	clearTimeoutImpl = clearTimeout,
} = {}) {
	/** @type {Map<string, {value: object, storedAt: number}>} */
	const entries = new Map();
	let loaded = false;
	let loading = null;
	let flushHandle = null;
	let dirty = false;

	async function load() {
		if (loaded) {
			return;
		}
		if (!loading) {
			loading = (async () => {
				try {
					const stored = await storageGet(STORAGE_KEY);
					const raw = stored?.[STORAGE_KEY];
					if (raw && typeof raw === "object") {
						for (const [key, entry] of Object.entries(raw)) {
							if (entry && typeof entry === "object" && entry.value) {
								entries.set(key, { value: entry.value, storedAt: Number(entry.storedAt) || 0 });
							}
						}
					}
				} catch {
					// An unreadable cache is an empty cache, not a failure.
				}
				loaded = true;
			})();
		}
		await loading;
	}

	function scheduleFlush() {
		dirty = true;
		if (flushHandle) {
			clearTimeoutImpl(flushHandle);
		}
		flushHandle = setTimeoutImpl(() => {
			flushHandle = null;
			flush().catch(() => {});
		}, FLUSH_DEBOUNCE_MS);
	}

	async function flush() {
		if (!dirty) {
			return;
		}
		dirty = false;
		const payload = {};
		for (const [key, entry] of entries) {
			payload[key] = entry;
		}
		try {
			await storageSet({ [STORAGE_KEY]: payload });
		} catch {
			// Storage pressure should not break an in-progress search; the memory
			// tier still serves this session.
		}
	}

	/** Drops expired entries first, then the oldest, until the cap is met. */
	function prune() {
		const cutoff = now() - ttlMs;
		for (const [key, entry] of entries) {
			if (entry.storedAt < cutoff) {
				entries.delete(key);
			}
		}

		if (entries.size <= maxEntries) {
			return;
		}
		const byAge = [...entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
		const excess = entries.size - maxEntries;
		for (let i = 0; i < excess; i += 1) {
			entries.delete(byAge[i][0]);
		}
	}

	return {
		async get(key) {
			await load();
			const entry = entries.get(key);
			if (!entry) {
				return null;
			}
			if (entry.storedAt < now() - ttlMs) {
				entries.delete(key);
				return null;
			}
			return entry.value;
		},

		async set(key, value) {
			await load();
			entries.set(key, { value, storedAt: now() });
			prune();
			scheduleFlush();
		},

		async clear() {
			entries.clear();
			loaded = true;
			dirty = true;
			if (flushHandle) {
				clearTimeoutImpl(flushHandle);
				flushHandle = null;
			}
			await flush();
		},

		/** Writes any pending changes immediately. */
		flush,

		get size() {
			return entries.size;
		},
	};
}
