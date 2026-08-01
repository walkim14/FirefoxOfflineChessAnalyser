// Drives the trap finder through the real analyzer page: the panel's controls,
// the explorer client, the engine pool and the renderer, with only the network
// replaced. The search logic itself is covered by `trap-finder.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { bootAnalyzerPage, fenKey, id } from "./helpers/analyzer-page.mjs";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");

/** After 1.e4 e5, White to move. */
const ROOT = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function after(fen, uci) {
	const game = new Chess(fen);
	game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
	return game.fen();
}

const AFTER_BC4 = after(ROOT, "f1c4");
const AFTER_NF3 = after(ROOT, "g1f3");

function counts(total) {
	const white = Math.round(total * 0.5);
	const draws = Math.round(total * 0.1);
	return { white, draws, black: total - white - draws };
}

function move(uci, san, total) {
	return { uci, san, ...counts(total) };
}

/**
 * Two sound developing moves. 20% of the pool answers Bc4 with a move that
 * loses a lot, so it is the trap; Nf3 is answered well.
 */
const EXPLORER = {
	[fenKey(ROOT)]: {
		...counts(10_000),
		opening: { eco: "C20", name: "King's Pawn Game" },
		moves: [move("f1c4", "Bc4", 6000), move("g1f3", "Nf3", 4000)],
	},
	[fenKey(AFTER_BC4)]: {
		...counts(6000),
		opening: { eco: "C23", name: "Bishop's Opening" },
		moves: [move("g8f6", "Nf6", 3000), move("b8c6", "Nc6", 1800), move("d7d5", "d5", 1200)],
	},
	[fenKey(AFTER_NF3)]: {
		...counts(4000),
		opening: { eco: "C40", name: "King's Knight Opening" },
		moves: [move("b8c6", "Nc6", 2800), move("d7d6", "d6", 1200)],
	},
};

const SCORES = {
	[fenKey(ROOT)]: 30,
	[fenKey(AFTER_BC4)]: 30,
	[fenKey(AFTER_NF3)]: 30,
	[fenKey(after(AFTER_BC4, "g8f6"))]: 30,
	[fenKey(after(AFTER_BC4, "b8c6"))]: 30,
	// The trap springs: this reply drops the game.
	[fenKey(after(AFTER_BC4, "d7d5"))]: 400,
	[fenKey(after(AFTER_NF3, "b8c6"))]: 30,
	[fenKey(after(AFTER_NF3, "d7d6"))]: 40,
};

function explorerStub({ status = 200, body = null } = {}) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		if (status !== 200) {
			return { ok: false, status, headers: { get: () => null }, json: async () => ({}) };
		}
		const fen = new URL(url).searchParams.get("fen");
		const entry = body || EXPLORER[fenKey(fen)] || { white: 0, draws: 0, black: 0, moves: [], opening: null };
		return { ok: true, status: 200, headers: { get: () => null }, json: async () => entry };
	};
	return { calls, fetchImpl };
}

