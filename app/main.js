import { Chess } from "../vendor/chess.js";
import { StockfishClient } from "./stockfish-client.js";
import { classifyMove, expectedWhitePercent } from "./move-classifier.mjs";
import { parsePgnToLine } from "./pgn-loader.mjs";
import { analyzeWithFallback } from "./analysis-fallback.mjs";

const DEFAULT_SETTINGS = {
	depth: 22,
	multiPV: 3,
	hashMb: 128,
	playerElo: 1600,
	boardStyle: "brown",
	pieceStyle: "neo",
	sidebarCollapsed: false,
	reviewMode: false,
};

const CLASS_ICONS = {
	book: "Bk",
	best: "★",
	excellent: "✓",
	good: "+",
	inaccuracy: "?!",
	mistake: "?",
	blunder: "??",
	great: "!",
	brilliant: "‼",
	miss: "⨯",
};

const SCAN_PLAYBACK_DELAY_MS = 120;
const REVIEW_PLAYBACK_DELAY_MS = 170;

const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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
	currentPly: 0,
	orientation: "white",
	selectedSquare: null,
	legalTargets: [],
	players: {
		whiteName: "White",
		blackName: "Black",
		whiteElo: null,
		blackElo: null,
	},
	settings: {
		...DEFAULT_SETTINGS,
	},
	positionCache: new Map(),
	moveClassifications: [],
	latestPositionAnalysisToken: 0,
	latestMoveAnalysisToken: 0,
	mainlineScanToken: 0,
	scanInProgress: false,
	scanProgress: {
		total: 0,
		done: 0,
		phase: "idle",
	},
	lastRenderedPly: 0,
	lastMoveHighlightUci: null,
	analysisDebounceHandle: null,
	isClassifying: false,
	latestBestMove: null,
	latestClassification: null,
	reviewPlaybackToken: 0,
	reviewAnimating: false,
	treeExpandedParents: new Set(),
};

const refs = {
	board: document.getElementById("board"),
	status: document.getElementById("status"),
	pgnInput: document.getElementById("pgn-input"),
	fenInput: document.getElementById("fen-input"),
	loadPgnBtn: document.getElementById("load-pgn-btn"),
	loadFenBtn: document.getElementById("load-fen-btn"),
	prevBtn: document.getElementById("prev-btn"),
	nextBtn: document.getElementById("next-btn"),
	flipBtn: document.getElementById("flip-btn"),
	resetBtn: document.getElementById("reset-btn"),
	depthInput: document.getElementById("depth-input"),
	multipvInput: document.getElementById("multipv-input"),
	hashInput: document.getElementById("hash-input"),
	eloInput: document.getElementById("elo-input"),
	applySettingsBtn: document.getElementById("apply-settings-btn"),
	analyzeBtn: document.getElementById("analyze-btn"),
	boardStyleSelect: document.getElementById("board-style-select"),
	pieceStyleSelect: document.getElementById("piece-style-select"),
	applyThemeBtn: document.getElementById("apply-theme-btn"),
	toggleSideBtn: document.getElementById("toggle-side-btn"),
	reviewModeToggle: document.getElementById("review-mode-toggle"),
	sidePanel: document.getElementById("side-panel"),
	classificationPill: document.getElementById("classification-pill"),
	classificationMeta: document.getElementById("classification-meta"),
	overviewWhite: document.getElementById("overview-white"),
	overviewBlack: document.getElementById("overview-black"),
	overviewBreakdown: document.getElementById("overview-breakdown"),
	treePath: document.getElementById("tree-path"),
	treeChildren: document.getElementById("tree-children"),
	engineLines: document.getElementById("engine-lines"),
	moveList: document.getElementById("move-list"),
	boardOverlay: document.getElementById("board-overlay"),
	evalBlack: document.getElementById("eval-black"),
	evalWhite: document.getElementById("eval-white"),
	evalLabel: document.getElementById("eval-label"),
	playerTop: document.getElementById("player-top"),
	playerBottom: document.getElementById("player-bottom"),
	scanProgressWrap: document.getElementById("scan-progress-wrap"),
	scanProgressBar: document.getElementById("scan-progress-bar"),
	scanProgressLabel: document.getElementById("scan-progress-label"),
	scrubberLabel: document.getElementById("scrubber-label"),
	timelineScrubber: document.getElementById("timeline-scrubber"),
	treeAnnotationSubtitle: document.getElementById("tree-annotation-subtitle"),
	treeAnnotationLabelInput: document.getElementById("tree-annotation-label-input"),
	treeAnnotationNoteInput: document.getElementById("tree-annotation-note-input"),
	treeAnnotationSaveBtn: document.getElementById("tree-annotation-save-btn"),
	treeAnnotationClearBtn: document.getElementById("tree-annotation-clear-btn"),
};

const engine = new StockfishClient({ debugLabel: "ui", debug: true });

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createTreeNode({ id, fen, moveUci = null, parentId = null }) {
	return {
		id,
		fen,
		moveUci,
		parentId,
		children: [],
		preferredChildId: null,
		classification: null,
	};
}

function getTreeNode(nodeId) {
	return state.treeNodes.get(nodeId) || null;
}

function resetMoveTree(startFen) {
	const root = createTreeNode({ id: 1, fen: startFen });
	state.treeNodes = new Map([[1, root]]);
	state.treeRootId = 1;
	state.currentNodeId = 1;
	state.nextTreeNodeId = 2;
	state.mainlineNodeIds = [1];
	state.activeLineNodeIds = [1];
	state.lineMoves = [];
	state.timelineFens = [startFen];
	state.moveClassifications = [];
	state.currentPly = 0;
	state.treeExpandedParents = new Set();
}

function initializeMoveTreeFromLine(startFen, lineMoves) {
	resetMoveTree(startFen);
	let cursor = getTreeNode(state.treeRootId);
	const game = new Chess(startFen);

	for (const uci of lineMoves) {
		const applied = game.move(uciToMoveObject(uci));
		if (!applied) {
			break;
		}

		const nodeId = state.nextTreeNodeId;
		state.nextTreeNodeId += 1;
		const child = createTreeNode({
			id: nodeId,
			fen: game.fen(),
			moveUci: uci,
			parentId: cursor.id,
		});
		state.treeNodes.set(nodeId, child);
		cursor.children.push(nodeId);
		cursor.preferredChildId = nodeId;
		cursor = child;
	}

	syncLineFromTree();
	state.mainlineNodeIds = state.activeLineNodeIds.slice();
}

function getActiveLineFromTree() {
	const nodeIds = [state.treeRootId];
	const moves = [];
	const timeline = [getTreeNode(state.treeRootId)?.fen || state.startFen];
	let cursor = getTreeNode(state.treeRootId);

	while (cursor) {
		const nextId = cursor.preferredChildId || cursor.children[0];
		if (!nextId) {
			break;
		}

		const child = getTreeNode(nextId);
		if (!child) {
			break;
		}

		nodeIds.push(child.id);
		moves.push(child.moveUci);
		timeline.push(child.fen);
		cursor = child;
	}

	return { nodeIds, moves, timeline };
}

function syncLineFromTree() {
	const activeLine = getActiveLineFromTree();
	state.activeLineNodeIds = activeLine.nodeIds;
	state.lineMoves = activeLine.moves;
	state.timelineFens = activeLine.timeline;
	state.moveClassifications = state.activeLineNodeIds
		.slice(1)
		.map((nodeId) => getTreeNode(nodeId)?.classification || null);

	const currentIndex = state.activeLineNodeIds.indexOf(state.currentNodeId);
	state.currentPly = currentIndex >= 0 ? currentIndex : 0;
}

function promotePathToNode(nodeId) {
	const node = getTreeNode(nodeId);
	if (!node) {
		return;
	}

	const path = [];
	let cursor = node;
	while (cursor && cursor.parentId) {
		path.push({ parentId: cursor.parentId, childId: cursor.id });
		cursor = getTreeNode(cursor.parentId);
	}

	path.reverse();
	for (const step of path) {
		const parent = getTreeNode(step.parentId);
		if (parent) {
			parent.preferredChildId = step.childId;
		}
	}
}

function setCurrentNode(nodeId) {
	if (!getTreeNode(nodeId)) {
		return;
	}

	promotePathToNode(nodeId);
	state.currentNodeId = nodeId;
	syncLineFromTree();
}

