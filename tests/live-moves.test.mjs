import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSession, FakeEngine, INITIAL_FEN } from "./helpers/analyzer-session.mjs";
import { parsePgnToLine } from "../app/pgn-loader.mjs";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");

const SHORT_PGN = `[Event "Test"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *`;

function loadPgnInto(session, pgn = SHORT_PGN) {
	const parsed = parsePgnToLine(pgn, Chess);
	session.loadLine(parsed.startFen, parsed.lineMoves, parsed.clockTimeline);
	return parsed;
}

test("a live move after loading a game branches the tree and keeps the played move", async () => {
	const session = createSession();
	const parsed = loadPgnInto(session);
	const { state, gameplayController } = session;

	assert.equal(state.lineMoves.length, parsed.lineMoves.length);
	assert.equal(state.currentPly, 0);

	// Step to move 2 for white, then play something other than the game move.
	gameplayController.seekToPly(2);
	assert.equal(state.currentPly, 2);
	const mainlineThirdMove = state.lineMoves[2];
	assert.equal(mainlineThirdMove, "g1f3");

	await gameplayController.playMoveAtCurrentPly("f1c4");
	await session.settle();

	assert.equal(state.currentPly, 3, "the board must sit on the move that was just played");
	assert.equal(state.lineMoves[2], "f1c4", "the active line must follow the new branch");
	assert.equal(state.lineMoves.length, 3, "the branch replaces the rest of the original line");

	// The original continuation is preserved as a sibling.
	const branchPoint = session.getTreeNode(state.activeLineNodeIds[2]);
	assert.equal(branchPoint.children.length, 2);
	const siblingMoves = branchPoint.children.map((id) => session.getTreeNode(id).moveUci).sort();
	assert.deepEqual(siblingMoves, ["f1c4", "g1f3"]);
});

test("a live move gets classified instead of being cancelled by the position analysis", async () => {
	// A real search takes far longer than the 80ms analysis debounce, so the
	// scheduled position analysis lands in the middle of the classification.
	const session = createSession({ engine: new FakeEngine({ latencyMs: 60 }) });
	loadPgnInto(session);
	const { state, gameplayController } = session;

	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("f1c4");
	await session.settle(300);

	const playedNode = session.getTreeNode(state.currentNodeId);
	assert.ok(playedNode.classification, "the played move must end up with a classification");
	assert.equal(playedNode.classification.playedMoveUci, "f1c4");
	assert.equal(state.moveClassifications[2], playedNode.classification);
	assert.equal(state.isClassifying, false);
	assert.equal(session.engine.cancellations, 0, "nothing should be fighting the classifier for the engine");
});

test("rapid successive live moves leave only the last one classified and unblock the pipeline", async () => {
	const session = createSession({ engine: new FakeEngine({ latencyMs: 40 }) });
	loadPgnInto(session);
	const { state, gameplayController } = session;

	gameplayController.seekToPly(0);
	// Fire three moves without waiting: each supersedes the classification of
	// the one before it.
	const first = gameplayController.playMoveAtCurrentPly("d2d4");
	const second = gameplayController.playMoveAtCurrentPly("d7d5");
	const third = gameplayController.playMoveAtCurrentPly("c2c4");
	await Promise.all([first, second, third]);
	await session.settle(400);

	assert.equal(state.currentPly, 3);
	assert.deepEqual(state.lineMoves, ["d2d4", "d7d5", "c2c4"], "the new line replaces the loaded one");
	assert.equal(state.isClassifying, false, "the classifier must not stay latched after a superseded run");

	const lastNode = session.getTreeNode(state.currentNodeId);
	assert.ok(lastNode.classification, "the final move still gets classified");
	assert.equal(lastNode.classification.playedMoveUci, "c2c4");

	// The loaded game is still reachable as a sibling of the first new move.
	const root = session.getTreeNode(state.treeRootId);
	assert.equal(root.children.length, 2);
});

test("replaying the same live move reuses the existing branch node", async () => {
	const session = createSession();
	loadPgnInto(session);
	const { state, gameplayController } = session;

	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("f1c4");
	await session.settle();
	const firstNodeId = state.currentNodeId;
	const nodeCount = state.treeNodes.size;

	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("f1c4");
	await session.settle();

	assert.equal(state.currentNodeId, firstNodeId);
	assert.equal(state.treeNodes.size, nodeCount, "no duplicate node for a repeated move");
});

