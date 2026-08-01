/**
 * Finds traps: moves that are sound for you and that the opponents you actually
 * face tend to answer badly.
 *
 * The idea the whole module rests on is that a trap has two halves, and neither
 * half can be seen from one source alone:
 *
 * - **The engine** knows which replies are objectively losing. It has no idea
 *   which of them anyone would ever play.
 * - **The opening explorer** knows exactly which replies humans at a given
 *   rating actually choose. It has no idea which of them are bad.
 *
 * Intersect the two and you get the thing worth learning: a reply that is both
 * popular and losing. The popularity share *is* the measure of how tempting the
 * mistake looks, which is why this does not need a hand-written notion of what
 * makes a move "natural" — a few hundred thousand humans already voted.
 *
 * So, for each candidate move you might play:
 *
 *   1. Ask the explorer how the opponent pool replies to it.
 *   2. Ask the engine what each of those replies is worth.
 *   3. Score the move by how much expected value the pool hands over.
 *
 * Expected points are zero-sum, so the opponent's loss on a reply is exactly
 * your gain; the two only need computing once.
 *
 * Nothing here touches the network, the DOM, or the engine directly — the
 * explorer and the evaluator are injected, which is what lets the tests drive
 * the whole search deterministically.
 */

import { expectedWhitePercent } from "../move-classifier.mjs";
import { empiricalScore, ExplorerRateLimitError } from "./explorer-client.mjs";

export const DEFAULT_TRAP_OPTIONS = {
	/** How many of your moves to investigate. Each one costs one API request. */
	candidateMoves: 10,
	/** How many opponent replies per candidate to send to the engine. */
	replyMoves: 8,
	/** Replies rarer than this are noise, not traps. */
	minReplyShare: 0.02,
	/** A reply must cost the opponent at least this much expected score. */
	blunderEpLoss: 0.15,
	/** Your own move may not give up more than this against best play. */
	maxHeroEpLoss: 0.05,
	/** Ignore positions the explorer has barely seen. */
	minPositionGames: 150,
	/** Report a candidate only if this much of the reply distribution falls in. */
	minTrapShare: 0.05,
	/** Hard ceiling on explorer requests for one search. */
	requestBudget: 14,
	/**
	 * Shrinks scores toward zero for small samples, so a 20-game line cannot
	 * outrank a 20,000-game one on a fluke. Also the number of games at which a
	 * result is credited at half its face value.
	 */
	priorGames: 300,
};

function epForColor(cpWhite, color) {
	const whiteEp = expectedWhitePercent(cpWhite) / 100;
	return color === "w" ? whiteEp : 1 - whiteEp;
}

function uciToMoveObject(uci) {
	if (!uci || uci.length < 4) {
		return null;
	}
	return {
		from: uci.slice(0, 2),
		to: uci.slice(2, 4),
		promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
	};
}

/** Applies a UCI move, returning the resulting FEN and SAN, or null if illegal. */
function applyUci(ChessImpl, fen, uci) {
	const move = uciToMoveObject(uci);
	if (!move) {
		return null;
	}
	const game = new ChessImpl(fen);
	let applied = null;
	try {
		// chess.js throws rather than returning null for a move it rejects.
		applied = game.move(move);
	} catch {
		return null;
	}
	if (!applied) {
		return null;
	}
	return { fen: game.fen(), san: applied.san };
}

function throwIfAborted(signal) {
	if (signal?.aborted) {
		const error = new Error("Trap search canceled.");
		error.name = "AbortError";
		throw error;
	}
}

/**
 * Two-phase by design. Every explorer lookup happens first, serialized and rate
 * limited; then every engine evaluation goes out as one batch across the pool.
 *
 * Interleaving them would shave a few seconds, but the engine pool cancels its
 * previous run whenever a new batch is dispatched, and one clean batch is worth
 * more than the overlap.
 *
 * @param {object} params
 * @param {string} params.rootFen position to search from
 * @param {object} params.explorer client with `lookup({fen, ...})`
 * @param {(fens: string[]) => Promise<object>[]} params.evaluateAll one promise
 *   per FEN, so the caller can spread them across the engine pool
 * @param {Function} params.ChessImpl
 */