function setCurrentPlyOnActiveLine(ply) {
	const safePly = clamp(ply, 0, state.activeLineNodeIds.length - 1);
	const nodeId = state.activeLineNodeIds[safePly];
	if (nodeId) {
		state.currentNodeId = nodeId;
	}
	syncLineFromTree();
}

function renderMoveTreePanel() {
	if (!refs.treePath || !refs.treeChildren) {
		return;
	}

	const referenceLineNodeIds = state.mainlineNodeIds.length > 0 ? state.mainlineNodeIds : getReferenceMainlineNodeIds();
	if (referenceLineNodeIds.length <= 1) {
		refs.treePath.innerHTML = "<div class='line-item'>No moves in tree yet.</div>";
		refs.treeChildren.innerHTML = "";
		return;
	}

	const treeHtml = renderLineBlock(referenceLineNodeIds[0], 1, "mainline", 0);
	refs.treePath.innerHTML = `<div class="tree-branch-panel"><div class="tree-mainline-rail" aria-hidden="true"></div><div class="tree-rows">${treeHtml}</div></div>`;
	refs.treeChildren.innerHTML = "";

	refs.treePath.querySelectorAll("button[data-tree-action='jump-node']").forEach((button) => {
		button.addEventListener("click", () => {
			const nodeId = Number(button.getAttribute("data-node-id"));
			setCurrentNode(nodeId);
			clearSelection();
			render();
			schedulePositionAnalysis(80);
		});
	});

	refs.treePath.querySelectorAll("button[data-tree-action='toggle-variations']").forEach((button) => {
		button.addEventListener("click", () => {
			const parentNodeId = Number(button.getAttribute("data-parent-node-id"));
			if (!parentNodeId) {
				return;
			}

			if (state.treeExpandedParents.has(parentNodeId)) {
				state.treeExpandedParents.delete(parentNodeId);
			} else {
				state.treeExpandedParents.add(parentNodeId);
			}
			render();
		});
	});
}

function getReferenceMainlineNodeIds() {
	const nodeIds = [state.treeRootId];
	let cursor = getTreeNode(state.treeRootId);

	while (cursor && cursor.children.length) {
		const nextId = cursor.children[0];
		const child = getTreeNode(nextId);
		if (!child) {
			break;
		}

		nodeIds.push(child.id);
		cursor = child;
	}

	return nodeIds;
}

function getNodePathSet(nodeId) {
	const ids = new Set();
	let cursor = getTreeNode(nodeId);

	while (cursor) {
		ids.add(cursor.id);
		cursor = cursor.parentId ? getTreeNode(cursor.parentId) : null;
	}

	return ids;
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

function verboseMoveToUci(move) {
	return `${move.from}${move.to}${move.promotion || ""}`;
}

function gameAtPly(ply) {
	const safePly = clamp(ply, 0, Math.max(0, state.timelineFens.length - 1));
	return new Chess(state.timelineFens[safePly]);
}

function cacheKeyFor(fen, depth, multiPV) {
	return `${fen}|d${depth}|pv${multiPV}`;
}

function getCachedAnalysis(fen, depth, multiPV, allowClosest = false) {
	const exact = state.positionCache.get(cacheKeyFor(fen, depth, multiPV));
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

		const depthCached = Number(match[1]);
		const pvCached = Number(match[2]);
		const score = depthCached * 10 + pvCached;

		if (!best || score > best.score) {
			best = { analysis: value, score };
		}
	}

	if (!best) {
		return null;
	}

	return { analysis: best.analysis, mode: "approx" };
}

function bestMoveForDisplayedPly() {
	if (state.currentPly <= 0) {
		return state.latestBestMove;
	}

	const moveIndex = state.currentPly - 1;
	const moveClassification = state.moveClassifications[moveIndex];
	if (moveClassification?.bestMove) {
		return moveClassification.bestMove;
	}

	const beforeFen = state.timelineFens[moveIndex];
	if (!beforeFen) {
		return null;
	}

	const cached = getCachedAnalysis(beforeFen, state.settings.depth, state.settings.multiPV, true);
	return cached?.analysis?.bestMove || null;
}

function squareCenterOnOverlay(square) {
	const index = squareDisplayIndex(square);
	return {
		x: index.x * 100 + 50,
		y: index.y * 100 + 50,
	};
}

function squareDisplayIndex(square) {
	const file = square.charCodeAt(0) - "a".charCodeAt(0);
	const rank = Number(square[1]);

	const xIndex = state.orientation === "white" ? file : 7 - file;
	const yIndex = state.orientation === "white" ? 8 - rank : rank - 1;

	return {
		x: xIndex,
		y: yIndex,
	};
}

function formatPlayerLine(name, elo) {
	const safeName = name || "Player";
	if (!elo) {
		return safeName;
	}
	return `${safeName} (${elo})`;
}

function renderPlayers() {
	if (!refs.playerTop || !refs.playerBottom) {
		return;
	}

	const whiteText = formatPlayerLine(state.players.whiteName, state.players.whiteElo);
	const blackText = formatPlayerLine(state.players.blackName, state.players.blackElo);

	if (state.orientation === "white") {
		refs.playerTop.textContent = blackText;
		refs.playerBottom.textContent = whiteText;
	} else {
		refs.playerTop.textContent = whiteText;
		refs.playerBottom.textContent = blackText;
	}
}

function renderEvalBar() {
	if (!refs.evalBlack || !refs.evalWhite || !refs.evalLabel) {
		return;
	}

	const game = gameAtPly(state.currentPly);
	const fen = game.fen();
	const cachedResult = getCachedAnalysis(fen, state.settings.depth, state.settings.multiPV, true);
	const winWhite = cachedResult?.analysis?.winPercentWhite ?? 50;
	const whiteHeight = clamp(winWhite, 0, 100);
	const blackHeight = 100 - whiteHeight;

	refs.evalWhite.style.height = `${whiteHeight}%`;
	refs.evalBlack.style.height = `${blackHeight}%`;

	const cp = cachedResult?.analysis?.cpWhite;
	if (typeof cp === "number") {
		const pawns = cp / 100;
		refs.evalLabel.textContent = pawns >= 0 ? `+${pawns.toFixed(1)}` : pawns.toFixed(1);
	} else {
		refs.evalLabel.textContent = "=";
	}
}

function renderBoardOverlay() {
	if (!refs.boardOverlay) {
		return;
	}

	const bestArrowMove = bestMoveForDisplayedPly();

	if (!bestArrowMove || bestArrowMove.length < 4) {
		refs.boardOverlay.innerHTML = "";
		return;
	}

	const bestFrom = bestArrowMove.slice(0, 2);
	const bestTo = bestArrowMove.slice(2, 4);
	const bestFromPoint = squareCenterOnOverlay(bestFrom);
	const bestToPoint = squareCenterOnOverlay(bestTo);
	const dx = bestToPoint.x - bestFromPoint.x;
	const dy = bestToPoint.y - bestFromPoint.y;
	const length = Math.hypot(dx, dy) || 1;
	const tailOffset = 16;
	const headLength = 24;
	const headWidth = 18;
	const tipGap = 3;
	const startX = bestFromPoint.x + (dx / length) * tailOffset;
	const startY = bestFromPoint.y + (dy / length) * tailOffset;
	const tipX = bestToPoint.x - (dx / length) * tipGap;
	const tipY = bestToPoint.y - (dy / length) * tipGap;
	const baseCenterX = tipX - (dx / length) * headLength;
	const baseCenterY = tipY - (dy / length) * headLength;
	const nx = -dy / length;
	const ny = dx / length;
	const leftX = baseCenterX + nx * (headWidth / 2);
	const leftY = baseCenterY + ny * (headWidth / 2);
	const rightX = baseCenterX - nx * (headWidth / 2);
	const rightY = baseCenterY - ny * (headWidth / 2);
	const lineEndX = baseCenterX - (dx / length) * 2;
	const lineEndY = baseCenterY - (dy / length) * 2;

	refs.boardOverlay.innerHTML = `
		<line
			x1="${startX}"
			y1="${startY}"
			x2="${lineEndX}"
			y2="${lineEndY}"
			stroke="#f3c251"
			stroke-width="9"
			stroke-linecap="round"
		></line>
		<polygon points="${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}" fill="#f3c251"></polygon>
	`;
}

