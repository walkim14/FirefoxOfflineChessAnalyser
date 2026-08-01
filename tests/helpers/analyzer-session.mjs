// Headless stand-in for `app/core/analyzer-app.mjs`: wires the same two
// controllers over the same tree state, with rendering replaced by counters so
// the analysis/gameplay logic can be driven without a DOM.
import { createRequire } from "node:module";
import {
	createTreeNode as createTreeNodeState,
	getTreeNode as getTreeNodeState,
	initializeMoveTreeFromLine as initializeMoveTreeFromLineState,
	resetMoveTree as resetMoveTreeState,
	setCurrentNode as setCurrentNodeState,
	setCurrentPlyOnActiveLine as setCurrentPlyOnActiveLineState,
	syncLineFromTree as syncLineFromTreeState,
	uciToMoveObject,
	verboseMoveToUci,
} from "../../app/state/tree-state.mjs";
import { createAnalysisController } from "../../app/core/controllers/analysis-controller.mjs";
import { createGameplayController } from "../../app/core/controllers/gameplay-controller.mjs";
import { classifyMove } from "../../app/move-classifier.mjs";
import { analyzeWithFallback } from "../../app/analysis-fallback.mjs";
import { isReviewSkipLabel } from "../../app/ui/classification-view.mjs";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");

export const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const PIECE_CP = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/**
 * Deterministic engine stub with the same concurrency contract as
 * `StockfishClient`: a new request cancels whatever search is still running.
 * `cancellations` therefore counts how often the app fought itself for the
 * engine, which is exactly what the analysis pipeline must avoid.
 */
export class FakeEngine {
	constructor({ latencyMs = 0 } = {}) {
		this.latencyMs = latencyMs;
		this.calls = [];
		this.cancellations = 0;
		this.cancelPending = null;
	}

	async analyze(fen, { depth = 22, multiPV = 3 } = {}) {
		this.calls.push({ fen, depth, multiPV });

		if (this.cancelPending) {
			const cancel = this.cancelPending;
			this.cancelPending = null;
			this.cancellations += 1;
			cancel(new Error("Canceled by newer request."));
		}

		let cancelThisCall = null;
		const canceled = new Promise((resolve, reject) => {
			cancelThisCall = reject;
		});
		canceled.catch(() => {});
		this.cancelPending = cancelThisCall;

		try {
			await Promise.race([delay(this.latencyMs), canceled]);

			const game = new Chess(fen);
			const moves = game.moves({ verbose: true });
			const sideToMove = game.turn();
			const cpWhite = this.materialCp(game);
			const lines = [];

			for (let i = 0; i < Math.max(1, multiPV) && i < moves.length; i += 1) {
				const move = moves[i];
				const uci = `${move.from}${move.to}${move.promotion || ""}`;
				const lineCp = cpWhite - i * 15;
				lines.push({
					multipv: i + 1,
					depth,
					move: uci,
					pv: uci,
					scoreType: "cp",
					scoreValue: sideToMove === "w" ? lineCp : -lineCp,
					cpWhite: lineCp,
					evalText: (lineCp / 100).toFixed(2),
					winPercentWhite: 50,
				});
			}

			return {
				fen,
				sideToMove,
				requestedDepth: depth,
				requestedMultiPV: multiPV,
				depthReached: depth,
				nps: 1000,
				nodes: 1000,
				bestMove: moves[0] ? `${moves[0].from}${moves[0].to}${moves[0].promotion || ""}` : null,
				lines,
				cpWhite,
				evalText: (cpWhite / 100).toFixed(2),
				winPercentWhite: 50,
			};
		} finally {
			if (this.cancelPending === cancelThisCall) {
				this.cancelPending = null;
			}
		}
	}

	materialCp(game) {
		let score = 0;
		for (const row of game.board()) {
			for (const piece of row) {
				if (!piece) {
					continue;
				}
				const value = PIECE_CP[piece.type] || 0;
				score += piece.color === "w" ? value : -value;
			}
		}
		return score;
	}

	callsFor(fen) {
		return this.calls.filter((call) => call.fen === fen);
	}
}