export async function findTraps({
	rootFen,
	explorer,
	evaluateAll,
	ChessImpl,
	ratings,
	speeds,
	since = null,
	options = {},
	onProgress = () => {},
	signal = null,
} = {}) {
	const config = { ...DEFAULT_TRAP_OPTIONS, ...options };
	const heroColor = String(rootFen).split(/\s+/)[1] === "b" ? "b" : "w";
	const opponentColor = heroColor === "w" ? "b" : "w";
	const lookupOptions = { ratings, speeds, since, signal };

	let stoppedEarly = null;
	let requestsUsed = 0;

	const lookup = async (fen) => {
		if (requestsUsed >= config.requestBudget) {
			stoppedEarly = "budget";
			return null;
		}
		const result = await explorer.lookup({ ...lookupOptions, fen, moves: config.replyMoves + 4 });
		if (!result.fromCache) {
			requestsUsed += 1;
		}
		return result;
	};

	onProgress({ phase: "explorer", done: 0, total: config.candidateMoves + 1, label: "Looking up the position" });

	const rootStats = await lookup(rootFen);
	if (!rootStats) {
		throw new Error("Explorer request budget is too small to search anything.");
	}
	throwIfAborted(signal);

	if (rootStats.total < config.minPositionGames) {
		throw new Error(
			`Only ${rootStats.total} games reach this position in the chosen rating range — too few to find reliable traps. Try a wider rating range or an earlier position.`,
		);
	}

	// Candidates are the moves humans actually play here. A move nobody plays
	// leads to a position the explorer knows nothing about, so it could not be
	// scored anyway.
	const candidates = rootStats.moves
		.slice()
		.sort((a, b) => b.total - a.total)
		.slice(0, config.candidateMoves)
		.map((move) => {
			const applied = applyUci(ChessImpl, rootFen, move.uci);
			return applied ? { ...move, san: move.san || applied.san, afterFen: applied.fen } : null;
		})
		.filter(Boolean);

	if (!candidates.length) {
		throw new Error("The explorer returned no playable moves for this position.");
	}

	/** One entry per candidate, holding the reply distribution behind it. */
	const branches = [];
	for (const [index, candidate] of candidates.entries()) {
		throwIfAborted(signal);
		onProgress({
			phase: "explorer",
			done: index + 1,
			total: candidates.length + 1,
			label: `Opponent replies to ${candidate.san}`,
		});

		let stats = null;
		try {
			stats = await lookup(candidate.afterFen);
		} catch (error) {
			if (error instanceof ExplorerRateLimitError) {
				// Stop asking. Whatever was gathered is still worth showing, and the
				// cache makes a later re-run pick up almost where this left off.
				stoppedEarly = "rate-limited";
				break;
			}
			throw error;
		}

		if (!stats) {
			break;
		}
		if (stats.total < config.minPositionGames) {
			continue;
		}

		const replies = stats.moves
			.filter((move) => move.share >= config.minReplyShare)
			.slice(0, config.replyMoves)
			.map((move) => {
				const applied = applyUci(ChessImpl, candidate.afterFen, move.uci);
				return applied ? { ...move, san: move.san || applied.san, afterFen: applied.fen } : null;
			})
			.filter(Boolean);

		if (replies.length) {
			branches.push({ candidate, stats, replies });
		}
	}

	if (!branches.length) {
		throw new Error(
			stoppedEarly === "rate-limited"
				? "Lichess rate limited the search before any position could be analysed. Try again in a minute."
				: "No move from this position has enough games behind it to judge.",
		);
	}

	// One batch: the root, each candidate's position, and every reply position.
	const fens = [rootFen];
	const indexOf = new Map([[rootFen, 0]]);
	const addFen = (fen) => {
		if (!indexOf.has(fen)) {
			indexOf.set(fen, fens.length);
			fens.push(fen);
		}
		return indexOf.get(fen);
	};
	for (const branch of branches) {
		addFen(branch.candidate.afterFen);
		for (const reply of branch.replies) {
			addFen(reply.afterFen);
		}
	}

	throwIfAborted(signal);
	onProgress({ phase: "engine", done: 0, total: fens.length, label: "Evaluating positions" });

	const pending = evaluateAll(fens);
	const evaluations = new Array(fens.length).fill(null);
	let evaluated = 0;
	await Promise.all(
		pending.map(async (promise, index) => {
			try {
				evaluations[index] = await promise;
			} catch (error) {
				if (error?.name === "AbortError") {
					throw error;
				}
				// A single failed search costs one line, not the search.
				evaluations[index] = null;
			}
			evaluated += 1;
			onProgress({ phase: "engine", done: evaluated, total: fens.length, label: "Evaluating positions" });
		}),
	);
	throwIfAborted(signal);

	const evalAt = (fen) => evaluations[indexOf.get(fen)] || null;
	const rootEval = evalAt(rootFen);
	if (!rootEval) {
		throw new Error("The engine could not evaluate the starting position.");
	}
	const heroBestEp = epForColor(rootEval.cpWhite, heroColor);

	const traps = [];
	for (const branch of branches) {
		const candidateEval = evalAt(branch.candidate.afterFen);
		if (!candidateEval) {
			continue;
		}

		// What playing this move costs you if the opponent finds the best answer.
		const heroEpAfterMove = epForColor(candidateEval.cpWhite, heroColor);
		const heroEpLoss = Math.max(0, heroBestEp - heroEpAfterMove);
		const opponentBestEp = epForColor(candidateEval.cpWhite, opponentColor);

		const scoredReplies = [];
		for (const reply of branch.replies) {
			const replyEval = evalAt(reply.afterFen);
			if (!replyEval) {
				continue;
			}
			const opponentEpAfter = epForColor(replyEval.cpWhite, opponentColor);
			// Expected points are zero-sum, so what the opponent gives up here is
			// exactly what you pick up.
			const epLoss = Math.max(0, opponentBestEp - opponentEpAfter);
			const refutationUci = replyEval.bestMove || null;
			const refutation = refutationUci ? applyUci(ChessImpl, reply.afterFen, refutationUci) : null;

			scoredReplies.push({
				uci: reply.uci,
				san: reply.san,
				share: reply.share,
				games: reply.total,
				white: reply.white,
				draws: reply.draws,
				black: reply.black,
				epLoss,
				heroEpAfter: epForColor(replyEval.cpWhite, heroColor),
				isTrapped: epLoss >= config.blunderEpLoss,
				cpWhiteAfter: replyEval.cpWhite,
				evalText: replyEval.evalText || null,
				refutationUci,
				refutationSan: refutation?.san || null,
				// How the opponent pool has actually scored after this reply —
				// independent corroboration that the engine's verdict shows up on
				// the scoreboard.
				heroEmpiricalScore: empiricalScore(reply, heroColor),
			});
		}

		if (!scoredReplies.length) {
			continue;
		}

		const trapped = scoredReplies.filter((reply) => reply.isTrapped);
		const trapShare = trapped.reduce((sum, reply) => sum + reply.share, 0);
		// The payoff you can expect per game, before knowing which reply comes.
		const rawExpectedGain = trapped.reduce((sum, reply) => sum + reply.share * reply.epLoss, 0);

		// What the move is worth against the opponents you actually meet, rather
		// than against best play — the reply distribution weighted by its own
		// evaluations.
		const coveredShare = scoredReplies.reduce((sum, reply) => sum + reply.share, 0);
		const practicalEp = coveredShare > 0
			? scoredReplies.reduce((sum, reply) => sum + (reply.share / coveredShare) * reply.heroEpAfter, 0)
			: heroEpAfterMove;

		const trappedTotals = trapped.reduce(
			(totals, reply) => ({
				white: totals.white + reply.white,
				draws: totals.draws + reply.draws,
				black: totals.black + reply.black,
			}),
			{ white: 0, draws: 0, black: 0 },
		);

		// Small samples get pulled toward zero rather than trusted outright.
		const confidence = branch.stats.total / (branch.stats.total + config.priorGames);
		const score = rawExpectedGain * confidence;

		traps.push({
			uci: branch.candidate.uci,
			san: branch.candidate.san,
			afterFen: branch.candidate.afterFen,
			opening: branch.stats.opening || rootStats.opening || null,
			games: branch.stats.total,
			popularity: branch.candidate.share,
			heroEpLoss,
			heroEpAfterMove,
			cpWhiteAfterMove: candidateEval.cpWhite,
			evalTextAfterMove: candidateEval.evalText || null,
			trapShare,
			expectedGain: rawExpectedGain,
			score,
			confidence,
			practicalEp,
			practicalEdge: practicalEp - heroEpAfterMove,
			heroEmpiricalScore: empiricalScore(branch.stats, heroColor),
			heroEmpiricalScoreWhenTrapped: empiricalScore(trappedTotals, heroColor),
			replies: scoredReplies.sort((a, b) => b.share * b.epLoss - a.share * a.epLoss),
			isSound: heroEpLoss <= config.maxHeroEpLoss,
			meetsThreshold: trapShare >= config.minTrapShare && trapped.length > 0,
		});
	}

	const ranked = traps
		.filter((trap) => trap.isSound && trap.meetsThreshold)
		.sort((a, b) => b.score - a.score);

	// Sound moves that nobody falls for are still worth showing when nothing
	// qualified, so the panel can explain *why* there is no trap here.
	const rejected = traps
		.filter((trap) => !(trap.isSound && trap.meetsThreshold))
		.sort((a, b) => b.expectedGain - a.expectedGain);

	return {
		rootFen,
		heroColor,
		opening: rootStats.opening || null,
		rootGames: rootStats.total,
		traps: ranked,
		rejected,
		requestsUsed,
		positionsEvaluated: fens.length,
		stoppedEarly,
		config,
	};
}