function shortLabelForTag(label) {
	const normalized = String(label || "").toLowerCase();
	return CLASS_ICONS[normalized] || normalized.toUpperCase();
}

function classificationHighlightColor(label) {
	const slug = String(label || "").toLowerCase().replace(/\s+/g, "-");
	const colors = {
		book: "#86d6ef",
		best: "#1dd861",
		excellent: "#6af19c",
		good: "#86efac",
		great: "#86efac",
		brilliant: "#86d6ef",
		inaccuracy: "#fcd34d",
		mistake: "#fca5a5",
		miss: "#fca5a5",
		blunder: "#ef4444",
	};

	return colors[slug] || "#86efac";
}

function isReviewSkipLabel(label) {
	const slug = String(label || "").toLowerCase().replace(/\s+/g, "-");
	return slug === "book" || slug === "good" || slug === "excellent";
}

function isBottomBoardMove(ply) {
	if (ply < 1 || ply > state.lineMoves.length) {
		return false;
	}

	const beforeFen = state.timelineFens[ply - 1];
	if (!beforeFen) {
		return false;
	}

	const moverColor = new Chess(beforeFen).turn();
	const bottomColor = state.orientation === "white" ? "w" : "b";
	return moverColor === bottomColor;
}

function reviewStopPly(direction) {
	if (direction > 0) {
		for (let ply = state.currentPly + 1; ply <= state.lineMoves.length; ply += 1) {
			if (!isBottomBoardMove(ply)) {
				continue;
			}
			const classification = state.moveClassifications[ply - 1];
			if (!classification) {
				return ply;
			}
			if (!isReviewSkipLabel(classification.label)) {
				return ply;
			}
		}
		return state.lineMoves.length;
	}

	for (let ply = state.currentPly - 1; ply >= 1; ply -= 1) {
		if (!isBottomBoardMove(ply)) {
			continue;
		}
		const classification = state.moveClassifications[ply - 1];
		if (!classification) {
			return ply;
		}
		if (!isReviewSkipLabel(classification.label)) {
			return ply;
		}
	}

	return 0;
}

async function animateToPly(targetPly) {
	const clampedTarget = clamp(targetPly, 0, state.lineMoves.length);
	if (clampedTarget === state.currentPly) {
		render();
		schedulePositionAnalysis(80);
		return;
	}

	const token = ++state.reviewPlaybackToken;
	state.reviewAnimating = true;
	clearSelection();

	const direction = clampedTarget > state.currentPly ? 1 : -1;
	while (state.currentPly !== clampedTarget) {
		if (token !== state.reviewPlaybackToken) {
			state.reviewAnimating = false;
			return;
		}

		setCurrentPlyOnActiveLine(state.currentPly + direction);
		render();
		await delay(REVIEW_PLAYBACK_DELAY_MS);
	}

	state.reviewAnimating = false;
	schedulePositionAnalysis(80);
}

async function goPrev() {
	if (state.reviewAnimating) {
		return;
	}

	if (state.settings.reviewMode) {
		const targetPly = reviewStopPly(-1);
		await animateToPly(targetPly);
		return;
	}

	const current = getTreeNode(state.currentNodeId);
	if (!current || !current.parentId) {
		return;
	}
	setCurrentNode(current.parentId);
	clearSelection();
	render();
	schedulePositionAnalysis(80);
}

async function goNext() {
	if (state.reviewAnimating) {
		return;
	}

	if (state.settings.reviewMode) {
		const targetPly = reviewStopPly(1);
		await animateToPly(targetPly);
		return;
	}

	const current = getTreeNode(state.currentNodeId);
	if (!current) {
		return;
	}
	const nextId = current.preferredChildId || current.children[0];
	if (!nextId) {
		return;
	}
	setCurrentNode(nextId);
	clearSelection();
	render();
	schedulePositionAnalysis(80);
}

function onGlobalKeyDown(event) {
	if (event.defaultPrevented) {
		return;
	}

	const target = event.target;
	if (target instanceof HTMLElement) {
		const tag = target.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
			return;
		}
	}

	if (event.key === "ArrowLeft") {
		event.preventDefault();
		goPrev();
		return;
	}

	if (event.key === "ArrowRight") {
		event.preventDefault();
		goNext();
	}
}

function setStatus(text) {
	refs.status.textContent = text;
}

function getPieceAssetUrl(piece) {
	return chrome.runtime.getURL(`assets/pieces/${state.settings.pieceStyle}/${piece.color}${piece.type}.png`);
}

function applyBoardTheme() {
	if (!refs.board) {
		return;
	}
	const boardUrl = chrome.runtime.getURL(`assets/boards/${state.settings.boardStyle}.png`);
	refs.board.style.backgroundImage = `url("${boardUrl}")`;
}

function syncSidebarState() {
	if (!refs.sidePanel || !refs.toggleSideBtn) {
		return;
	}

	if (state.settings.sidebarCollapsed) {
		refs.sidePanel.classList.add("collapsed");
		refs.toggleSideBtn.textContent = "Show Controls";
	} else {
		refs.sidePanel.classList.remove("collapsed");
		refs.toggleSideBtn.textContent = "Hide Controls";
	}
}

function toggleSidebarCollapsed(nextValue) {
	state.settings.sidebarCollapsed = Boolean(nextValue);
	syncSidebarState();
	saveSettings();
}

function applyThemeFromControls() {
	state.settings.boardStyle = refs.boardStyleSelect.value || "brown";
	state.settings.pieceStyle = refs.pieceStyleSelect.value || "neo";
	applyBoardTheme();
	saveSettings();
	render();
}

function debugLog(message, payload) {
	if (payload === undefined) {
		console.debug(`[app] ${message}`);
		return;
	}

	console.debug(`[app] ${message}`, payload);
}

function storageGet(key) {
	return new Promise((resolve, reject) => {
		try {
			const maybePromise = chrome.storage.local.get(key, (value) => {
				const err = chrome.runtime?.lastError;
				if (err) {
					reject(new Error(err.message));
					return;
				}
				resolve(value || {});
			});

			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise.then(resolve).catch(reject);
			}
		} catch (error) {
			reject(error);
		}
	});
}

function storageSet(value) {
	return new Promise((resolve, reject) => {
		try {
			const maybePromise = chrome.storage.local.set(value, () => {
				const err = chrome.runtime?.lastError;
				if (err) {
					reject(new Error(err.message));
					return;
				}
				resolve();
			});

			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise.then(resolve).catch(reject);
			}
		} catch (error) {
			reject(error);
		}
	});
}

async function consumePendingPgnImport() {
	try {
		const importTab = new URLSearchParams(globalThis.location?.search || "").get("importTab");
		if (importTab) {
			debugLog("Checking tab-scoped pending import", { importTab });
			const scoped = await storageGet("pendingPgnImportByTab");
			const byTab = scoped?.pendingPgnImportByTab || {};
			const pendingByTab = byTab[importTab];
			if (pendingByTab && typeof pendingByTab.pgn === "string" && pendingByTab.pgn.trim()) {
				debugLog("Consuming tab-scoped pending import", { importTab, pgnLength: pendingByTab.pgn.length });
				refs.pgnInput.value = pendingByTab.pgn;
				const nextByTab = { ...byTab };
				delete nextByTab[importTab];
				await storageSet({ pendingPgnImportByTab: nextByTab });
				loadPgnFromInput();
				setStatus("Imported PGN from chess.com game page.");
				return true;
			}
			debugLog("No tab-scoped pending import found", { importTab, availableKeys: Object.keys(byTab || {}) });
		}

		const data = await storageGet("pendingPgnImport");
		const pending = data?.pendingPgnImport;
		if (!pending || typeof pending.pgn !== "string" || !pending.pgn.trim()) {
			return false;
		}

		refs.pgnInput.value = pending.pgn;
		await storageSet({ pendingPgnImport: null });
		loadPgnFromInput();
		setStatus("Imported PGN from chess.com archive.");
		return true;
	} catch (error) {
		debugLog("Pending PGN import failed", String(error?.message || error));
		return false;
	}
}

function saveSettings() {
	storageSet({ settings: state.settings }).catch(() => {
		// Storage failures should not block analysis use.
	});
}

