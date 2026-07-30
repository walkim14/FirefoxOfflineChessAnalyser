export function createTreeNode({
	id,
	fen,
	moveUci = null,
	moveSan = null,
	parentId = null,
	clockWhite = null,
	clockBlack = null,
}) {
	return {
		id,
		fen,
		moveUci,
		// Standard algebraic notation for display ("Nf3"); falls back to UCI.
		moveSan: moveSan || moveUci,
		parentId,
		children: [],
		preferredChildId: null,
		classification: null,
		annotationLabel: "",
		annotationNote: "",
		clockWhite,
		clockBlack,
	};
}

export function getTreeNode(state, nodeId) {
	return state.treeNodes.get(nodeId) || null;
}

export function uciToMoveObject(uci) {
	if (!uci || uci.length < 4) {
		return null;
	}

	return {
		from: uci.slice(0, 2),
		to: uci.slice(2, 4),
		promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
	};
}

export function syncLineFromTree(state) {
	const activeLine = getActiveLineFromTree(state);
	state.activeLineNodeIds = activeLine.nodeIds;
	state.lineMoves = activeLine.moves;
	state.timelineFens = activeLine.timeline;
	state.clockTimeline = state.activeLineNodeIds.map((nodeId) => {
		const node = getTreeNode(state, nodeId);
		return {
			white: node?.clockWhite || null,
			black: node?.clockBlack || null,
		};
	});
	state.moveClassifications = state.activeLineNodeIds
		.slice(1)
		.map((nodeId) => getTreeNode(state, nodeId)?.classification || null);

	const currentIndex = state.activeLineNodeIds.indexOf(state.currentNodeId);
	state.currentPly = currentIndex >= 0 ? currentIndex : 0;
}

export function resetMoveTree(state, startFen) {
	const root = createTreeNode({ id: 1, fen: startFen });
	state.treeNodes = new Map([[1, root]]);
	state.treeRootId = 1;
	state.currentNodeId = 1;
	state.nextTreeNodeId = 2;
	state.mainlineNodeIds = [1];
	state.activeLineNodeIds = [1];
	state.lineMoves = [];
	state.timelineFens = [startFen];
	state.clockTimeline = [{ white: null, black: null }];
	state.moveClassifications = [];
	state.currentPly = 0;
	state.treeExpandedParents = new Set();
}

export function initializeMoveTreeFromLine(state, startFen, lineMoves, clockTimeline, Chess) {
	resetMoveTree(state, startFen);
	const root = getTreeNode(state, state.treeRootId);
	if (root && clockTimeline?.[0]) {
		root.clockWhite = clockTimeline[0].white || null;
		root.clockBlack = clockTimeline[0].black || null;
	}
	let cursor = getTreeNode(state, state.treeRootId);
	const game = new Chess(startFen);

	for (let index = 0; index < lineMoves.length; index += 1) {
		const uci = lineMoves[index];
		let applied = null;
		try {
			// chess.js throws on a move it cannot play; stop replaying there
			// rather than tearing down the whole import.
			applied = game.move(uciToMoveObject(uci));
		} catch {
			break;
		}
		if (!applied) {
			break;
		}

		const nodeId = state.nextTreeNodeId;
		state.nextTreeNodeId += 1;
		const child = createTreeNode({
			id: nodeId,
			fen: game.fen(),
			moveUci: uci,
			moveSan: applied.san || uci,
			parentId: cursor.id,
			clockWhite: clockTimeline?.[index + 1]?.white || null,
			clockBlack: clockTimeline?.[index + 1]?.black || null,
		});
		state.treeNodes.set(nodeId, child);
		cursor.children.push(nodeId);
		cursor.preferredChildId = nodeId;
		cursor = child;
	}

	syncLineFromTree(state);
	state.mainlineNodeIds = state.activeLineNodeIds.slice();
}

export function promotePathToNode(state, nodeId) {
	const node = getTreeNode(state, nodeId);
	if (!node) {
		return;
	}

	const path = [];
	let cursor = node;
	while (cursor && cursor.parentId) {
		path.push({ parentId: cursor.parentId, childId: cursor.id });
		cursor = getTreeNode(state, cursor.parentId);
	}

	path.reverse();
	for (const step of path) {
		const parent = getTreeNode(state, step.parentId);
		if (parent) {
			parent.preferredChildId = step.childId;
		}
	}
}

export function setCurrentNode(state, nodeId) {
	if (!getTreeNode(state, nodeId)) {
		return;
	}

	promotePathToNode(state, nodeId);
	state.currentNodeId = nodeId;
	syncLineFromTree(state);
}

export function setCurrentPlyOnActiveLine(state, ply, clamp) {
	const safePly = clamp(ply, 0, state.activeLineNodeIds.length - 1);
	const nodeId = state.activeLineNodeIds[safePly];
	if (nodeId) {
		state.currentNodeId = nodeId;
	}
	syncLineFromTree(state);
}

export function getActiveLineFromTree(state) {
	const nodeIds = [state.treeRootId];
	const moves = [];
	const timeline = [getTreeNode(state, state.treeRootId)?.fen || state.startFen];
	let cursor = getTreeNode(state, state.treeRootId);

	while (cursor) {
		const nextId = cursor.preferredChildId || cursor.children[0];
		if (!nextId) {
			break;
		}

		const child = getTreeNode(state, nextId);
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

export function verboseMoveToUci(move) {
	return `${move.from}${move.to}${move.promotion || ""}`;
}
