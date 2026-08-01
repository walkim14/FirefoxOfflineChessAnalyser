import test from "node:test";
import assert from "node:assert/strict";
import { Chess } from "../vendor/chess.js";
import { findTraps } from "../app/traps/trap-finder.mjs";
import { ExplorerRateLimitError, positionKey } from "../app/traps/explorer-client.mjs";

/** After 1.e4 e5 — White to move, so White is the one setting the trap. */
const ROOT = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function fenAfter(fen, uci) {
	const game = new Chess(fen);
	game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
	return game.fen();
}

const AFTER_NF3 = fenAfter(ROOT, "g1f3");
const AFTER_BC4 = fenAfter(ROOT, "f1c4");
const AFTER_QH5 = fenAfter(ROOT, "d1h5");

/** Splits a total into a plausible 50/10/40 result spread. */
function results(total) {
	const white = Math.round(total * 0.5);
	const draws = Math.round(total * 0.1);
	return { white, draws, black: total - white - draws, total };
}

function moveStat(uci, san, total, share) {
	return { uci, san, ...results(total), share };
}

function positionStats(total, opening, moves) {
	return { ...results(total), opening, moves };
}

/**
 * The scenario: two sound developing moves, one of which is answered badly far
 * more often, plus one unsound queen sortie.
 */
const EXPLORER_DATA = {
	[positionKey(ROOT)]: positionStats(10_000, { eco: "C20", name: "King's Pawn Game" }, [
		moveStat("g1f3", "Nf3", 6000, 0.6),
		moveStat("f1c4", "Bc4", 3000, 0.3),
		moveStat("d1h5", "Qh5", 1000, 0.1),
	]),
	[positionKey(AFTER_NF3)]: positionStats(6000, { eco: "C40", name: "King's Knight Opening" }, [
		moveStat("b8c6", "Nc6", 4200, 0.7),
		moveStat("f7f6", "f6", 1200, 0.2),
		moveStat("d7d6", "d6", 600, 0.1),
	]),
	[positionKey(AFTER_BC4)]: positionStats(3000, { eco: "C23", name: "Bishop's Opening" }, [
		moveStat("g8f6", "Nf6", 1500, 0.5),
		moveStat("b8c6", "Nc6", 900, 0.3),
		moveStat("d7d5", "d5", 600, 0.2),
	]),
	[positionKey(AFTER_QH5)]: positionStats(1000, null, [
		moveStat("b8c6", "Nc6", 700, 0.7),
		moveStat("g7g6", "g6", 300, 0.3),
	]),
};

/** Centipawn scores from White's side, keyed by position. */
const EVALS = {
	[positionKey(ROOT)]: 30,
	[positionKey(AFTER_NF3)]: 30,
	[positionKey(AFTER_BC4)]: 30,
	// A queen sortie that just loses time: not a sound move to build a trap on.
	[positionKey(AFTER_QH5)]: -150,
	[positionKey(fenAfter(AFTER_NF3, "b8c6"))]: 30,
	[positionKey(fenAfter(AFTER_NF3, "f7f6"))]: 250,
	[positionKey(fenAfter(AFTER_NF3, "d7d6"))]: 40,
	[positionKey(fenAfter(AFTER_BC4, "g8f6"))]: 30,
	[positionKey(fenAfter(AFTER_BC4, "b8c6"))]: 30,
	[positionKey(fenAfter(AFTER_BC4, "d7d5"))]: 400,
	[positionKey(fenAfter(AFTER_QH5, "b8c6"))]: -150,
	[positionKey(fenAfter(AFTER_QH5, "g7g6"))]: -160,
};

function createExplorer(data = EXPLORER_DATA, { failAfter = Infinity } = {}) {
	const calls = [];
	return {
		calls,
		async lookup({ fen }) {
			calls.push(fen);
			if (calls.length > failAfter) {
				throw new ExplorerRateLimitError("slow down", 60_000);
			}
			const entry = data[positionKey(fen)];
			if (!entry) {
				return { total: 0, white: 0, draws: 0, black: 0, moves: [], opening: null, fromCache: false };
			}
			return { ...entry, fromCache: false };
		},
	};
}