async function loadSettings() {
	const stored = await storageGet("settings");
	if (stored?.settings) {
		state.settings = {
			...DEFAULT_SETTINGS,
			...stored.settings,
		};
	}

	refs.depthInput.value = String(state.settings.depth);
	refs.multipvInput.value = String(state.settings.multiPV);
	refs.hashInput.value = String(state.settings.hashMb);
	refs.eloInput.value = String(state.settings.playerElo);
	refs.boardStyleSelect.value = state.settings.boardStyle;
	refs.pieceStyleSelect.value = state.settings.pieceStyle;
	refs.reviewModeToggle.checked = Boolean(state.settings.reviewMode);
	applyBoardTheme();
	syncSidebarState();
}

function loadPgnFromInput() {
	const pgn = refs.pgnInput?.value?.trim() || "";
	if (!pgn) {
		setStatus("Paste a PGN first.");
		return;
	}

	try {
		const parsed = parsePgnToLine(pgn, Chess);
		state.startFen = parsed.startFen;
		state.lineMoves = parsed.lineMoves;
		state.players.whiteName = parsed.headers?.White || "White";
		state.players.blackName = parsed.headers?.Black || "Black";
		state.players.whiteElo = parsed.whiteElo;
		state.players.blackElo = parsed.blackElo;
		if (parsed.suggestedElo) {
			state.settings.playerElo = clamp(parsed.suggestedElo, 400, 3000);
			refs.eloInput.value = String(state.settings.playerElo);
			saveSettings();
		}
		debugLog("PGN loaded", {
			plies: parsed.lineMoves.length,
			whiteElo: parsed.whiteElo,
			blackElo: parsed.blackElo,
			suggestedElo: parsed.suggestedElo,
		});
	} catch (error) {
		setStatus(error?.message || "PGN parse failed.");
		return;
	}

	initializeMoveTreeFromLine(state.startFen, state.lineMoves);
	state.currentNodeId = state.treeRootId;
	state.mainlineNodeIds = state.activeLineNodeIds.slice();
	buildTimelineFromLine();
	clearCaches();
	toggleSidebarCollapsed(true);
	clearSelection();
	render();
	setStatus(`Loaded PGN with ${state.lineMoves.length} plies.`);
	schedulePositionAnalysis(80);
	scanMainlineClassifications();
}

function loadFenFromInput() {
	const fen = refs.fenInput?.value?.trim() || "";
	if (!fen) {
		setStatus("Enter a FEN first.");
		return;
	}

	try {
		new Chess(fen);
	} catch {
		setStatus("Invalid FEN.");
		return;
	}

	state.startFen = fen;
	state.players.whiteName = "White";
	state.players.blackName = "Black";
	state.players.whiteElo = null;
	state.players.blackElo = null;
	resetMoveTree(fen);
	clearCaches();
	clearSelection();
	render();
	setStatus("Custom FEN loaded.");
	schedulePositionAnalysis(80);
}

async function applyEngineSettings() {
	state.settings.depth = clamp(Number(refs.depthInput.value) || 22, 12, 30);
	state.settings.multiPV = clamp(Number(refs.multipvInput.value) || 3, 1, 4);
	state.settings.hashMb = clamp(Number(refs.hashInput.value) || 256, 64, 512);
	state.settings.playerElo = clamp(Number(refs.eloInput.value) || 1600, 400, 3000);
	saveSettings();
	clearCaches();
	buildTimelineFromLine();
	refs.hashInput.value = String(state.settings.hashMb);
	refs.depthInput.value = String(state.settings.depth);
	refs.multipvInput.value = String(state.settings.multiPV);
	refs.eloInput.value = String(state.settings.playerElo);
	render();
	schedulePositionAnalysis(80);
}

function squareName(fileIndex, rankNumber) {
	return `${String.fromCharCode("a".charCodeAt(0) + fileIndex)}${rankNumber}`;
}

function boardCoordinates() {
	const files = state.orientation === "white" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
	const ranks = state.orientation === "white" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];

	const coords = [];
	for (const rank of ranks) {
		for (const file of files) {
			coords.push(squareName(file, rank));
		}
	}
	return coords;
}

function pieceAtSquare(game, square) {
	return game.get(square);
}

function clearSelection() {
	state.selectedSquare = null;
	state.legalTargets = [];
}

function clearCaches() {
	state.positionCache.clear();
	for (const node of state.treeNodes.values()) {
		node.classification = null;
	}
	state.moveClassifications = state.activeLineNodeIds.slice(1).map(() => null);
	state.latestClassification = null;
	state.latestBestMove = null;
	state.reviewPlaybackToken += 1;
	state.reviewAnimating = false;
	state.mainlineScanToken += 1;
	setScanProgress(0, 0, "idle");
}

function setScanProgress(done, total, phase) {
	state.scanProgress.done = done;
	state.scanProgress.total = total;
	state.scanProgress.phase = phase;

	if (!refs.scanProgressWrap || !refs.scanProgressBar || !refs.scanProgressLabel) {
		return;
	}

	refs.scanProgressWrap.classList.remove("hidden");
	refs.scanProgressWrap.classList.toggle("loading", phase === "running" && total > 0);
	if (phase !== "idle" && total > 0) {
		const percent = Math.round((Math.max(0, done) / Math.max(1, total)) * 100);
		refs.scanProgressBar.style.width = `${percent}%`;
		refs.scanProgressLabel.textContent = phase === "running"
			? `Classifying moves: ${Math.max(0, done)}/${total} (${percent}%)`
			: phase === "done"
				? "Analysis complete"
				: phase === "failed"
					? "Analysis failed"
					: phase === "canceled"
						? "Analysis canceled"
						: refs.scanProgressLabel.textContent;
		if (refs.scrubberLabel) {
			refs.scrubberLabel.textContent = `Loading ${percent}%`;
		}
	} else if (phase === "idle") {
		refs.scanProgressBar.style.width = "0%";
		refs.scanProgressLabel.textContent = "";
	}
}

function schedulePositionAnalysis(delayMs = 80) {
	if (state.analysisDebounceHandle) {
		clearTimeout(state.analysisDebounceHandle);
	}

	state.analysisDebounceHandle = setTimeout(() => {
		state.analysisDebounceHandle = null;
		analyzeCurrentPosition().catch((error) => {
			debugLog("Scheduled position analysis failed", String(error?.message || error));
		});
	}, delayMs);
}

async function analyzeCurrentPosition() {
	const game = gameAtPly(state.currentPly);
	const fen = game.fen();
	const cacheKey = cacheKeyFor(fen, state.settings.depth, state.settings.multiPV);
	const cached = getCachedAnalysis(fen, state.settings.depth, state.settings.multiPV, true);

	if (cached?.analysis) {
		const { analysis, mode: cacheMode } = cached;
		state.latestBestMove = analysis.bestMove;
		updateEngineLinesView(analysis);
		renderBoard();
		renderEvalBar();
		const turnLabel = analysis.sideToMove === "w" ? "White" : "Black";
		const cachedSuffix = cacheMode === "approx" ? " | cached (approx)" : " | cached";
		setStatus(
			`${turnLabel} to move | eval ${analysis.evalText} | white win ${analysis.winPercentWhite.toFixed(1)}% | depth ${analysis.depthReached} | nps ${analysis.nps || 0}${cachedSuffix}`,
		);
		return;
	}

	setStatus("Analyzing current position...");
	debugLog("Position analysis requested", { fen, ply: state.currentPly });

	const token = ++state.latestPositionAnalysisToken;
	try {
		const { result: analysis, usedProfile } = await analyzeWithFallback({
			engine,
			fen,
			depth: state.settings.depth,
			multiPV: state.settings.multiPV,
			phase: "position",
			logger: debugLog,
		});

		if (token !== state.latestPositionAnalysisToken) {
			return;
		}

		state.positionCache.set(cacheKey, analysis);
		state.latestBestMove = analysis.bestMove;
		updateEngineLinesView(analysis);
		renderBoard();
		renderEvalBar();

		const turnLabel = analysis.sideToMove === "w" ? "White" : "Black";
		const fallbackSuffix =
			usedProfile.depth !== state.settings.depth || usedProfile.multiPV !== state.settings.multiPV
				? ` | fallback d${usedProfile.depth}/pv${usedProfile.multiPV}`
				: "";
		setStatus(
			`${turnLabel} to move | eval ${analysis.evalText} | white win ${analysis.winPercentWhite.toFixed(1)}% | depth ${analysis.depthReached} | nps ${analysis.nps || 0}${fallbackSuffix}`,
		);
	} catch (error) {
		if (String(error?.message || "") === "Canceled by newer request.") {
			return;
		}
		debugLog("Position analysis failed", error);
		setStatus(`Analysis error: ${error?.message || error}`);
	}
}

