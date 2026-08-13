import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { createSession } from "./helpers/analyzer-session.mjs";
import { parsePgnToLine } from "../app/pgn-loader.mjs";
import { CLASS_ICONS } from "../app/core/constants.mjs";
import {
	getNodePathSet,
	getPreferredPathNodeIds,
	getReferenceMainlineNodeIds,
	renderMoveTree,
} from "../app/ui/tree-renderer.mjs";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");

// The renderer builds elements, so it needs a document to build them in.
globalThis.document = new JSDOM("").window.document;

function pgn(moves) {
	return `[Event "Test"]\n[White "A"]\n[Black "B"]\n\n${moves} *`;
}

function load(session, moves) {
	const parsed = parsePgnToLine(pgn(moves), Chess);
	session.loadLine(parsed.startFen, parsed.lineMoves, parsed.clockTimeline);
	return parsed;
}

function renderTree(session) {
	const { state } = session;
	const spine = state.mainlineNodeIds.length > 1
		? state.mainlineNodeIds
		: getReferenceMainlineNodeIds(state.treeRootId, session.getTreeNode);

	return renderMoveTree({
		pathNodeIds: spine.slice(1),
		startPly: 1,
		getTreeNode: session.getTreeNode,
		currentNodeId: state.currentNodeId,
		expandedParents: state.treeExpandedParents,
		classIcons: CLASS_ICONS,
	});
}

/** Node ids that have a clickable chip in the rendered tree. */
function renderedNodeIds(tree) {
	return new Set(
		[...tree.querySelectorAll("[data-tree-action='jump-node']")].map((chip) => Number(chip.dataset.nodeId)),
	);
}

function renderedLabels(session, tree) {
	return [...renderedNodeIds(tree)].map((nodeId) => session.getTreeNode(nodeId).moveSan);
}

function toggles(tree) {
	return [...tree.querySelectorAll("[data-tree-action='toggle-variations']")].map((toggle) => ({
		parentId: Number(toggle.dataset.parentNodeId),
		expanded: toggle.getAttribute("aria-expanded") === "true",
	}));
}

/** The chips, with the classes that drive highlighting. */
function chips(tree) {
	return [...tree.querySelectorAll(".tree-chip")].map((chip) => ({
		classes: [...chip.classList],
		nodeId: Number(chip.dataset.nodeId),
	}));
}

function textOf(tree, selector) {
	return [...tree.querySelectorAll(selector)].map((node) => node.textContent.trim());
}

test("tree nodes carry SAN so the panel reads like notation", async () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");

	const spine = session.state.mainlineNodeIds.slice(1).map((id) => session.getTreeNode(id));
	assert.deepEqual(spine.map((node) => node.moveSan), ["e4", "e5", "Nf3", "Nc6"]);
	assert.deepEqual(spine.map((node) => node.moveUci), ["e2e4", "e7e5", "g1f3", "b8c6"]);

	await session.gameplayController.playMoveAtCurrentPly("e2e4");
	await session.settle();
	assert.ok(textOf(renderTree(session), ".tree-chip-move").includes("e4"));
});

test("a move played from the final position of the line stays visible", async () => {
	// A mainline ending on a white move used to swallow the next move entirely.
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3");
	const { state, gameplayController } = session;

	gameplayController.seekToPly(3);
	await gameplayController.playMoveAtCurrentPly("b8c6");
	await session.settle();

	const tree = renderTree(session);
	assert.ok(renderedNodeIds(tree).has(state.currentNodeId), "the played move must appear in the tree");
	assert.ok(renderedLabels(session, tree).includes("Nc6"));
});

test("the same holds when the line ends on a black move", async () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");
	const { state, gameplayController } = session;

	gameplayController.seekToPly(4);
	await gameplayController.playMoveAtCurrentPly("f1b5");
	await session.settle();

	const tree = renderTree(session);
	assert.ok(renderedNodeIds(tree).has(state.currentNodeId));
	assert.ok(renderedLabels(session, tree).includes("Bb5"));
});

test("several sidelines from one position all render, with a count on the toggle", async () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");
	const { state, gameplayController } = session;

	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("f1c4");
	await session.settle();
	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("d2d4");
	await session.settle();
	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("b1c3");
	await session.settle();

	const branchPoint = session.getTreeNode(state.mainlineNodeIds[2]);
	assert.equal(branchPoint.children.length, 4, "mainline continuation plus three alternatives");

	const tree = renderTree(session);
	const labels = renderedLabels(session, tree);
	for (const move of ["Bc4", "d4", "Nc3", "Nf3"]) {
		assert.ok(labels.includes(move), `${move} must be rendered; got ${labels.join(" ")}`);
	}
	assert.deepEqual(textOf(tree, ".tree-var-count"), ["3 lines"], "the toggle must say how many lines it holds");
});