function createEvaluator(evals = EVALS) {
	const seen = [];
	return {
		seen,
		evaluateAll(fens) {
			return fens.map(async (fen) => {
				seen.push(fen);
				const cpWhite = evals[positionKey(fen)];
				if (cpWhite === undefined) {
					throw new Error(`No scripted evaluation for ${fen}`);
				}
				const game = new Chess(fen);
				const first = game.moves({ verbose: true })[0];
				return {
					fen,
					cpWhite,
					bestMove: first ? `${first.from}${first.to}` : null,
					evalText: (cpWhite / 100).toFixed(2),
				};
			});
		},
	};
}

async function run(overrides = {}) {
	const explorer = overrides.explorer || createExplorer();
	const evaluator = overrides.evaluator || createEvaluator();
	const result = await findTraps({
		rootFen: ROOT,
		explorer,
		evaluateAll: evaluator.evaluateAll,
		ChessImpl: Chess,
		ratings: [1600, 1800],
		speeds: ["blitz", "rapid"],
		options: overrides.options,
		signal: overrides.signal,
		onProgress: overrides.onProgress || (() => {}),
	});
	return { result, explorer, evaluator };
}

test("ranks a move by how much expected score the opponent pool actually hands over", async () => {
	const { result } = await run();

	assert.equal(result.heroColor, "w");
	assert.deepEqual(
		result.traps.map((trap) => trap.san),
		["Bc4", "Nf3"],
		"Bc4 is answered badly less often but far more expensively, and wins on expected value",
	);

	const [bishop, knight] = result.traps;
	assert.ok(bishop.expectedGain > knight.expectedGain);
	// 20% play d5, which drops from roughly -0.03 to -0.31 for Black.
	assert.equal(bishop.trapShare, 0.2);
	assert.ok(bishop.expectedGain > 0.05 && bishop.expectedGain < 0.07, `got ${bishop.expectedGain}`);
	assert.equal(knight.trapShare, 0.2);
	assert.ok(knight.expectedGain > 0.03 && knight.expectedGain < 0.05, `got ${knight.expectedGain}`);
});

test("drops a move that gives up real ground against the best reply", async () => {
	const { result } = await run();

	assert.ok(!result.traps.some((trap) => trap.san === "Qh5"), "Qh5 loses too much to be a trap to play");
	const qh5 = result.rejected.find((trap) => trap.san === "Qh5");
	assert.ok(qh5, "it is still reported, so the panel can say why it was rejected");
	assert.equal(qh5.isSound, false);
	assert.ok(qh5.heroEpLoss > 0.05);
});

test("names the losing reply and the move that punishes it", async () => {
	const { result } = await run();
	const bishop = result.traps.find((trap) => trap.san === "Bc4");
	const trapped = bishop.replies.filter((reply) => reply.isTrapped);

	assert.deepEqual(trapped.map((reply) => reply.san), ["d5"]);
	assert.equal(trapped[0].share, 0.2);
	assert.equal(trapped[0].games, 600);
	assert.ok(trapped[0].refutationSan, "the user needs to know how to punish it");
	assert.ok(trapped[0].epLoss > 0.15);

	const sound = bishop.replies.filter((reply) => !reply.isTrapped);
	assert.deepEqual(sound.map((reply) => reply.san).sort(), ["Nc6", "Nf6"]);
});

test("reports the empirical score alongside the engine's verdict", async () => {
	const { result } = await run();
	const bishop = result.traps.find((trap) => trap.san === "Bc4");

	// 50% white / 10% draw in the fixture, from White's side.
	assert.ok(Math.abs(bishop.heroEmpiricalScoreWhenTrapped - 0.55) < 0.01);
	assert.ok(bishop.heroEmpiricalScore !== null);
	assert.ok(bishop.practicalEdge > 0, "the pool gives ground compared with best play");
});

test("shrinks the score of a thinly played line toward zero", async () => {
	const thin = structuredClone(EXPLORER_DATA);
	thin[positionKey(AFTER_BC4)].total = 200;

	const { result } = await run({ explorer: createExplorer(thin) });
	const bishop = result.traps.find((trap) => trap.san === "Bc4");
	const knight = result.traps.find((trap) => trap.san === "Nf3");

	assert.ok(bishop.confidence < 0.5, "200 games is thin next to a 300-game prior");
	assert.ok(
		knight.score > bishop.score,
		"the better-evidenced line now ranks first even though its raw payoff is smaller",
	);
});