test("an illegal live move is rejected without corrupting the tree", async () => {
	const session = createSession();
	loadPgnInto(session);
	const { state, gameplayController } = session;

	gameplayController.seekToPly(2);
	const nodeCount = state.treeNodes.size;
	const nodeIdBefore = state.currentNodeId;

	await gameplayController.playMoveAtCurrentPly("e1e8");
	await session.settle();

	assert.equal(state.treeNodes.size, nodeCount);
	assert.equal(state.currentNodeId, nodeIdBefore);
	assert.ok(session.log.statuses.some((text) => text.includes("Illegal move")));
});

test("playing a move during a whole-game scan takes the board over from the scan", async () => {
	const session = createSession({ engine: new FakeEngine({ latencyMs: 2 }), depth: 12, multiPV: 2 });
	loadPgnInto(session);
	const { state, analysisController, gameplayController } = session;

	const scan = analysisController.scanMainlineClassifications();
	await new Promise((resolve) => setTimeout(resolve, 6));
	assert.equal(state.scanInProgress, true);

	gameplayController.seekToPly(1);
	await gameplayController.playMoveAtCurrentPly("b8c6");
	await scan;
	await session.settle(60);

	assert.equal(state.scanInProgress, false, "the scan must stop once the user plays a move");
	assert.equal(state.currentPly, 2);
	assert.equal(state.lineMoves[1], "b8c6");
	const playedNode = session.getTreeNode(state.currentNodeId);
	assert.ok(playedNode.classification, "the user's move still gets classified");
	// Exactly one: the user's move preempting the scan's in-flight search. Any
	// more would mean the scan kept issuing searches after being taken over.
	assert.equal(session.engine.cancellations, 1);
});

test("the whole-game scan classifies every ply and restores the starting ply", async () => {
	const session = createSession({ depth: 12, multiPV: 2 });
	loadPgnInto(session);
	const { state, analysisController } = session;

	await analysisController.scanMainlineClassifications();
	await session.settle();

	assert.equal(state.currentPly, 0, "the scan returns the board to where it started");
	assert.equal(state.moveClassifications.length, state.lineMoves.length);
	assert.ok(
		state.moveClassifications.every((entry) => entry && typeof entry.label === "string"),
		"every ply must be classified",
	);
	assert.equal(session.engine.cancellations, 0, "a clean scan must not cancel its own searches");
});

test("checkmate is scored as a win rather than a flat zero, without calling the engine", async () => {
	const session = createSession();
	const { state, analysisController, gameplayController } = session;

	// Fool's mate, one move short.
	const beforeMate = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
	session.loadLine(beforeMate, []);
	await session.settle();

	const mateFen = new Chess(beforeMate);
	mateFen.move({ from: "d8", to: "h4" });
	const afterMateFen = mateFen.fen();

	await gameplayController.playMoveAtCurrentPly("d8h4");
	await session.settle();

	assert.equal(session.engine.callsFor(afterMateFen).length, 0, "a finished position must not reach the engine");

	const classification = session.getTreeNode(state.currentNodeId).classification;
	assert.ok(classification, "the mating move must be classified");
	assert.notEqual(classification.label, "Blunder", "delivering mate is not a blunder");
	assert.equal(classification.playedCpWhite, -10000, "black delivering mate is a win for black");

	await analysisController.analyzeCurrentPosition();
	assert.ok(
		session.log.statuses.some((text) => text.includes("Game over") && text.includes("checkmate")),
		"the status line must report the finished game",
	);
});

test("navigation keeps the classification cache attached to tree nodes", async () => {
	const session = createSession({ depth: 12, multiPV: 2 });
	loadPgnInto(session);
	const { state, analysisController, gameplayController } = session;

	await analysisController.scanMainlineClassifications();
	await session.settle();
	const labels = state.moveClassifications.map((entry) => entry.label);

	gameplayController.seekToPly(4);
	await gameplayController.playMoveAtCurrentPly("f1e2");
	await session.settle();
	assert.equal(state.lineMoves[4], "f1e2", "the sideline is now the active line");

	// The original continuation still carries the classifications from the scan.
	const mainlineTail = state.mainlineNodeIds[5];
	const node = session.getTreeNode(mainlineTail);
	assert.ok(node.classification, "mainline classifications survive a sideline detour");
	assert.equal(node.classification.label, labels[4]);
});

