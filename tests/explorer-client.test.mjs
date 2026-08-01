import test from "node:test";
import assert from "node:assert/strict";
import {
	bucketsAroundRating,
	empiricalScore,
	ExplorerAuthError,
	ExplorerRateLimitError,
	LichessExplorerClient,
	normalizeRatings,
	normalizeSpeeds,
	positionKey,
	summarizeExplorerResponse,
} from "../app/traps/explorer-client.mjs";
import { createExplorerCache } from "../app/traps/explorer-cache.mjs";

const FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function response(body, { status = 200, headers = {} } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name) => headers[name] ?? null },
		json: async () => body,
	};
}

const SAMPLE = {
	white: 600,
	draws: 100,
	black: 300,
	moves: [
		{ uci: "g1f3", san: "Nf3", white: 300, draws: 60, black: 140 },
		{ uci: "f1c4", san: "Bc4", white: 200, draws: 30, black: 120 },
		{ uci: "d1h5", san: "Qh5", white: 0, draws: 0, black: 0 },
	],
	opening: { eco: "C20", name: "King's Pawn Game" },
};

/** A clock the tests drive by hand, so nothing waits on real time. */
function fakeClock() {
	let now = 0;
	return {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		advance: (ms) => {
			now += ms;
		},
	};
}

test("summarizes a response into shares and drops moves with no games", () => {
	const summary = summarizeExplorerResponse(SAMPLE);

	assert.equal(summary.total, 1000);
	assert.equal(summary.moves.length, 2, "the zero-game move is dropped");
	assert.equal(summary.moves[0].total, 500);
	assert.equal(summary.moves[0].share, 0.5);
	assert.equal(summary.opening.eco, "C20");
});

test("position key ignores the halfmove clock and move number", () => {
	const viaOneOrder = positionKey("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
	const viaAnother = positionKey("r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 9 17");

	assert.equal(viaOneOrder, viaAnother, "a transposition must hit the same cache entry");
});

test("normalizes rating buckets and speeds, falling back to sane defaults", () => {
	assert.deepEqual(normalizeRatings([1837, 1800, 1600, 1600]), [1600, 1800], "invalid buckets are dropped");
	assert.deepEqual(normalizeRatings([]), [1600, 1800]);
	assert.deepEqual(normalizeSpeeds(["blitz", "nonsense"]), ["blitz"]);
	assert.deepEqual(normalizeSpeeds(["nonsense"]), ["blitz", "rapid"]);
});

test("rating buckets span the player's own band and its neighbours", () => {
	assert.deepEqual(bucketsAroundRating(1650), [1400, 1600, 1800]);
	assert.deepEqual(bucketsAroundRating(700), [0, 1000], "clamps at the bottom of the range");
	assert.deepEqual(bucketsAroundRating(2900), [2200, 2500], "clamps at the top of the range");
});

test("empirical score reads the counts from the requested side", () => {
	assert.equal(empiricalScore({ white: 6, draws: 2, black: 2 }, "w"), 0.7);
	assert.equal(empiricalScore({ white: 6, draws: 2, black: 2 }, "b"), 0.3);
	assert.equal(empiricalScore({ white: 0, draws: 0, black: 0 }, "w"), null);
});

test("sends a bearer token and asks for no game references", async () => {
	const calls = [];
	const client = new LichessExplorerClient({
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return response(SAMPLE);
		},
		getToken: () => "lip_testtoken",
		minIntervalMs: 0,
		...fakeClock(),
	});

	const result = await client.lookup({ fen: FEN, ratings: [1600], speeds: ["blitz"] });

	assert.equal(result.total, 1000);
	assert.equal(calls[0].init.headers.Authorization, "Bearer lip_testtoken");
	const query = new URL(calls[0].url).searchParams;
	assert.equal(query.get("topGames"), "0", "game references are the expensive part of the response");
	assert.equal(query.get("recentGames"), "0");
	assert.equal(query.get("ratings"), "1600");
	assert.equal(query.get("variant"), "standard");
});

test("refuses to send anything without a token", async () => {
	const client = new LichessExplorerClient({
		fetchImpl: async () => {
			throw new Error("must not be called");
		},
		getToken: () => "  ",
	});

	await assert.rejects(() => client.lookup({ fen: FEN }), ExplorerAuthError);
	assert.equal(client.requestsMade, 0);
});

test("keeps a floor between requests and never overlaps them", async () => {
	const clock = fakeClock();
	let inFlight = 0;
	const startedAt = [];

	const client = new LichessExplorerClient({
		fetchImpl: async () => {
			inFlight += 1;
			assert.equal(inFlight, 1, "only one explorer request may be in flight");
			startedAt.push(clock.now());
			clock.advance(5);
			inFlight -= 1;
			return response(SAMPLE);
		},
		getToken: () => "token",
		minIntervalMs: 1200,
		now: clock.now,
		sleep: clock.sleep,
	});

	await Promise.all([
		client.lookup({ fen: FEN }),
		client.lookup({ fen: "8/8/8/8/8/8/8/K6k w - - 0 1" }),
		client.lookup({ fen: "8/8/8/8/8/8/8/K6k b - - 0 1" }),
	]);

	assert.equal(startedAt.length, 3);
	assert.ok(startedAt[1] - startedAt[0] >= 1200, `gap was ${startedAt[1] - startedAt[0]}ms`);
	assert.ok(startedAt[2] - startedAt[1] >= 1200, `gap was ${startedAt[2] - startedAt[1]}ms`);
});