test("the branch holding the current move is expanded even when the user never opened it", async () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");
	const { state, gameplayController } = session;

	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("f1c4");
	await session.settle();

	assert.equal(state.treeExpandedParents.size, 0, "nothing was expanded by hand");
	const tree = renderTree(session);
	assert.ok(renderedNodeIds(tree).has(state.currentNodeId), "the move just played must not hide behind a toggle");
	assert.deepEqual(toggles(tree).map((entry) => entry.expanded), [true]);
});

test("navigating back to the mainline collapses the sidelines again", async () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");
	const { state, gameplayController } = session;

	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("f1c4");
	await session.settle();
	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("d2d4");
	await session.settle();

	// Walk back onto the loaded game.
	state.currentNodeId = state.mainlineNodeIds[4];
	const tree = renderTree(session);

	assert.deepEqual(toggles(tree).map((entry) => entry.expanded), [false], "off-path variations fold away");
	const labels = renderedLabels(session, tree);
	assert.deepEqual(labels, ["e4", "e5", "Nf3", "Nc6"]);
	assert.deepEqual(textOf(tree, ".tree-var-count"), ["2 lines"], "the count still advertises what is hidden");
});

test("a manually expanded parent stays open while off the current path", async () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");
	const { state, gameplayController } = session;

	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("f1c4");
	await session.settle();

	const branchPointId = state.mainlineNodeIds[2];
	state.currentNodeId = state.mainlineNodeIds[4];
	state.treeExpandedParents.add(branchPointId);

	const tree = renderTree(session);
	assert.deepEqual(toggles(tree).map((entry) => entry.expanded), [true]);
	assert.ok(renderedLabels(session, tree).includes("Bc4"));
});

test("variations nest to arbitrary depth and remain reachable", async () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");
	const { state, gameplayController } = session;

	gameplayController.seekToPly(2);
	await gameplayController.playMoveAtCurrentPly("f1c4"); // depth 1
	await session.settle();
	await gameplayController.playMoveAtCurrentPly("g8f6");
	await session.settle();
	gameplayController.seekToPly(3);
	await gameplayController.playMoveAtCurrentPly("b8c6"); // depth 2 sibling of Nf6
	await session.settle();

	const tree = renderTree(session);
	assert.ok(renderedNodeIds(tree).has(state.currentNodeId), "a depth-2 variation must still show the current move");

	// Every ancestor of the current node is present so the path can be followed.
	const ancestors = getNodePathSet(state.currentNodeId, session.getTreeNode);
	const rendered = renderedNodeIds(tree);
	for (const nodeId of ancestors) {
		if (nodeId === state.treeRootId) {
			continue;
		}
		assert.ok(rendered.has(nodeId), `ancestor ${nodeId} missing from the tree`);
	}
});

test("the current move and its path are marked for highlighting", async () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");
	const { state, gameplayController } = session;

	gameplayController.seekToPly(3);
	const tree = renderTree(session);

	const rendered = chips(tree);

	const current = rendered.filter((chip) => chip.classes.includes("current"));
	assert.equal(current.length, 1, "exactly one chip is the current move");
	assert.equal(current[0].nodeId, state.currentNodeId);

	// e4, e5 and Nf3 lead to the current node; Nc6 does not.
	const onPath = rendered.filter((chip) => chip.classes.includes("in-current-path")).map((chip) => chip.nodeId);
	assert.deepEqual(onPath.sort((a, b) => a - b), state.activeLineNodeIds.slice(1, 4));
});

test("classification icons reach the tree once moves are scored", async () => {
	const session = createSession({ depth: 12, multiPV: 2 });
	load(session, "1. e4 e5 2. Nf3 Nc6");

	await session.analysisController.scanMainlineClassifications();
	await session.settle();

	const tree = renderTree(session);
	assert.ok(tree.querySelector(".tree-chip-class"), "scored moves must carry their classification badge");
});

test("the preferred continuation drives what a variation shows", () => {
	const session = createSession();
	load(session, "1. e4 e5 2. Nf3 Nc6");
	const { state } = session;

	const path = getPreferredPathNodeIds(state.treeRootId, session.getTreeNode);
	assert.deepEqual(path, state.mainlineNodeIds);
});

test("a cycle in the tree cannot hang the renderer", () => {
	const session = createSession();
	load(session, "1. e4 e5");
	const { state } = session;

	// Defensive: corrupt state must not spin forever.
	const first = session.getTreeNode(state.mainlineNodeIds[1]);
	const second = session.getTreeNode(state.mainlineNodeIds[2]);
	second.preferredChildId = first.id;
	second.children.push(first.id);

	const path = getPreferredPathNodeIds(state.treeRootId, session.getTreeNode);
	assert.ok(path.length <= state.treeNodes.size + 1);
	assert.ok(getNodePathSet(second.id, session.getTreeNode).size <= state.treeNodes.size);
});