test("engine settings drive the analysed depth and the cache key", async () => {
	const session = createSession({ depth: 14, multiPV: 3 });
	session.loadLine(INITIAL_FEN, []);

	await session.analysisController.analyzeCurrentPosition();

	const call = session.engine.calls.at(-1);
	assert.equal(call.depth, 14);
	assert.equal(call.multiPV, 3);
	assert.ok(session.state.positionCache.has(`${INITIAL_FEN}|d14|pv3`));

	// A second request for the same position is served from cache.
	const callCount = session.engine.calls.length;
	await session.analysisController.analyzeCurrentPosition();
	assert.equal(session.engine.calls.length, callCount, "an exact cache hit must not re-run the engine");
});

test("a single-PV cached result does not block the full MultiPV analysis", async () => {
	const session = createSession({ depth: 12, multiPV: 3 });
	session.loadLine(INITIAL_FEN, []);
	const { state } = session;

	// This is the shape the move classifier leaves behind for the position the
	// user is now looking at.
	const single = await session.engine.analyze(INITIAL_FEN, { depth: 12, multiPV: 1 });
	state.positionCache.set(`${INITIAL_FEN}|d12|pv1`, single);
	const callsBefore = session.engine.calls.length;

	await session.analysisController.analyzeCurrentPosition();

	assert.equal(session.engine.calls.length, callsBefore + 1, "the approximate cache entry is only a placeholder");
	assert.equal(state.positionCache.get(`${INITIAL_FEN}|d12|pv3`).lines.length, 3);
});

test("the whole-game review runs a cheaper profile than the interactive board", async () => {
	// Depth 22 with three lines is roughly six times the cost per position of
	// the review profile on the shipped single-threaded engine, and the labels
	// land in the same buckets either way.
	const session = createSession({ depth: 22, reviewDepth: 16, multiPV: 3 });
	loadPgnInto(session);

	const before = session.engine.calls.length;
	await session.analysisController.scanMainlineClassifications();
	// Read the calls before settling: the post-review position analysis that
	// follows is interactive work and legitimately runs at full depth.
	const scanCalls = session.engine.calls.slice(before);
	await session.settle();

	assert.ok(scanCalls.length > 0, "the review should have searched");
	for (const call of scanCalls) {
		assert.equal(call.depth, 16, "the review must use the review depth");
		assert.ok(call.multiPV <= 3, `unexpected line count ${call.multiPV}`);
	}

	// Two lines for the sweep; three only where a standout label needs confirming.
	const threeLine = scanCalls.filter((call) => call.multiPV === 3).length;
	assert.ok(
		threeLine < scanCalls.length / 2,
		`three-line searches should be the exception, got ${threeLine} of ${scanCalls.length}`,
	);

	// One search per ply plus the starting position, not two per ply.
	assert.ok(
		scanCalls.length - threeLine <= session.state.lineMoves.length + 1,
		`expected at most ${session.state.lineMoves.length + 1} sweep searches, got ${scanCalls.length - threeLine}`,
	);
});

test("a move the user plays still gets the full interactive profile", async () => {
	const session = createSession({ depth: 22, reviewDepth: 14, multiPV: 3 });
	loadPgnInto(session);
	const { gameplayController } = session;

	gameplayController.seekToPly(2);
	const before = session.engine.calls.length;
	await gameplayController.playMoveAtCurrentPly("f1c4");
	const classifyCalls = session.engine.calls.slice(before);
	await session.settle();

	assert.ok(classifyCalls.length > 0, "classifying should have searched");
	for (const call of classifyCalls) {
		assert.equal(call.depth, 22, "a played move is one position and deserves full depth");
	}
});

test("the review starts each search before animating the move", async () => {
	// The playback beat used to run to completion before the engine was asked
	// anything, so its delay was added to every ply of the game rather than
	// spent while the engine was already working.
	const engine = new FakeEngine({ latencyMs: 2 });
	const session = createSession({ engine, depth: 12, reviewDepth: 12, multiPV: 2, playbackDelayMs: 20 });
	loadPgnInto(session);

	const observed = [];
	engine.onAnalyze = ({ fen }) => {
		observed.push({ fen, plyOnBoard: session.state.currentPly });
	};

	await session.analysisController.scanMainlineClassifications();
	await session.settle();

	const timeline = session.state.timelineFens;
	// A search whose position is further along than the board is one that was
	// issued before the move was played on screen.
	const startedEarly = observed.filter((entry) => timeline.indexOf(entry.fen) > entry.plyOnBoard);
	assert.equal(
		startedEarly.length,
		session.state.lineMoves.length,
		`every ply's search should begin before its animation; got ${startedEarly.length}`,
	);
	assert.ok(session.renders.board > 0, "the board still animates during the review");
});
