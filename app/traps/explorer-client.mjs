/**
 * A deliberately slow, deliberately cached client for the Lichess opening
 * explorer.
 *
 * The explorer answers the one question this extension cannot answer offline:
 * *what do humans at this rating actually play here?* One request returns the
 * aggregated move distribution over millions of games, so finding traps costs a
 * handful of requests rather than a scrape of anybody's game archive.
 *
 * Lichess pays for that aggregation, and in early 2026 the explorer was taken
 * down by request floods and put behind authentication as a result. So this
 * client is built to be a good citizen first and fast second:
 *
 * - **One request in flight, ever.** Every call joins a single promise chain.
 * - **A floor on the gap between requests** (`minIntervalMs`), because the
 *   explorer's own documentation asks for one request at a time and the polite
 *   reading of that is "not as fast as the network allows".
 * - **A 429 stops the run.** Lichess asks for a full minute of silence after a
 *   429; this client records the cooldown, refuses to send anything until it
 *   expires, and throws instead of retrying. Re-running later is nearly free
 *   because of the cache, so there is no reason to push.
 * - **Smallest useful response.** `topGames`/`recentGames` are pinned to 0: game
 *   references are the expensive part of the response and the trap search never
 *   looks at them.
 * - **Everything is cached**, in memory and on disk, keyed by position. A second
 *   search over the same opening sends no requests at all.
 */

/** Rating buckets the explorer accepts; anything else is a 400. */
export const RATING_BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

/** Time controls the explorer accepts. */
export const SPEEDS = ["ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence"];

export const EXPLORER_ENDPOINT = "https://explorer.lichess.org/lichess";

/** Lichess asks for a full minute of quiet after a 429. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

export class ExplorerAuthError extends Error {
	constructor(message) {
		super(message);
		this.name = "ExplorerAuthError";
	}
}

export class ExplorerRateLimitError extends Error {
	constructor(message, retryAtMs) {
		super(message);
		this.name = "ExplorerRateLimitError";
		this.retryAtMs = retryAtMs;
	}
}

export class ExplorerHttpError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "ExplorerHttpError";
		this.status = status;
	}
}

/**
 * The explorer keys statistics by position, and the halfmove clock and move
 * number are not part of a position in that sense. Dropping them means a line
 * reached by transposition hits the same cache entry.
 */
export function positionKey(fen) {
	const parts = String(fen || "").trim().split(/\s+/);
	return parts.slice(0, 4).join(" ");
}

export function normalizeRatings(ratings) {
	const wanted = Array.isArray(ratings) ? ratings : [ratings];
	const valid = wanted
		.map((value) => Number(value))
		.filter((value) => RATING_BUCKETS.includes(value));
	const unique = [...new Set(valid)].sort((a, b) => a - b);
	return unique.length ? unique : [1600, 1800];
}

export function normalizeSpeeds(speeds) {
	const wanted = Array.isArray(speeds) ? speeds : [speeds];
	const valid = wanted.filter((value) => SPEEDS.includes(value));
	const unique = [...new Set(valid)];
	return unique.length ? unique : ["blitz", "rapid"];
}

/**
 * Rating buckets are lower bounds: picking 1600 means "1600-1799". A player's
 * own rating should therefore pull in the bucket they are in plus its
 * neighbours, so the sample covers the opponents they actually meet.
 */
export function bucketsAroundRating(elo, spread = 1) {
	const rating = Number(elo);
	if (!Number.isFinite(rating)) {
		return [1600, 1800];
	}

	let index = 0;
	for (let i = 0; i < RATING_BUCKETS.length; i += 1) {
		if (rating >= RATING_BUCKETS[i]) {
			index = i;
		}
	}

	const from = Math.max(0, index - spread);
	const to = Math.min(RATING_BUCKETS.length - 1, index + spread);
	return RATING_BUCKETS.slice(from, to + 1);
}

function buildQuery({ fen, ratings, speeds, since, until, moves }) {
	const params = new URLSearchParams();
	params.set("variant", "standard");
	params.set("fen", fen);
	params.set("ratings", ratings.join(","));
	params.set("speeds", speeds.join(","));
	params.set("moves", String(moves));
	// Game references are the expensive half of the response and the trap search
	// never reads them.
	params.set("topGames", "0");
	params.set("recentGames", "0");
	if (since) {
		params.set("since", since);
	}
	if (until) {
		params.set("until", until);
	}
	return params.toString();
}

/**
 * Keeps only what the search uses. The raw response carries opening names and
 * per-move average ratings that would triple the size of the on-disk cache.
 */
export function summarizeExplorerResponse(payload) {
	const white = Number(payload?.white) || 0;
	const draws = Number(payload?.draws) || 0;
	const black = Number(payload?.black) || 0;
	const total = white + draws + black;

	const rawMoves = Array.isArray(payload?.moves) ? payload.moves : [];
	const moves = rawMoves.map((move) => {
		const moveWhite = Number(move?.white) || 0;
		const moveDraws = Number(move?.draws) || 0;
		const moveBlack = Number(move?.black) || 0;
		const moveTotal = moveWhite + moveDraws + moveBlack;
		return {
			uci: move?.uci || "",
			san: move?.san || "",
			white: moveWhite,
			draws: moveDraws,
			black: moveBlack,
			total: moveTotal,
			// Share of the games played from this position that continued with
			// this move — the measure of how tempting it is.
			share: total > 0 ? moveTotal / total : 0,
		};
	}).filter((move) => move.uci && move.total > 0);

	return {
		white,
		draws,
		black,
		total,
		moves,
		opening: payload?.opening ? { eco: payload.opening.eco || "", name: payload.opening.name || "" } : null,
	};
}