test("a 429 starts a cooldown and blocks further requests instead of retrying", async () => {
	const clock = fakeClock();
	let fetches = 0;
	const client = new LichessExplorerClient({
		fetchImpl: async () => {
			fetches += 1;
			return response({}, { status: 429 });
		},
		getToken: () => "token",
		minIntervalMs: 0,
		now: clock.now,
		sleep: clock.sleep,
	});

	await assert.rejects(() => client.lookup({ fen: FEN }), ExplorerRateLimitError);
	await assert.rejects(() => client.lookup({ fen: "8/8/8/8/8/8/8/K6k w - - 0 1" }), ExplorerRateLimitError);

	assert.equal(fetches, 1, "the second call must not reach the network during the cooldown");
	assert.equal(client.rateLimitedUntilMs, 60_000, "Lichess asks for a full minute");

	clock.advance(60_001);
	await client.lookup({ fen: "8/8/8/8/8/8/8/K6k b - - 0 1" }).catch(() => {});
	assert.equal(fetches, 2, "requests resume once the cooldown expires");
});

test("honours a longer Retry-After than the default cooldown", async () => {
	const clock = fakeClock();
	const client = new LichessExplorerClient({
		fetchImpl: async () => response({}, { status: 429, headers: { "Retry-After": "180" } }),
		getToken: () => "token",
		minIntervalMs: 0,
		now: clock.now,
		sleep: clock.sleep,
	});

	await assert.rejects(() => client.lookup({ fen: FEN }), ExplorerRateLimitError);
	assert.equal(client.rateLimitedUntilMs, 180_000);
});

test("a rejected token is reported as an auth problem, not a generic failure", async () => {
	const client = new LichessExplorerClient({
		fetchImpl: async () => response({}, { status: 401 }),
		getToken: () => "stale-token",
		minIntervalMs: 0,
		...fakeClock(),
	});

	await assert.rejects(() => client.lookup({ fen: FEN }), ExplorerAuthError);
});

test("a cached position costs no request, including across transpositions", async () => {
	let fetches = 0;
	const store = {};
	const cache = createExplorerCache({
		storageGet: async (key) => ({ [key]: store[key] }),
		storageSet: async (values) => Object.assign(store, values),
		setTimeoutImpl: (fn) => fn(),
		clearTimeoutImpl: () => {},
	});

	const client = new LichessExplorerClient({
		fetchImpl: async () => {
			fetches += 1;
			return response(SAMPLE);
		},
		getToken: () => "token",
		minIntervalMs: 0,
		cache,
		...fakeClock(),
	});

	const first = await client.lookup({ fen: FEN, ratings: [1600], speeds: ["blitz"] });
	const second = await client.lookup({ fen: FEN, ratings: [1600], speeds: ["blitz"] });
	// Same position, different move counters.
	const third = await client.lookup({
		fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 7 14",
		ratings: [1600],
		speeds: ["blitz"],
	});

	assert.equal(fetches, 1);
	assert.equal(first.fromCache, false);
	assert.equal(second.fromCache, true);
	assert.equal(third.fromCache, true);
	assert.equal(second.total, 1000);

	// A different rating band is a different question and must be fetched.
	await client.lookup({ fen: FEN, ratings: [2200], speeds: ["blitz"] });
	assert.equal(fetches, 2);
});

test("the cache expires entries and survives unreadable storage", async () => {
	const clock = fakeClock();
	const store = {};
	const cache = createExplorerCache({
		storageGet: async (key) => ({ [key]: store[key] }),
		storageSet: async (values) => Object.assign(store, values),
		ttlMs: 1000,
		now: clock.now,
		setTimeoutImpl: (fn) => fn(),
		clearTimeoutImpl: () => {},
	});

	await cache.set("k", { total: 5 });
	assert.deepEqual(await cache.get("k"), { total: 5 });
	clock.advance(1001);
	assert.equal(await cache.get("k"), null);

	const broken = createExplorerCache({
		storageGet: async () => {
			throw new Error("storage unavailable");
		},
		storageSet: async () => {
			throw new Error("storage unavailable");
		},
		setTimeoutImpl: (fn) => fn(),
		clearTimeoutImpl: () => {},
	});
	await broken.set("k", { total: 1 });
	assert.deepEqual(await broken.get("k"), { total: 1 }, "the memory tier still works");
});

test("the cache evicts the oldest entries once it is full", async () => {
	const clock = fakeClock();
	const cache = createExplorerCache({
		storageGet: async () => ({}),
		storageSet: async () => {},
		maxEntries: 2,
		now: clock.now,
		setTimeoutImpl: (fn) => fn(),
		clearTimeoutImpl: () => {},
	});

	await cache.set("a", { n: 1 });
	clock.advance(10);
	await cache.set("b", { n: 2 });
	clock.advance(10);
	await cache.set("c", { n: 3 });

	assert.equal(cache.size, 2);
	assert.equal(await cache.get("a"), null, "the oldest entry is dropped");
	assert.deepEqual(await cache.get("c"), { n: 3 });
});