function renderTimelineScrubber() {
	if (!refs.timelineScrubber || !refs.scrubberLabel || !refs.scanProgressBar || !refs.scanProgressWrap) {
		return;
	}

	const total = state.lineMoves.length;
	const current = clamp(state.currentPly, 0, total);
	refs.timelineScrubber.max = String(total);
	refs.timelineScrubber.value = String(current);
	refs.timelineScrubber.disabled = total === 0;
	refs.scrubberLabel.textContent = total ? `Move ${current} / ${total}` : "No game loaded";

	if (!refs.scanProgressWrap.classList.contains("loading")) {
		const percent = total > 0 ? Math.round((current / Math.max(1, total)) * 100) : 0;
		refs.scanProgressBar.style.width = `${percent}%`;
	}
}

function seekToPly(ply) {
	const safePly = clamp(Number(ply) || 0, 0, state.lineMoves.length);
	state.reviewPlaybackToken += 1;
	state.reviewAnimating = false;
	setCurrentPlyOnActiveLine(safePly);
	clearSelection();
	render();
	schedulePositionAnalysis(80);
}

function saveTreeAnnotation() {
	const node = getTreeNode(state.currentNodeId);
	if (!node) {
		return;
	}

	node.annotationLabel = refs.treeAnnotationLabelInput ? refs.treeAnnotationLabelInput.value.trim() : "";
	node.annotationNote = refs.treeAnnotationNoteInput ? refs.treeAnnotationNoteInput.value.trim() : "";
	render();
}

function clearTreeAnnotation() {
	const node = getTreeNode(state.currentNodeId);
	if (!node) {
		return;
	}

	node.annotationLabel = "";
	node.annotationNote = "";
	if (refs.treeAnnotationLabelInput) {
		refs.treeAnnotationLabelInput.value = "";
	}
	if (refs.treeAnnotationNoteInput) {
		refs.treeAnnotationNoteInput.value = "";
	}
	render();
}

function getScanProfile() {
	return {
		depth: Math.min(state.settings.depth, 18),
		multiPV: Math.min(state.settings.multiPV, 2),
	};
}

function buildTimelineFromLine() {
	syncLineFromTree();
}

function classificationHelpText(label) {
	const slug = classificationSlug(label);
	const helpByLabel = {
		book: "Book: the move matches the offline opening database for this position or resulting transposition. EP = expected points, from 0.0 to 1.0, for the side to move.",
		best: "Best: engine top choice with near-zero expected-point loss. EP = expected points, from 0.0 to 1.0, for the side to move.",
		excellent: "Excellent: very small EP loss. EP = expected points, from 0.0 to 1.0, for the side to move.",
		good: "Good: modest EP loss, usually still close to the best choice. EP = expected points, from 0.0 to 1.0, for the side to move.",
		inaccuracy: "Inaccuracy: noticeable EP loss. EP = expected points, from 0.0 to 1.0, for the side to move.",
		mistake: "Mistake: large EP loss. EP = expected points, from 0.0 to 1.0, for the side to move.",
		miss: "Miss: a missed better move or tactic. EP = expected points, from 0.0 to 1.0, for the side to move.",
		blunder: "Blunder: major EP loss, usually allowing a strong tactical reply. EP = expected points, from 0.0 to 1.0, for the side to move.",
		great: "Great: the best move while alternatives are significantly worse. EP = expected points, from 0.0 to 1.0, for the side to move.",
		brilliant: "Brilliant: a best move with real sacrifice or hidden tactical value. EP = expected points, from 0.0 to 1.0, for the side to move.",
	};

	return helpByLabel[slug] || "Classification help: EP = expected points, from 0.0 to 1.0, for the side to move.";
}

function renderHelpBubble(label, helpText) {
	const safeHelp = escapeHtml(helpText);
	return `<span class="help-bubble" tabindex="0" role="button" aria-label="${escapeHtml(label)} help"><span class="help-bubble-mark">?</span><span class="help-tooltip" role="tooltip">${safeHelp}</span></span>`;
}

function updateClassificationView(result) {
	if (!result) {
		refs.classificationPill.className = "pill neutral";
		refs.classificationPill.textContent = "No move classified yet";
		refs.classificationMeta.innerHTML = "";
		return;
	}

	const labelClass = result.label.toLowerCase().replace(/\s+/g, "-");
	refs.classificationPill.className = `pill ${labelClass}`;
	const icon = CLASS_ICONS[labelClass] || "•";
	refs.classificationPill.innerHTML = `<span class="pill-icon">${icon}</span> ${result.label} ${renderHelpBubble(result.label, classificationHelpText(result.label))} <span class="pill-ep">EP loss ${(result.epLoss * 100).toFixed(1)}%</span>`;

	const bestCp = (result.bestCpWhite / 100).toFixed(2);
	const playedCp = (result.playedCpWhite / 100).toFixed(2);
	const rows = [
		`Best move: ${result.bestMove || "n/a"}`,
		`Played move: ${result.playedMoveUci || "n/a"}`,
		`Eval best: ${bestCp}`,
		`Eval played: ${playedCp}`,
	];

	for (const note of result.notes) {
		rows.push(note);
	}

	refs.classificationMeta.innerHTML = rows.map((row) => `<div class="line-item">${row}</div>`).join("");
}

function updateEngineLinesView(analysis) {
	if (!analysis || analysis.lines.length === 0) {
		refs.engineLines.innerHTML = "<div class='line-item'>No line yet.</div>";
		return;
	}

	refs.engineLines.innerHTML = analysis.lines
		.map((line) => {
			const whiteWin = expectedWhitePercent(line.cpWhite).toFixed(1);
			return `<div class="line-item">#${line.multipv} ${line.move} | eval ${line.evalText} | white win ${whiteWin}%<br>${line.pv}</div>`;
		})
		.join("");
}

function classificationSlug(label) {
	return String(label || "unknown").toLowerCase().replace(/\s+/g, "-");
}

function estimatedMoveAccuracy(classification) {
	if (!classification) {
		return null;
	}

	const slug = classificationSlug(classification.label);
	const baseByLabel = {
		book: 95,
		brilliant: 96,
		great: 92,
		best: 88,
		excellent: 74,
		good: 58,
		inaccuracy: 40,
		mistake: 22,
		miss: 18,
		blunder: 5,
	};
	const base = baseByLabel[slug] ?? 55;

	const epLoss = Math.max(0, Number(classification.epLoss) || 0);
	const cpLoss = Math.max(
		0,
		Math.abs((Number(classification.bestCpWhite) || 0) - (Number(classification.playedCpWhite) || 0)),
	);

	// Calibrated to be closer to practical review scores: strict baseline + tactical penalties.
	const epPenalty = Math.min(18, epLoss * 140);
	const cpPenalty = Math.min(16, cpLoss / 35);
	return clamp(base - epPenalty - cpPenalty, 0, 100);
}

