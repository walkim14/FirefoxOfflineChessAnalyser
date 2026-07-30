import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describeTerminalPosition, terminalAnalysis } from "../app/terminal-position.mjs";
import { classifyMove } from "../app/move-classifier.mjs";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FOOLS_MATE_FEN = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
const STALEMATE_FEN = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";

test("a playable position is not treated as terminal", () => {
	assert.equal(terminalAnalysis(START_FEN, Chess), null);
	assert.equal(describeTerminalPosition(new Chess(START_FEN)), null);
});

test("checkmate evaluates to a decisive score for the side that delivered it", () => {
	const analysis = terminalAnalysis(FOOLS_MATE_FEN, Chess);
	assert.ok(analysis);
	assert.equal(analysis.terminal, "checkmate");
	// White is to move and mated, so the position is winning for black.
	assert.equal(analysis.cpWhite, -10000);
	assert.equal(analysis.winPercentWhite, 0);
	assert.equal(analysis.evalText, "-M0");
	assert.equal(analysis.bestMove, null);
	assert.deepEqual(analysis.lines, []);
});

test("stalemate evaluates as a draw", () => {
	const analysis = terminalAnalysis(STALEMATE_FEN, Chess);
	assert.ok(analysis);
	assert.equal(analysis.terminal, "stalemate");
	assert.equal(analysis.cpWhite, 0);
	assert.equal(analysis.winPercentWhite, 50);
});

test("an unparseable FEN falls through to the engine instead of throwing", () => {
	assert.equal(terminalAnalysis("not a fen", Chess), null);
});

test("a mating move is classified as best, not as a blunder", () => {
	const beforeFen = "rnb1kbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
	const gameBefore = new Chess(beforeFen);

	// Black is already winning here; the engine likes Qh4#.
	const beforeAnalysis = {
		fen: beforeFen,
		sideToMove: "b",
		bestMove: "d8h4",
		cpWhite: -9960,
		lines: [{ multipv: 1, cpWhite: -9960 }],
	};
	const afterAnalysis = terminalAnalysis(FOOLS_MATE_FEN, Chess);

	const classification = classifyMove({
		beforeAnalysis,
		afterAnalysis,
		playedMoveUci: "d8h4",
		moverColor: "b",
		playerElo: 1600,
		gameBefore,
		afterFen: FOOLS_MATE_FEN,
	});

	assert.equal(classification.epLoss, 0);
	assert.notEqual(classification.label, "Blunder");
	assert.equal(classification.isBestMove, true);
});