export function createSession({ engine = new FakeEngine(), depth = 12, multiPV = 3, playbackDelayMs = 0 } = {}) {
	const state = {
		startFen: INITIAL_FEN,
		treeRootId: 1,
		currentNodeId: 1,
		nextTreeNodeId: 2,
		treeNodes: new Map(),
		mainlineNodeIds: [1],
		activeLineNodeIds: [1],
		lineMoves: [],
		timelineFens: [INITIAL_FEN],
		clockTimeline: [{ white: null, black: null }],
		currentPly: 0,
		orientation: "white",
		selectedSquare: null,
		legalTargets: [],
		players: { whiteName: "White", blackName: "Black", whiteElo: null, blackElo: null },
		settings: { depth, multiPV, playerElo: 1600, reviewMode: false },
		positionCache: new Map(),
		moveClassifications: [],
		latestPositionAnalysisToken: 0,
		latestMoveAnalysisToken: 0,
		mainlineScanToken: 0,
		scanInProgress: false,
		scanProgress: { total: 0, done: 0, phase: "idle" },
		analysisDebounceHandle: null,
		isClassifying: false,
		latestBestMove: null,
		latestBestMoveFen: null,
		latestClassification: null,
		reviewPlaybackToken: 0,
		reviewAnimating: false,
		treeExpandedParents: new Set(),
		annotationDialogNodeId: null,
	};

	const log = { statuses: [], debug: [] };
	// `refs` is intentionally empty: every DOM helper bails out early, which is
	// exactly the "no element found" path the real page must also survive.
	const refs = {};

	const getTreeNode = (nodeId) => getTreeNodeState(state, nodeId);
	const syncLineFromTree = () => syncLineFromTreeState(state);
	const setCurrentNode = (nodeId) => setCurrentNodeState(state, nodeId);
	const setCurrentPlyOnActiveLine = (ply) => setCurrentPlyOnActiveLineState(state, ply, clamp);
	const gameAtPly = (ply) => {
		const safePly = clamp(ply, 0, Math.max(0, state.timelineFens.length - 1));
		return new Chess(state.timelineFens[safePly]);
	};
	const cacheKeyFor = (fen, cacheDepth, cacheMultiPV) => `${fen}|d${cacheDepth}|pv${cacheMultiPV}`;
	const getCachedAnalysis = (fen, wantDepth, wantMultiPV, allowClosest = false) => {
		const exact = state.positionCache.get(cacheKeyFor(fen, wantDepth, wantMultiPV));
		if (exact) {
			return { analysis: exact, mode: "exact" };
		}
		if (!allowClosest) {
			return null;
		}

		let best = null;
		for (const [key, value] of state.positionCache.entries()) {
			if (!key.startsWith(`${fen}|d`)) {
				continue;
			}
			const match = key.match(/\|d(\d+)\|pv(\d+)$/);
			if (!match) {
				continue;
			}
			const score = Number(match[1]) * 10 + Number(match[2]);
			if (!best || score > best.score) {
				best = { analysis: value, score };
			}
		}

		return best ? { analysis: best.analysis, mode: "approx" } : null;
	};

	const renders = { board: 0, evalBar: 0, full: 0, classification: 0, engineLines: 0 };
	const noop = () => {};
	const clearSelection = () => {
		state.selectedSquare = null;
		state.legalTargets = [];
	};

	const analysisController = createAnalysisController({
		state,
		refs,
		engine,
		Chess,
		classifyMove,
		analyzeWithFallback,
		SCAN_PLAYBACK_DELAY_MS: playbackDelayMs,
		clamp,
		delay,
		gameAtPly,
		cacheKeyFor,
		getCachedAnalysis,
		getTreeNode,
		setCurrentPlyOnActiveLine,
		syncLineFromTree,
		setStatus: (text) => log.statuses.push(text),
		debugLog: (message, payload) => log.debug.push({ message, payload }),
		clearSelection,
		renderBoard: () => {
			renders.board += 1;
		},
		renderEvalBar: () => {
			renders.evalBar += 1;
		},
		renderMoveTreePanel: noop,
		render: () => {
			renders.full += 1;
		},
		updateClassificationView: () => {
			renders.classification += 1;
		},
		updateEngineLinesView: () => {
			renders.engineLines += 1;
		},
	});

	const gameplayController = createGameplayController({
		state,
		Chess,
		REVIEW_PLAYBACK_DELAY_MS: playbackDelayMs,
		clamp,
		delay,
		getTreeNode,
		setCurrentNode,
		setCurrentPlyOnActiveLine,
		syncLineFromTree,
		createTreeNode: createTreeNodeState,
		uciToMoveObject,
		verboseMoveToUci,
		isReviewSkipLabel,
		queueMoveClassification: (params) => analysisController.queueMoveClassification(params),
		schedulePositionAnalysis: (ms) => analysisController.schedulePositionAnalysis(ms),
		cancelMainlineScan: () => analysisController.cancelMainlineScan(),
		clearSelection,
		render: () => {
			renders.full += 1;
		},
		renderBoard: () => {
			renders.board += 1;
		},
		renderPlayers: noop,
		closeTreeAnnotationDialog: noop,
		requestPromotionChoice: async () => "q",
		setStatus: (text) => log.statuses.push(text),
		debugLog: (message, payload) => log.debug.push({ message, payload }),
	});

	function loadLine(startFen, lineMoves, clockTimeline = null) {
		analysisController.clearCaches();
		initializeMoveTreeFromLineState(state, startFen, lineMoves, clockTimeline, Chess);
		state.startFen = startFen;
		state.currentNodeId = state.treeRootId;
		state.mainlineNodeIds = state.activeLineNodeIds.slice();
		syncLineFromTree();
	}

	/** Lets pending debounces/timers settle over roughly `totalMs`. */
	async function settle(totalMs = 20) {
		const ticks = 10;
		for (let i = 0; i < ticks; i += 1) {
			await delay(Math.max(1, Math.round(totalMs / ticks)));
		}
	}

	return {
		state,
		log,
		renders,
		engine,
		Chess,
		analysisController,
		gameplayController,
		loadLine,
		settle,
		getTreeNode,
		resetMoveTree: (fen) => resetMoveTreeState(state, fen),
	};
}