function renderOverview() {
	if (!refs.overviewWhite || !refs.overviewBlack || !refs.overviewBreakdown) {
		return;
	}

	const buckets = {
		white: { totalAccuracy: 0, counted: 0, labels: new Map() },
		black: { totalAccuracy: 0, counted: 0, labels: new Map() },
	};

	for (let ply = 1; ply <= state.lineMoves.length; ply += 1) {
		const nodeId = state.activeLineNodeIds[ply];
		const node = nodeId ? getTreeNode(nodeId) : null;
		const classification = node?.classification || null;
		if (!classification) {
			continue;
		}

		const beforeFen = state.timelineFens[ply - 1];
		if (!beforeFen) {
			continue;
		}

		const mover = new Chess(beforeFen).turn() === "w" ? "white" : "black";
		const label = String(classification.label || "unknown");
		const accuracy = estimatedMoveAccuracy(classification);
		if (accuracy === null) {
			continue;
		}
		const bucket = buckets[mover];
		bucket.totalAccuracy += accuracy;
		bucket.counted += 1;
		bucket.labels.set(label, (bucket.labels.get(label) || 0) + 1);
	}

	const whiteAcc = buckets.white.counted ? (buckets.white.totalAccuracy / buckets.white.counted).toFixed(1) : "-";
	const blackAcc = buckets.black.counted ? (buckets.black.totalAccuracy / buckets.black.counted).toFixed(1) : "-";
	const whiteName = state.players.whiteName || "White";
	const blackName = state.players.blackName || "Black";
	refs.overviewWhite.innerHTML = `
		<div class="overview-player">
			<div class="overview-name">${whiteName}</div>
			<div class="overview-acc">${whiteAcc === "-" ? "-" : `${whiteAcc}%`}</div>
			<div class="overview-count">${buckets.white.counted} classified moves</div>
		</div>
	`;
	refs.overviewBlack.innerHTML = `
		<div class="overview-player">
			<div class="overview-name">${blackName}</div>
			<div class="overview-acc">${blackAcc === "-" ? "-" : `${blackAcc}%`}</div>
			<div class="overview-count">${buckets.black.counted} classified moves</div>
		</div>
	`;

	const allLabels = new Set([...buckets.white.labels.keys(), ...buckets.black.labels.keys()]);
	if (allLabels.size === 0) {
		refs.overviewBreakdown.innerHTML = "<div class='line-item'>Run analysis to see move breakdown.</div>";
		return;
	}

	const labelOrder = ["Book", "Brilliant", "Great", "Best", "Excellent", "Good", "Inaccuracy", "Mistake", "Miss", "Blunder"];
	const orderedLabels = [...allLabels].sort((a, b) => {
		const ai = labelOrder.indexOf(a);
		const bi = labelOrder.indexOf(b);
		if (ai === -1 && bi === -1) {
			return a.localeCompare(b);
		}
		if (ai === -1) {
			return 1;
		}
		if (bi === -1) {
			return -1;
		}
		return ai - bi;
	});

	const rows = [];
	rows.push("<div class='overview-note'>Estimated accuracy uses EP loss + centipawn loss, so it is stricter than the old EP-only method.</div>");
	for (const label of orderedLabels) {
		const w = buckets.white.labels.get(label) || 0;
		const b = buckets.black.labels.get(label) || 0;
		const slug = classificationSlug(label);
		const icon = CLASS_ICONS[slug] || "•";
		rows.push(
			`<div class='overview-row ${slug}'><span class='overview-label'><span class='overview-icon'>${icon}</span>${label}${renderHelpBubble(label, classificationHelpText(label))}</span><span class='overview-values'>${whiteName} ${w} | ${blackName} ${b}</span></div>`,
		);
	}

	refs.overviewBreakdown.innerHTML = `<div class='overview-breakdown-grid'>${rows.join("")}</div>`;
}

function updateMoveList() {
	if (state.lineMoves.length === 0) {
		refs.moveList.innerHTML = "<div class='move-item'>No moves yet.</div>";
		return;
	}

	const entries = [];
	for (let i = 0; i < state.lineMoves.length; i += 1) {
		const ply = i + 1;
		const moveText = state.lineMoves[i];
		const fullMove = Math.ceil(ply / 2);
		const prefix = ply % 2 === 1 ? `${fullMove}.` : `${fullMove}...`;
		const currentClass = state.currentPly === ply ? "current" : "";

		entries.push(
			`<div class="move-item ${currentClass}"><button data-ply="${ply}" type="button">${prefix} ${moveText}</button></div>`,
		);
	}

	refs.moveList.innerHTML = entries.join("");
	refs.moveList.querySelectorAll("button[data-ply]").forEach((button) => {
		button.addEventListener("click", () => {
			state.reviewPlaybackToken += 1;
			state.reviewAnimating = false;
			const ply = Number(button.getAttribute("data-ply"));
			setCurrentPlyOnActiveLine(ply);
			clearSelection();
			render();
			schedulePositionAnalysis(80);
		});
	});
}

function renderBoard() {
	const game = gameAtPly(state.currentPly);
	const squares = boardCoordinates();
	const movedUci = state.currentPly > 0 ? state.lineMoves[state.currentPly - 1] : null;
	const movedFrom = movedUci ? movedUci.slice(0, 2) : null;
	const movedTo = movedUci ? movedUci.slice(2, 4) : null;
	const classificationForPly = state.currentPly > 0 ? state.moveClassifications[state.currentPly - 1] : null;
	const classificationSlug = classificationForPly?.label?.toLowerCase().replace(/\s+/g, "-") || "";
	const playedMoveColor = classificationForPly ? classificationHighlightColor(classificationForPly.label) : null;
	const shouldAnimateMove = state.lastMoveHighlightUci !== movedUci || state.lastRenderedPly !== state.currentPly;
	const shouldFlashSquares =
		shouldAnimateMove && !state.scanInProgress && !state.isClassifying && !state.reviewAnimating;

	refs.board.innerHTML = "";
	for (const square of squares) {
		const fileIndex = square.charCodeAt(0) - "a".charCodeAt(0);
		const rankNumber = Number(square[1]);
		const dark = (fileIndex + rankNumber) % 2 === 0;
		const piece = pieceAtSquare(game, square);
		const pieceImageUrl = piece ? getPieceAssetUrl(piece) : "";

		const button = document.createElement("button");
		button.type = "button";
		button.className = `square ${dark ? "dark" : "light"}`;
		button.dataset.square = square;
		if (piece) {
			let pieceClass = "piece";
			if (shouldAnimateMove && movedTo === square) {
				pieceClass += " move-pop move-slide";
			}
			let slideStyle = "";
			if (shouldAnimateMove && movedFrom && movedTo === square) {
				const fromIdx = squareDisplayIndex(movedFrom);
				const toIdx = squareDisplayIndex(movedTo);
				const slideX = fromIdx.x - toIdx.x;
				const slideY = fromIdx.y - toIdx.y;
				slideStyle = ` style="--slide-x:${slideX};--slide-y:${slideY};"`;
			}
			button.innerHTML = `<img class="${pieceClass}"${slideStyle} src="${pieceImageUrl}" alt="${piece.color}${piece.type}" />`;

			if (classificationForPly && movedTo === square) {
				button.innerHTML += `<span class="move-tag ${classificationSlug}">${shortLabelForTag(classificationForPly.label)}</span>`;
			}
		} else {
			button.textContent = "";
		}

		if (state.selectedSquare === square) {
			button.classList.add("selected");
		}
		if (state.legalTargets.includes(square)) {
			button.classList.add("target");
		}
		if (square === movedFrom) {
			button.classList.add("last-from");
			if (playedMoveColor) {
				button.style.setProperty("--played-move-color", playedMoveColor);
			}
		}
		if (square === movedTo) {
			button.classList.add("last-to");
			if (playedMoveColor) {
				button.style.setProperty("--played-move-color", playedMoveColor);
			}
		}
		if (shouldFlashSquares && square === movedFrom) {
			button.classList.add("from-flash");
		}
		if (shouldFlashSquares && square === movedTo) {
			button.classList.add("to-flash");
		}

		button.addEventListener("click", () => onSquareClick(square));
		refs.board.appendChild(button);
	}

	state.lastMoveHighlightUci = movedUci;
	state.lastRenderedPly = state.currentPly;
	renderBoardOverlay();
}

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"]'/g, (character) => {
		const replacements = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return replacements[character] || character;
	});
}

function getPreferredPathNodeIds(startNodeId) {
	const nodeIds = [];
	let cursor = getTreeNode(startNodeId);

	while (cursor) {
		nodeIds.push(cursor.id);
		const nextId = cursor.preferredChildId || cursor.children[0];
		if (!nextId) {
			break;
		}
		cursor = getTreeNode(nextId);
	}

	return nodeIds;
}

function renderSidelineBody(node, nodePly, mainChildId, laneClass, depth) {
	if (!node) {
		return "";
	}

	const sideChildren = node.children
		.filter((childId) => childId !== mainChildId)
		.map((childId) => getTreeNode(childId))
		.filter(Boolean);

	if (!sideChildren.length) {
		return "";
	}

	const expanded = state.treeExpandedParents.has(node.id);
	const toggle = `<button type="button" class="tree-var-toggle ${expanded ? "expanded" : ""}" data-parent-node-id="${node.id}" data-tree-action="toggle-variations" aria-label="${expanded ? "Collapse" : "Expand"} variations"><span class="tree-var-arrow">${expanded ? "▾" : "▸"}</span></button>`;

	if (!expanded) {
		return `<div class="tree-variation-toggle-row depth-${depth}">${toggle}</div>`;
	}

	const nested = sideChildren
		.map((child) => renderLineBlock(child.id, nodePly + 1, laneClass, depth + 1))
		.join("");

	return `
		<div class="tree-variation-toggle-row depth-${depth}">${toggle}</div>
		<div class="tree-side-block ${laneClass} depth-${depth}">${nested}</div>
	`;
}

