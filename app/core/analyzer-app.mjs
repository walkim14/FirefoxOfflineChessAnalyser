import { Chess } from "../../vendor/chess.js";
import { StockfishClient } from "../stockfish-client.js";
import { classifyMove, expectedWhitePercent } from "../move-classifier.mjs";
import { parsePgnToLine } from "../pgn-loader.mjs";
import { analyzeWithFallback } from "../analysis-fallback.mjs";
import {
	createTreeNode as createTreeNodeState,
	getTreeNode as getTreeNodeState,
	initializeMoveTreeFromLine as initializeMoveTreeFromLineState,
	resetMoveTree as resetMoveTreeState,
	setCurrentNode as setCurrentNodeState,
	setCurrentPlyOnActiveLine as setCurrentPlyOnActiveLineState,
	syncLineFromTree as syncLineFromTreeState,
	uciToMoveObject as uciToMoveObjectState,
	verboseMoveToUci as verboseMoveToUciState,
} from "../state/tree-state.mjs";
import {
	boardCoordinates as boardCoordinatesState,
	squareCenterOnOverlay as squareCenterOnOverlayState,
	squareDisplayIndex as squareDisplayIndexState,
} from "../ui/board-utils.mjs";
import {
	classificationHighlightColor as classificationHighlightColorView,
	isReviewSkipLabel as isReviewSkipLabelView,
	renderOverview as renderOverviewView,
	shortLabelForTag as shortLabelForTagView,
	updateClassificationView as updateClassificationViewView,
	updateEngineLinesView as updateEngineLinesViewView,
} from "../ui/classification-view.mjs";
import {
	CLASS_ICONS,
	DEFAULT_SETTINGS,
	INITIAL_FEN,
	REVIEW_PLAYBACK_DELAY_MS,
	SCAN_PLAYBACK_DELAY_MS,
} from "./constants.mjs";
import { getDomRefs } from "../ui/dom-refs.mjs";
import { storageGet, storageSet } from "./browser-storage.mjs";
import { getReferenceMainlineNodeIds, renderLineBlock } from "../ui/tree-renderer.mjs";
import { initCollapsiblePanels } from "../ui/collapsible-panels.mjs";
import { createAnalysisController } from "./controllers/analysis-controller.mjs";
import { createGameplayController } from "./controllers/gameplay-controller.mjs";

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
	annotationDialogNodeId: null,
};

const refs = getDomRefs();

const engine = new StockfishClient({ debugLabel: "ui", debug: true });

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createTreeNode(params) {
	return createTreeNodeState(params);
}

function getTreeNode(nodeId) {
	return getTreeNodeState(state, nodeId);
}

function resetMoveTree(startFen) {
	resetMoveTreeState(state, startFen);
}

function initializeMoveTreeFromLine(startFen, lineMoves, clockTimeline = null) {
	initializeMoveTreeFromLineState(state, startFen, lineMoves, clockTimeline, Chess);
}

function syncLineFromTree() {
	syncLineFromTreeState(state);
}

function setCurrentNode(nodeId) {
	setCurrentNodeState(state, nodeId);
}

function setCurrentPlyOnActiveLine(ply) {
	setCurrentPlyOnActiveLineState(state, ply, clamp);
}