async function waitFor(predicate, { timeoutMs = 60_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

/**
 * Waits for the search to finish rather than for a wall-clock interval: the
 * button is re-enabled in the same `finally` that ends every path through the
 * search, so once it is back the status line has already been written.
 */
async function waitForSearchToFinish(page) {
	const button = id(page.document, "find-traps-btn");
	// Let the click be picked up before treating an idle button as "finished".
	await page.settle(80);
	return waitFor(() => !button.disabled);
}

/**
 * Loads the root position and starts a search with a token in place.
 *
 * The explorer cache is cleared first. Each test boots its own page with its own
 * storage, but the cache flushes behind a debounce and `storageSet` resolves
 * `chrome` when it runs, so a flush left over from an earlier test can land in
 * this page's storage and quietly serve the search from cache. Clearing pins the
 * starting state whatever the timers do; the real extension has one page and one
 * cache, so it cannot hit this.
 */
async function search(page, { token = "lip_testtoken" } = {}) {
	id(page.document, "clear-trap-cache-btn").dispatchEvent(new page.window.Event("click"));
	await page.settle(120);

	id(page.document, "fen-input").value = ROOT;
	id(page.document, "load-fen-btn").dispatchEvent(new page.window.Event("click"));
	await page.settle(200);

	id(page.document, "trap-token-input").value = token;
	id(page.document, "find-traps-btn").dispatchEvent(new page.window.Event("click"));
}

const statusText = (page) => id(page.document, "trap-status").textContent;
const trapCards = (page) => [...page.document.querySelectorAll("#trap-results .trap-card")];

test("finds and renders the trap from the position on the board", async () => {
	const { calls, fetchImpl } = explorerStub();
	const page = await bootAnalyzerPage({ scores: SCORES, fetchImpl });

	try {
		await page.settle(200);
		await search(page);

		assert.ok(await waitForSearchToFinish(page), "the search never finished");
		assert.ok(trapCards(page).length > 0, `no results rendered; status was: ${statusText(page)}`);

		const cards = trapCards(page);
		assert.equal(cards.length, 1, "only Bc4 clears the bar");
		assert.equal(cards[0].querySelector(".trap-move").textContent, "Bc4");
		assert.match(cards[0].textContent, /20%\s*walk into it/);
		assert.match(cards[0].textContent, /C23 Bishop's Opening/);

		// The losing reply is named, with the move that punishes it.
		const trapped = cards[0].querySelector(".trap-reply-trapped");
		assert.equal(trapped.querySelector(".trap-reply-move").textContent, "d5");
		assert.match(trapped.textContent, /punish with/);

		// The replies that hold are shown too, so the line can be judged whole.
		assert.equal(cards[0].querySelectorAll(".trap-reply-safe").length, 2);

		assert.match(statusText(page), /1 trap found/);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);

		// One request for the root and one per candidate move — no game references.
		assert.equal(calls.length, 3);
		const query = new URL(calls[0].url).searchParams;
		assert.equal(calls[0].init.headers.Authorization, "Bearer lip_testtoken");
		assert.equal(query.get("topGames"), "0");
		assert.equal(query.get("ratings"), "1400,1600,1800", "the default band brackets the player's rating");
		assert.equal(query.get("speeds"), "blitz,rapid");
		assert.ok(calls[0].url.startsWith("https://explorer.lichess.org/lichess?"));
	} finally {
		page.restore();
	}
});

test("clicking a trap plays it on the board", async () => {
	const { fetchImpl } = explorerStub();
	const page = await bootAnalyzerPage({ scores: SCORES, fetchImpl });

	try {
		await page.settle(200);
		await search(page);
		assert.ok(await waitForSearchToFinish(page), "the search never finished");
		assert.ok(trapCards(page).length > 0, `no results rendered; status was: ${statusText(page)}`);

		trapCards(page)[0].querySelector(".trap-move").dispatchEvent(new page.window.Event("click"));
		await page.settle(300);

		const chips = [...page.document.querySelectorAll("#tree-path .tree-chip-move")].map((chip) => chip.textContent.trim());
		assert.ok(chips.includes("Bc4"), `tree held: ${chips.join(", ")}`);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("asks for a token instead of sending an unauthenticated request", async () => {
	const { calls, fetchImpl } = explorerStub();
	const page = await bootAnalyzerPage({ scores: SCORES, fetchImpl });

	try {
		await page.settle(200);
		await search(page, { token: "" });

		assert.ok(await waitForSearchToFinish(page), "the search never finished");
		assert.match(statusText(page), /token/i);
		assert.equal(calls.length, 0, "nothing may reach Lichess without a token");
		assert.match(statusText(page), /lichess\.org\/account\/oauth\/token/);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("a 429 stops the search and says so rather than retrying", async () => {
	const { calls, fetchImpl } = explorerStub({ status: 429 });
	const page = await bootAnalyzerPage({ scores: SCORES, fetchImpl });

	try {
		await page.settle(200);
		await search(page);

		assert.ok(await waitForSearchToFinish(page), "the search never finished");
		assert.match(statusText(page), /rate limited/i);
		assert.equal(calls.length, 1, "the cooldown must block any follow-up request");
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("the token and search settings survive a reload", async () => {
	const { fetchImpl } = explorerStub();
	const first = await bootAnalyzerPage({ scores: SCORES, fetchImpl });
	let saved = null;

	try {
		await first.settle(200);
		id(first.document, "trap-token-input").value = "lip_persisted";
		id(first.document, "trap-rating-select").value = "2000,2200";
		id(first.document, "trap-token-input").dispatchEvent(new first.window.Event("change"));
		await first.settle(120);

		saved = first.storage.settings;
		assert.equal(saved.lichessToken, "lip_persisted");
		assert.equal(saved.trapRatingBand, "2000,2200");
	} finally {
		first.restore();
	}

	const second = await bootAnalyzerPage({ scores: SCORES, fetchImpl });
	try {
		Object.assign(second.storage, { settings: saved });
		// Re-run the load now that storage holds the previous session's settings.
		const app = await import(`../app/core/analyzer-app.mjs?reload=${Math.random()}`);
		await app.bootstrapAnalyzerApp();
		await second.settle(200);

		assert.equal(id(second.document, "trap-token-input").value, "lip_persisted");
		assert.equal(id(second.document, "trap-rating-select").value, "2000,2200");
	} finally {
		second.restore();
	}
});