function renderNodeCell(node, nodePly, mainChildId, laneClass, depth, cellRole) {
	if (!node) {
		return `<div class="tree-ply-cell ${cellRole} empty"></div>`;
	}

	const isCurrent = state.currentNodeId === node.id;
	const noteTitle = node.annotationNote ? ` title="${escapeHtml(node.annotationNote)}"` : "";
	const labelBadge = node.annotationLabel ? `<span class="tree-node-label">${escapeHtml(node.annotationLabel)}</span>` : "";
	const classes = ["tree-chip", cellRole];
	if (isCurrent) {
		classes.push("current");
	}
	if ((getNodePathSet(state.currentNodeId) || new Set()).has(node.id)) {
		classes.push("in-current-path");
	}

	const chip = `<button type="button" class="${classes.join(" ")}" data-node-id="${node.id}" data-tree-action="jump-node"${noteTitle}>${escapeHtml(node.moveUci)}${labelBadge}</button>`;
	const toggle = renderSidelineBody(node, nodePly, mainChildId, laneClass, depth);

	return `<div class="tree-ply-cell ${cellRole}">${chip}${toggle ? `<div class="tree-ply-toggle-stack">${toggle}</div>` : ""}</div>`;
}

function renderLineBlock(startNodeId, startPly, laneClass, depth = 0, pathNodeIds = null) {
	const resolvedPathNodeIds = (pathNodeIds || getPreferredPathNodeIds(startNodeId)).slice(1);
	if (!resolvedPathNodeIds.length) {
		return "";
	}

	let html = `<div class="tree-branch-block ${laneClass} depth-${depth}">`;
	let index = 0;
	let ply = startPly;

	while (index < resolvedPathNodeIds.length) {
		const currentNode = getTreeNode(resolvedPathNodeIds[index]);
		if (!currentNode) {
			break;
		}

		const nextNode = resolvedPathNodeIds[index + 1] ? getTreeNode(resolvedPathNodeIds[index + 1]) : null;
		const rowLabel = ply % 2 === 1 ? `${Math.ceil(ply / 2)}.` : `${Math.ceil(ply / 2)}...`;

		let whiteNode = null;
		let blackNode = null;
		let whitePly = ply;
		let blackPly = ply;
		let whiteMainChildId = null;
		let blackMainChildId = null;

		if (ply % 2 === 1) {
			whiteNode = currentNode;
			blackNode = nextNode;
			blackPly = ply + 1;
			whiteMainChildId = nextNode ? nextNode.id : (currentNode.preferredChildId || currentNode.children[0] || null);
			blackMainChildId = resolvedPathNodeIds[index + 2] ? resolvedPathNodeIds[index + 2] : null;
		} else {
			blackNode = currentNode;
			blackMainChildId = nextNode ? nextNode.id : (currentNode.preferredChildId || currentNode.children[0] || null);
		}

		html += `
			<div class="tree-fullmove-row tree-depth-${depth}">
				<div class="tree-move-number">${escapeHtml(rowLabel)}</div>
				${renderNodeCell(whiteNode, whitePly, whiteMainChildId, laneClass, depth, "white")}
				${renderNodeCell(blackNode, blackPly, blackMainChildId, laneClass, depth, "black")}
			</div>
		`;

		if (ply % 2 === 1 && nextNode) {
			index += 2;
			ply += 2;
		} else {
			index += 1;
			ply += 1;
		}
	}

	html += `</div>`;
	return html;
}

function renderTreeAnnotationPanel() {
	const node = getTreeNode(state.currentNodeId);
	if (!node) {
		if (refs.treeAnnotationSubtitle) {
			refs.treeAnnotationSubtitle.textContent = "Select a move to annotate it.";
		}
		if (refs.treeAnnotationLabelInput) {
			refs.treeAnnotationLabelInput.value = "";
		}
		if (refs.treeAnnotationNoteInput) {
			refs.treeAnnotationNoteInput.value = "";
		}
		return;
	}

	if (refs.treeAnnotationSubtitle) {
		const branchType = state.mainlineNodeIds.includes(node.id) ? "mainline" : "sideline";
		refs.treeAnnotationSubtitle.textContent = `${branchType === "sideline" ? "Sideline" : "Mainline"} move ${node.moveUci || ""}`.trim();
	}
	if (refs.treeAnnotationLabelInput) {
		refs.treeAnnotationLabelInput.value = node.annotationLabel || "";
	}
	if (refs.treeAnnotationNoteInput) {
		refs.treeAnnotationNoteInput.value = node.annotationNote || "";
	}
}

function render() {
	renderBoard();
	renderEvalBar();
	renderPlayers();
	updateMoveList();
	renderMoveTreePanel();
	renderTreeAnnotationPanel();
	renderTimelineScrubber();
	renderOverview();
	const moveIndex = state.currentPly - 1;
	if (moveIndex >= 0 && state.moveClassifications[moveIndex]) {
		updateClassificationView(state.moveClassifications[moveIndex]);
	} else {
		updateClassificationView(state.latestClassification);
	}
}

function legalMovesFromSquare(game, square) {
	return game
		.moves({ square, verbose: true })
		.map((move) => ({
			uci: verboseMoveToUci(move),
			to: move.to,
			promotion: move.promotion || null,
		}));
}

async function playMoveAtCurrentPly(uci) {
	state.mainlineScanToken += 1;
	state.scanInProgress = false;
	const currentNode = getTreeNode(state.currentNodeId);
	if (!currentNode) {
		return;
	}

	const beforeGame = new Chess(currentNode.fen);
	const moverColor = beforeGame.turn();
	const beforeFen = beforeGame.fen();
	const result = beforeGame.move(uciToMoveObject(uci));
	if (!result) {
		return;
	}

	const afterFen = beforeGame.fen();
	let nextNode = null;
	for (const childId of currentNode.children) {
		const child = getTreeNode(childId);
		if (child && child.moveUci === uci && child.fen === afterFen) {
			nextNode = child;
			break;
		}
	}

	if (!nextNode) {
		const nodeId = state.nextTreeNodeId;
		state.nextTreeNodeId += 1;
		nextNode = createTreeNode({
			id: nodeId,
			fen: afterFen,
			moveUci: uci,
			parentId: currentNode.id,
		});
		state.treeNodes.set(nodeId, nextNode);
		currentNode.children.push(nodeId);
	}

	currentNode.preferredChildId = nextNode.id;
	state.currentNodeId = nextNode.id;
	syncLineFromTree();
	clearSelection();
	render();

	queueMoveClassification({
		beforeFen,
		afterFen,
		playedMoveUci: uci,
		moverColor,
		gameBefore: new Chess(beforeFen),
		nodeId: nextNode.id,
	});

	schedulePositionAnalysis(80);
}

function onSquareClick(square) {
	const game = gameAtPly(state.currentPly);
	const turn = game.turn();
	const piece = game.get(square);

	if (state.selectedSquare) {
		const legalMoves = legalMovesFromSquare(game, state.selectedSquare);
		const targetCandidates = legalMoves.filter((move) => move.to === square);
		if (targetCandidates.length > 0) {
			const preferred = targetCandidates.find((move) => move.promotion === "q") || targetCandidates[0];
			playMoveAtCurrentPly(preferred.uci);
			return;
		}
	}


	if (piece && piece.color === turn) {
		state.selectedSquare = square;
		state.legalTargets = legalMovesFromSquare(game, square).map((move) => move.to);
	} else {
		clearSelection();
	}

	renderBoard();
}