function renderMoveTreePanel() {
	if (!refs.treePath || !refs.treeChildren) {
		return;
	}

	const referenceLineNodeIds = state.mainlineNodeIds.length > 0
		? state.mainlineNodeIds
		: getReferenceMainlineNodeIds(state.treeRootId, getTreeNode);
	if (referenceLineNodeIds.length <= 1) {
		refs.treePath.innerHTML = "<div class='line-item'>No moves in tree yet.</div>";
		refs.treeChildren.innerHTML = "";
		return;
	}

	const treeHtml = renderLineBlock({
		startNodeId: referenceLineNodeIds[0],
		startPly: 1,
		laneClass: "mainline",
		depth: 0,
		pathNodeIds: referenceLineNodeIds,
		getTreeNode,
		treeExpandedParents: state.treeExpandedParents,
		currentNodeId: state.currentNodeId,
		rootNodeId: state.treeRootId,
	});
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

	refs.treePath.querySelectorAll("button[data-tree-action='edit-annotation']").forEach((button) => {
		button.addEventListener("click", () => {
			const nodeId = Number(button.getAttribute("data-node-id"));
			if (!nodeId) {
				return;
			}

			openTreeAnnotationDialog(nodeId);
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
function uciToMoveObject(uci) {
	return uciToMoveObjectState(uci);
}

function verboseMoveToUci(move) {
	return verboseMoveToUciState(move);
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
	return squareCenterOnOverlayState(square, state.orientation);
}

function squareDisplayIndex(square) {
	return squareDisplayIndexState(square, state.orientation);
}

function formatPlayerLine(name, elo, clock) {
	const safeName = name || "Player";
	const clockPart = clock ? ` | ${clock}` : "";
	if (!elo) {
		return `${safeName}${clockPart}`;
	}
	return `${safeName} (${elo})${clockPart}`;
}

function renderPlayers() {
	if (!refs.playerTop || !refs.playerBottom) {
		return;
	}

	const currentNode = getTreeNode(state.currentNodeId);
	const whiteClock = currentNode?.clockWhite || null;
	const blackClock = currentNode?.clockBlack || null;
	const whiteText = formatPlayerLine(state.players.whiteName, state.players.whiteElo, whiteClock);
	const blackText = formatPlayerLine(state.players.blackName, state.players.blackElo, blackClock);

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
	return shortLabelForTagView(label, CLASS_ICONS);
}

function classificationHighlightColor(label) {
	return classificationHighlightColorView(label);
}

function isReviewSkipLabel(label) {
	return isReviewSkipLabelView(label);
}

function isBottomBoardMove(ply) {
	return gameplayController.isBottomBoardMove(ply);
}

function reviewStopPly(direction) {
	return gameplayController.reviewStopPly(direction);
}

async function animateToPly(targetPly) {
	return gameplayController.animateToPly(targetPly);
}

async function goPrev() {
	return gameplayController.goPrev();
}

async function goNext() {
	return gameplayController.goNext();
}

function onGlobalKeyDown(event) {
	return gameplayController.onGlobalKeyDown(event);
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

	let parsed = null;

	try {
		parsed = parsePgnToLine(pgn, Chess);
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
			clockPlies: parsed.clockTimeline?.length || 0,
			whiteElo: parsed.whiteElo,
			blackElo: parsed.blackElo,
			suggestedElo: parsed.suggestedElo,
		});
	} catch (error) {
		setStatus(error?.message || "PGN parse failed.");
		return;
	}

	initializeMoveTreeFromLine(state.startFen, state.lineMoves, parsed?.clockTimeline || null);
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

function boardCoordinates() {
	return boardCoordinatesState(state.orientation);
}

function pieceAtSquare(game, square) {
	return game.get(square);
}

function clearSelection() {
	state.selectedSquare = null;
	state.legalTargets = [];
}

const analysisController = createAnalysisController({
	state,
	refs,
	engine,
	Chess,
	classifyMove,
	analyzeWithFallback,
	SCAN_PLAYBACK_DELAY_MS,
	clamp,
	delay,
	gameAtPly,
	cacheKeyFor,
	getCachedAnalysis,
	getTreeNode,
	setCurrentPlyOnActiveLine,
	syncLineFromTree,
	setStatus,
	debugLog,
	clearSelection,
	renderBoard,
	renderEvalBar,
	updateMoveList,
	renderMoveTreePanel,
	render,
	updateClassificationView,
	updateEngineLinesView,
});

const gameplayController = createGameplayController({
	state,
	Chess,
	REVIEW_PLAYBACK_DELAY_MS,
	clamp,
	delay,
	getTreeNode,
	setCurrentNode,
	setCurrentPlyOnActiveLine,
	syncLineFromTree,
	createTreeNode,
	uciToMoveObject,
	verboseMoveToUci,
	isReviewSkipLabel,
	queueMoveClassification,
	schedulePositionAnalysis,
	clearSelection,
	render,
	renderBoard,
	renderPlayers,
	closeTreeAnnotationDialog,
});

function clearCaches() {
	return analysisController.clearCaches();
}

function setScanProgress(done, total, phase) {
	return analysisController.setScanProgress(done, total, phase);
}

function schedulePositionAnalysis(delayMs = 80) {
	return analysisController.schedulePositionAnalysis(delayMs);
}

async function analyzeCurrentPosition() {
	return analysisController.analyzeCurrentPosition();
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
	return gameplayController.seekToPly(ply);
}

function setTreeAnnotation(nodeId, label, note) {
	const node = getTreeNode(nodeId);
	if (!node) {
		return;
	}

	node.annotationLabel = label;
	node.annotationNote = note;
	render();
}

function closeTreeAnnotationDialog() {
	state.annotationDialogNodeId = null;
	if (!refs.annotationModal) {
		return;
	}

	refs.annotationModal.classList.add("hidden");
	refs.annotationModal.setAttribute("aria-hidden", "true");
}

function openTreeAnnotationDialog(nodeId) {
	const node = getTreeNode(nodeId);
	if (!node || !refs.annotationModal) {
		return;
	}

	state.annotationDialogNodeId = nodeId;
	if (refs.annotationDialogTitle) {
		refs.annotationDialogTitle.textContent = node.moveUci ? `Sideline ${node.moveUci}` : "Sideline";
	}
	if (refs.annotationLabelInput) {
		refs.annotationLabelInput.value = node.annotationLabel || "";
	}
	if (refs.annotationNoteInput) {
		refs.annotationNoteInput.value = node.annotationNote || "";
	}

	refs.annotationModal.classList.remove("hidden");
	refs.annotationModal.setAttribute("aria-hidden", "false");
	if (refs.annotationLabelInput) {
		refs.annotationLabelInput.focus();
	}
}

function saveTreeAnnotationDialog() {
	const nodeId = state.annotationDialogNodeId;
	if (!nodeId) {
		return;
	}

	const label = refs.annotationLabelInput ? refs.annotationLabelInput.value.trim() : "";
	const note = refs.annotationNoteInput ? refs.annotationNoteInput.value.trim() : "";
	closeTreeAnnotationDialog();
	setTreeAnnotation(nodeId, label, note);
}

function clearTreeAnnotationDialog() {
	const nodeId = state.annotationDialogNodeId;
	if (!nodeId) {
		return;
	}

	if (refs.annotationLabelInput) {
		refs.annotationLabelInput.value = "";
	}
	if (refs.annotationNoteInput) {
		refs.annotationNoteInput.value = "";
	}
	closeTreeAnnotationDialog();
	setTreeAnnotation(nodeId, "", "");
}

function getScanProfile() {
	return analysisController.getScanProfile();
}

function buildTimelineFromLine() {
	syncLineFromTree();
}

function updateClassificationView(result) {
	return updateClassificationViewView(refs, result, CLASS_ICONS);
}

function updateEngineLinesView(analysis) {
	return updateEngineLinesViewView(refs, analysis, expectedWhitePercent);
}

function renderOverview() {
	return renderOverviewView({ refs, state, Chess, getTreeNode: getTreeNodeState, classIcons: CLASS_ICONS, clamp });
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

function render() {
	renderBoard();
	renderEvalBar();
	renderPlayers();
	updateMoveList();
	renderMoveTreePanel();
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
	return gameplayController.legalMovesFromSquare(game, square);
}

async function playMoveAtCurrentPly(uci) {
	return gameplayController.playMoveAtCurrentPly(uci);
}

function onSquareClick(square) {
	return gameplayController.onSquareClick(square);
}

async function queueMoveClassification({ beforeFen, afterFen, playedMoveUci, moverColor, gameBefore, nodeId }) {
	return analysisController.queueMoveClassification({ beforeFen, afterFen, playedMoveUci, moverColor, gameBefore, nodeId });
}

async function scanMainlineClassifications() {
	return analysisController.scanMainlineClassifications();
}

function resetLine() {
	resetMoveTree(state.startFen);
	clearCaches();
	clearSelection();
	render();
	schedulePositionAnalysis(80);
}

function bindEvents() {
	initCollapsiblePanels();
	refs.loadPgnBtn.addEventListener("click", loadPgnFromInput);
	refs.loadFenBtn.addEventListener("click", loadFenFromInput);
	refs.applySettingsBtn.addEventListener("click", applyEngineSettings);
	refs.applyThemeBtn.addEventListener("click", applyThemeFromControls);
	if (refs.timelineScrubber) {
		refs.timelineScrubber.addEventListener("input", () => {
			seekToPly(refs.timelineScrubber.value);
		});
	}
	if (refs.annotationSaveBtn) {
		refs.annotationSaveBtn.addEventListener("click", saveTreeAnnotationDialog);
	}
	if (refs.annotationClearBtn) {
		refs.annotationClearBtn.addEventListener("click", clearTreeAnnotationDialog);
	}
	if (refs.annotationCancelBtn) {
		refs.annotationCancelBtn.addEventListener("click", closeTreeAnnotationDialog);
	}
	if (refs.annotationModal) {
		refs.annotationModal.addEventListener("click", (event) => {
			if (event.target === refs.annotationModal) {
				closeTreeAnnotationDialog();
			}
		});
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
		gameplayController.onFlipBoard();
	});
	refs.resetBtn.addEventListener("click", resetLine);
	document.addEventListener("keydown", onGlobalKeyDown);
}

export async function bootstrapAnalyzerApp() {
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