test("ignores positions the explorer has barely seen", async () => {
	const sparse = structuredClone(EXPLORER_DATA);
	sparse[positionKey(AFTER_BC4)].total = 40;

	const { result } = await run({ explorer: createExplorer(sparse) });
	assert.ok(!result.traps.some((trap) => trap.san === "Bc4"));
	assert.deepEqual(result.traps.map((trap) => trap.san), ["Nf3"]);
});

test("refuses to search a position with too little data behind it", async () => {
	const sparse = structuredClone(EXPLORER_DATA);
	sparse[positionKey(ROOT)].total = 30;

	await assert.rejects(() => run({ explorer: createExplorer(sparse) }), /too few to find reliable traps/);
});

test("spends no more explorer requests than the budget allows", async () => {
	const { result, explorer } = await run({ options: { requestBudget: 3 } });

	assert.equal(explorer.calls.length, 3, "one for the root, two candidates, then it stops");
	assert.equal(result.requestsUsed, 3);
	assert.equal(result.stoppedEarly, "budget");
	assert.ok(result.traps.length > 0, "partial results are still worth showing");
});

test("a rate limit stops the search and keeps what it already had", async () => {
	const { result } = await run({ explorer: createExplorer(EXPLORER_DATA, { failAfter: 2 }) });

	assert.equal(result.stoppedEarly, "rate-limited");
	assert.deepEqual(result.traps.map((trap) => trap.san), ["Nf3"], "the one branch that completed");
});

test("cached lookups do not count against the request budget", async () => {
	const explorer = createExplorer();
	const cached = {
		calls: explorer.calls,
		lookup: async (params) => ({ ...(await explorer.lookup(params)), fromCache: true }),
	};

	const { result } = await run({ explorer: cached, options: { requestBudget: 2 } });

	assert.equal(result.requestsUsed, 0);
	assert.equal(result.stoppedEarly, null);
	assert.equal(result.traps.length, 2, "a fully cached search runs to completion for free");
});

test("batches every position into one engine run, with no repeats", async () => {
	const { result, evaluator } = await run();

	const unique = new Set(evaluator.seen);
	assert.equal(unique.size, evaluator.seen.length, "no position is searched twice");
	// The root, three candidate moves, and 3 + 3 + 2 replies behind them.
	assert.equal(evaluator.seen.length, 12);
	assert.equal(result.positionsEvaluated, 12);
});

test("a repeated move in the explorer response is evaluated once", async () => {
	const duplicated = structuredClone(EXPLORER_DATA);
	duplicated[positionKey(AFTER_BC4)].moves.push(moveStat("d7d5", "d5", 600, 0.2));

	const { result, evaluator } = await run({ explorer: createExplorer(duplicated) });

	assert.equal(new Set(evaluator.seen).size, evaluator.seen.length, "no position is searched twice");
	const bishop = result.traps.find((trap) => trap.san === "Bc4");
	assert.equal(bishop.replies.filter((reply) => reply.san === "d5").length, 2);
	assert.equal(result.positionsEvaluated, 12, "the duplicate adds no engine work");
});

test("survives an engine failure on one position", async () => {
	const evaluator = createEvaluator();
	const original = evaluator.evaluateAll;
	evaluator.evaluateAll = (fens) =>
		original(fens).map((promise, index) => (index === 2 ? Promise.reject(new Error("worker died")) : promise));

	const { result } = await run({ evaluator });
	assert.ok(result.traps.length >= 1, "the remaining branches still produce results");
});

test("reports progress through both phases", async () => {
	const phases = [];
	await run({ onProgress: (update) => phases.push(update.phase) });

	assert.ok(phases.includes("explorer"));
	assert.ok(phases.includes("engine"));
	assert.equal(phases[0], "explorer", "the network phase runs first");
});

test("stops promptly when canceled", async () => {
	const controller = new AbortController();
	const explorer = createExplorer();
	const watched = {
		calls: explorer.calls,
		lookup: async (params) => {
			if (explorer.calls.length >= 2) {
				controller.abort();
			}
			return explorer.lookup(params);
		},
	};

	await assert.rejects(
		() => run({ explorer: watched, signal: controller.signal }),
		(error) => error.name === "AbortError",
	);
});