async function queueMoveClassification({ beforeFen, afterFen, playedMoveUci, moverColor, gameBefore, nodeId }) {
	const token = ++state.latestMoveAnalysisToken;
	state.isClassifying = true;
	state.latestPositionAnalysisToken += 1;

	try {
		setStatus("Classifying played move...");
		debugLog("Move classification start", { token, playedMoveUci, beforeFen, afterFen });

		const { result: beforeAnalysis } = await analyzeWithFallback({
			engine,
			fen: beforeFen,
			depth: state.settings.depth,
			multiPV: state.settings.multiPV,
			phase: "classify-before",
			logger: debugLog,
		});
		const { result: afterAnalysis } = await analyzeWithFallback({
			engine,
			fen: afterFen,
			depth: state.settings.depth,
			multiPV: 1,
			phase: "classify-after",
			logger: debugLog,
		});

		if (token !== state.latestMoveAnalysisToken) {
			return;
		}

		state.positionCache.set(`${beforeFen}|d${state.settings.depth}|pv${state.settings.multiPV}`, beforeAnalysis);
		state.positionCache.set(`${afterFen}|d${state.settings.depth}|pv1`, afterAnalysis);

		state.latestClassification = classifyMove({
			beforeAnalysis,
			afterAnalysis,
			playedMoveUci,
			moverColor,
			playerElo: state.settings.playerElo,
			gameBefore,
			afterFen,
		});

		const moveNode = nodeId ? getTreeNode(nodeId) : null;
		if (moveNode) {
			moveNode.classification = state.latestClassification;
			syncLineFromTree();
		}

		updateClassificationView(state.latestClassification);
		setStatus(
			`Last move ${playedMoveUci}: ${state.latestClassification.label} (EP loss ${(state.latestClassification.epLoss * 100).toFixed(1)}%).`,
		);
	} catch (error) {
		if (String(error?.message || "") === "Canceled by newer request.") {
			return;
		}
		debugLog("Move classification failed", error);
		setStatus(`Classification error: ${error?.message || error}`);
	} finally {
		state.isClassifying = false;
		schedulePositionAnalysis(80);
	}
}

async function scanMainlineClassifications() {
	const myToken = ++state.mainlineScanToken;
	if (state.lineMoves.length === 0) {
		return;
	}

	state.scanInProgress = true;
	const originalPly = state.currentPly;
	const total = state.lineMoves.length;
	const { depth: scanDepth, multiPV: scanMultiPV } = getScanProfile();
	let done = 0;
	let previousAfterFen = null;
	let previousAfterAnalysis = null;
	setScanProgress(done, total, "running");
	clearSelection();

	debugLog("Mainline scan started", { plies: state.lineMoves.length, scanDepth, scanMultiPV });

	for (let ply = 1; ply <= state.lineMoves.length; ply += 1) {
		if (myToken !== state.mainlineScanToken) {
			debugLog("Mainline scan canceled", { ply });
			state.scanInProgress = false;
			setScanProgress(done, total, "canceled");
			return;
		}

		setCurrentPlyOnActiveLine(ply);
		renderBoard();
		updateMoveList();
		renderMoveTreePanel();
		setStatus(`Analyzing move ${ply}/${total}...`);
		await delay(SCAN_PLAYBACK_DELAY_MS);

		if (myToken !== state.mainlineScanToken) {
			debugLog("Mainline scan canceled during playback", { ply });
			state.scanInProgress = false;
			setScanProgress(done, total, "canceled");
			return;
		}

		const scanNodeId = state.activeLineNodeIds[ply];
		const scanNode = scanNodeId ? getTreeNode(scanNodeId) : null;
		if (scanNode?.classification) {
			done += 1;
			setScanProgress(done, total, "running");
			continue;
		}

		const beforeFen = state.timelineFens[ply - 1];
		const afterFen = state.timelineFens[ply];
		const playedMoveUci = state.lineMoves[ply - 1];
		const gameBefore = new Chess(beforeFen);
		const moverColor = gameBefore.turn();

		try {
			let beforeAnalysis = null;
			if (previousAfterAnalysis && previousAfterFen === beforeFen) {
				beforeAnalysis = previousAfterAnalysis;
			} else {
				const beforeCached = state.positionCache.get(`${beforeFen}|d${scanDepth}|pv${scanMultiPV}`);
				if (beforeCached) {
					beforeAnalysis = beforeCached;
				} else {
					const beforeResult = await analyzeWithFallback({
						engine,
						fen: beforeFen,
						depth: scanDepth,
						multiPV: scanMultiPV,
						phase: `scan-before-${ply}`,
						logger: debugLog,
					});
					beforeAnalysis = beforeResult.result;
					state.positionCache.set(`${beforeFen}|d${scanDepth}|pv${scanMultiPV}`, beforeAnalysis);
				}
			}

			const { result: afterAnalysis } = await analyzeWithFallback({
				engine,
				fen: afterFen,
				depth: scanDepth,
				multiPV: scanMultiPV,
				phase: `scan-after-${ply}`,
				logger: debugLog,
			});

			state.positionCache.set(`${afterFen}|d${scanDepth}|pv${scanMultiPV}`, afterAnalysis);
			previousAfterFen = afterFen;
			previousAfterAnalysis = afterAnalysis;

			const classification = classifyMove({
				beforeAnalysis,
				afterAnalysis,
				playedMoveUci,
				moverColor,
				playerElo: state.settings.playerElo,
				gameBefore,
				afterFen,
			});
			if (scanNode) {
				scanNode.classification = classification;
				syncLineFromTree();
			}

			if (state.currentPly === ply) {
				updateClassificationView(classification);
			}

			done += 1;
			setScanProgress(done, total, "running");
		} catch (error) {
			debugLog("Mainline scan failed", { ply, error: String(error?.message || error) });
			setStatus(`Mainline scan stopped at ply ${ply}: ${error?.message || error}`);
			state.scanInProgress = false;
			setScanProgress(done, total, "failed");
			setCurrentPlyOnActiveLine(originalPly);
			render();
			schedulePositionAnalysis(80);
			return;
		}
	}

	if (myToken === state.mainlineScanToken) {
		debugLog("Mainline scan complete", { plies: state.lineMoves.length });
		state.scanInProgress = false;
		setScanProgress(total, total, "done");
		setCurrentPlyOnActiveLine(originalPly);
		render();
		schedulePositionAnalysis(80);
	}
}

function resetLine() {
	resetMoveTree(state.startFen);
	clearCaches();
	clearSelection();
	render();
	schedulePositionAnalysis(80);
}

function bindEvents() {
	refs.loadPgnBtn.addEventListener("click", loadPgnFromInput);
	refs.loadFenBtn.addEventListener("click", loadFenFromInput);
	refs.applySettingsBtn.addEventListener("click", applyEngineSettings);
	refs.applyThemeBtn.addEventListener("click", applyThemeFromControls);
	if (refs.timelineScrubber) {
		refs.timelineScrubber.addEventListener("input", () => {
			seekToPly(refs.timelineScrubber.value);
		});
	}
	if (refs.treeAnnotationSaveBtn) {
		refs.treeAnnotationSaveBtn.addEventListener("click", saveTreeAnnotation);
	}
	if (refs.treeAnnotationClearBtn) {
		refs.treeAnnotationClearBtn.addEventListener("click", clearTreeAnnotation);
	}
	refs.toggleSideBtn.addEventListener("click", () => {
		toggleSidebarCollapsed(!state.settings.sidebarCollapsed);
	});
	refs.reviewModeToggle.addEventListener("change", () => {
		state.settings.reviewMode = refs.reviewModeToggle.checked;
		saveSettings();
		setStatus(state.settings.reviewMode ? "Review mode: skipping Good/Excellent moves." : "Review mode off.");
	});
	refs.analyzeBtn.addEventListener("click", () => {
		schedulePositionAnalysis(0);
	});
	refs.prevBtn.addEventListener("click", () => {
		goPrev();
	});
	refs.nextBtn.addEventListener("click", () => {
		goNext();
	});
	refs.flipBtn.addEventListener("click", () => {
		state.orientation = state.orientation === "white" ? "black" : "white";
		renderBoard();
		renderPlayers();
	});
	refs.resetBtn.addEventListener("click", resetLine);
	document.addEventListener("keydown", onGlobalKeyDown);
}

async function main() {
	resetMoveTree(state.startFen);
	bindEvents();
	await loadSettings();

	setStatus("Booting Stockfish...");
	await engine.init();
	await applyEngineSettings();

	render();
	schedulePositionAnalysis(80);
	consumePendingPgnImport();
}

main();