/** Empirical score of `color` in a set of explorer counts, as 0..1. */
export function empiricalScore({ white, draws, black }, color) {
	const total = (white || 0) + (draws || 0) + (black || 0);
	if (!total) {
		return null;
	}
	const wins = color === "w" ? white : black;
	return (wins + draws / 2) / total;
}

export class LichessExplorerClient {
	/**
	 * @param {object} deps
	 * @param {typeof fetch} deps.fetchImpl
	 * @param {() => string} deps.getToken reads the token at call time so a
	 *   token pasted into settings takes effect without a rebuild
	 * @param {object} deps.cache anything with async get(key)/set(key, value)
	 * @param {number} deps.minIntervalMs floor on the gap between two requests
	 */
	constructor({
		fetchImpl,
		getToken = () => "",
		cache = null,
		minIntervalMs = 1200,
		endpoint = EXPLORER_ENDPOINT,
		now = () => Date.now(),
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		logger = () => {},
	} = {}) {
		this.fetchImpl = fetchImpl;
		this.getToken = getToken;
		this.cache = cache;
		this.minIntervalMs = Math.max(0, minIntervalMs);
		this.endpoint = endpoint;
		this.now = now;
		this.sleep = sleep;
		this.logger = logger;

		this.requestsMade = 0;
		this.cacheHits = 0;
		this.cooldownUntilMs = 0;
		this.lastRequestAtMs = 0;
		// Every network call appends to this chain, so exactly one is ever
		// in flight regardless of how many callers are waiting.
		this.chain = Promise.resolve();
	}

	get rateLimitedUntilMs() {
		return this.cooldownUntilMs;
	}

	hasToken() {
		return Boolean(String(this.getToken() || "").trim());
	}

	/**
	 * Looks the position up, preferring the cache. Returns the summarized shape
	 * plus `{ fromCache }`.
	 */
	async lookup({ fen, ratings, speeds, since = null, until = null, moves = 12, signal = null } = {}) {
		const safeRatings = normalizeRatings(ratings);
		const safeSpeeds = normalizeSpeeds(speeds);
		const key = [
			positionKey(fen),
			safeRatings.join("."),
			safeSpeeds.join("."),
			since || "-",
			until || "-",
			moves,
		].join("|");

		const cached = await this.readCache(key);
		if (cached) {
			this.cacheHits += 1;
			return { ...cached, fromCache: true };
		}

		const summary = await this.enqueue(() =>
			this.request({ fen, ratings: safeRatings, speeds: safeSpeeds, since, until, moves, signal }),
		);
		await this.writeCache(key, summary);
		return { ...summary, fromCache: false };
	}

	async readCache(key) {
		if (!this.cache) {
			return null;
		}
		try {
			return (await this.cache.get(key)) || null;
		} catch {
			return null;
		}
	}

	async writeCache(key, value) {
		if (!this.cache) {
			return;
		}
		try {
			await this.cache.set(key, value);
		} catch {
			// A full or unavailable cache must not fail the search.
		}
	}

	/** Serializes every network call onto one chain. */
	enqueue(task) {
		const run = this.chain.then(task);
		// The chain itself is kept permanently settled, so one failed request
		// neither breaks the queue for the next caller nor surfaces as an
		// unhandled rejection while the real caller handles `run`.
		this.chain = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	async request({ fen, ratings, speeds, since, until, moves, signal }) {
		const token = String(this.getToken() || "").trim();
		if (!token) {
			throw new ExplorerAuthError(
				"The Lichess opening explorer needs an API token. Create one at lichess.org/account/oauth/token (no scopes needed) and paste it into Trap finder settings.",
			);
		}

		const remainingCooldown = this.cooldownUntilMs - this.now();
		if (remainingCooldown > 0) {
			throw new ExplorerRateLimitError(
				`Lichess asked us to slow down. Waiting ${Math.ceil(remainingCooldown / 1000)}s before any further requests.`,
				this.cooldownUntilMs,
			);
		}

		const sinceLast = this.now() - this.lastRequestAtMs;
		if (sinceLast < this.minIntervalMs) {
			await this.sleep(this.minIntervalMs - sinceLast);
		}
		if (signal?.aborted) {
			throw new DOMException("Trap search canceled.", "AbortError");
		}

		const url = `${this.endpoint}?${buildQuery({ fen, ratings, speeds, since, until, moves })}`;
		this.lastRequestAtMs = this.now();
		this.requestsMade += 1;

		let response = null;
		try {
			response = await this.fetchImpl(url, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
				signal,
			});
		} catch (error) {
			if (error?.name === "AbortError") {
				throw error;
			}
			throw new ExplorerHttpError(`Could not reach the Lichess explorer: ${error?.message || error}`, 0);
		}

		if (response.status === 429) {
			const retryAfterSeconds = Number(response.headers?.get?.("Retry-After"));
			const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
				? Math.max(retryAfterSeconds * 1000, RATE_LIMIT_COOLDOWN_MS)
				: RATE_LIMIT_COOLDOWN_MS;
			this.cooldownUntilMs = this.now() + waitMs;
			this.logger("Explorer rate limited", { waitMs });
			throw new ExplorerRateLimitError(
				`Lichess rate limited the explorer. Pausing for ${Math.ceil(waitMs / 1000)}s — cached positions still work, and re-running later resumes where this left off.`,
				this.cooldownUntilMs,
			);
		}

		if (response.status === 401 || response.status === 403) {
			throw new ExplorerAuthError(
				"Lichess rejected the API token. Check it at lichess.org/account/oauth/token — the explorer needs a valid token, but no scopes.",
			);
		}

		if (!response.ok) {
			throw new ExplorerHttpError(`Lichess explorer returned HTTP ${response.status}.`, response.status);
		}

		return summarizeExplorerResponse(await response.json());
	}
}
