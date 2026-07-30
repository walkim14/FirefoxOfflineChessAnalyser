// Stockfish answers a finished position with `bestmove (none)` and no `info`
// lines, which used to surface as a flat 0.00 evaluation. Worse, classifying a
// mating move against a 0.00 "after" score labelled checkmate as a blunder.
// These positions are decided by the rules, so evaluate them directly.

const MATE_CP = 10000;

export function describeTerminalPosition(game) {
	if (!game || typeof game.isGameOver !== "function" || !game.isGameOver()) {
		return null;
	}

	if (game.isCheckmate()) {
		return { kind: "checkmate", text: "checkmate" };
	}
	if (game.isStalemate()) {
		return { kind: "draw", text: "stalemate" };
	}
	if (game.isInsufficientMaterial()) {
		return { kind: "draw", text: "insufficient material" };
	}
	if (typeof game.isThreefoldRepetition === "function" && game.isThreefoldRepetition()) {
		return { kind: "draw", text: "threefold repetition" };
	}
	if (typeof game.isDrawByFiftyMoves === "function" && game.isDrawByFiftyMoves()) {
		return { kind: "draw", text: "fifty-move rule" };
	}

	return { kind: "draw", text: "draw" };
}

/**
 * Returns an analysis-shaped result for a finished position, or null when the
 * position is still playable and the engine should be consulted.
 */
export function terminalAnalysis(fen, ChessImpl) {
	let game = null;
	try {
		game = new ChessImpl(fen);
	} catch {
		return null;
	}

	const terminal = describeTerminalPosition(game);
	if (!terminal) {
		return null;
	}

	const sideToMove = game.turn();
	const base = {
		fen,
		sideToMove,
		requestedDepth: 0,
		requestedMultiPV: 1,
		depthReached: 0,
		nps: 0,
		nodes: 0,
		bestMove: null,
		lines: [],
		terminal: terminal.text,
	};

	if (terminal.kind === "checkmate") {
		// The side to move has been mated, so the other side is winning.
		const cpWhite = sideToMove === "w" ? -MATE_CP : MATE_CP;
		return {
			...base,
			cpWhite,
			evalText: cpWhite > 0 ? "+M0" : "-M0",
			winPercentWhite: cpWhite > 0 ? 100 : 0,
		};
	}

	return {
		...base,
		cpWhite: 0,
		evalText: "+0.00",
		winPercentWhite: 50,
	};
}
