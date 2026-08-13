import { el, frag } from "./dom.mjs";

function moveNumberLabel(ply) {
	return ply % 2 === 1 ? `${Math.ceil(ply / 2)}.` : `${Math.ceil(ply / 2)}...`;
}

function nodeLabel(node) {
	return node.moveSan || node.moveUci || "";
}

/**
 * The line that continues from `nodeId` by always taking the preferred child.
 * Used to give every variation a readable continuation instead of a single
 * orphaned move.
 */
export function getPreferredPathNodeIds(startNodeId, getTreeNode) {
	const nodeIds = [];
	const seen = new Set();
	let cursor = getTreeNode(startNodeId);

	while (cursor && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		nodeIds.push(cursor.id);
		const nextId = cursor.preferredChildId && getTreeNode(cursor.preferredChildId)
			? cursor.preferredChildId
			: cursor.children[0];
		if (!nextId) {
			break;
		}
		cursor = getTreeNode(nextId);
	}

	return nodeIds;
}

export function getNodePathSet(nodeId, getTreeNode) {
	const ids = new Set();
	let cursor = getTreeNode(nodeId);

	while (cursor && !ids.has(cursor.id)) {
		ids.add(cursor.id);
		cursor = cursor.parentId ? getTreeNode(cursor.parentId) : null;
	}

	return ids;
}

/**
 * Reference spine used when no PGN mainline is loaded. Follows the first child
 * so the displayed spine does not jump around as variations are added.
 */
export function getReferenceMainlineNodeIds(treeRootId, getTreeNode) {
	const nodeIds = [treeRootId];
	const seen = new Set([treeRootId]);
	let cursor = getTreeNode(treeRootId);

	while (cursor && cursor.children.length) {
		const child = getTreeNode(cursor.children[0]);
		if (!child || seen.has(child.id)) {
			break;
		}

		nodeIds.push(child.id);
		seen.add(child.id);
		cursor = child;
	}

	return nodeIds;
}

function renderChip({ node, cellRole, laneClass, currentNodeId, currentPathSet, classIcons }) {
	if (!node) {
		return el("div", { class: `tree-ply-cell ${cellRole} empty` });
	}

	const classes = ["tree-chip", cellRole, laneClass === "mainline" ? "mainline" : "variation"];
	if (currentNodeId === node.id) {
		classes.push("current");
	}
	if (currentPathSet.has(node.id)) {
		classes.push("in-current-path");
	}

	const classification = node.classification?.label || "";
	const slug = classification.toLowerCase().replace(/\s+/g, "-");
	const icon = slug && classIcons ? classIcons[slug] : null;

	const titleParts = [nodeLabel(node)];
	if (classification) {
		titleParts.push(classification);
	}
	if (node.annotationNote) {
		titleParts.push(node.annotationNote);
	}

	const chip = el("button", {
		type: "button",
		class: classes.join(" "),
		dataset: { nodeId: String(node.id), treeAction: "jump-node" },
		title: titleParts.join(" — "),
	}, [
		icon ? el("span", { class: `tree-chip-class ${slug}`, "aria-hidden": "true", text: icon }) : null,
		el("span", { class: "tree-chip-move", text: nodeLabel(node) }),
		node.annotationLabel ? el("span", { class: "tree-node-label", text: node.annotationLabel }) : null,
	]);

	return el("div", { class: `tree-ply-cell ${cellRole}` }, chip);
}

/**
 * Alternatives to the move that actually continues the line being rendered.
 * `nextInPathId` is null at the end of a line, in which case every child is an
 * alternative — that is how a move played from the final position stays visible.
 */
function variationChildren(node, nextInPathId, getTreeNode) {
	if (!node) {
		return [];
	}

	return node.children
		.filter((childId) => childId !== nextInPathId)
		.map((childId) => getTreeNode(childId))
		.filter(Boolean);
}

function renderVariationBlock({
	parentNode,
	variations,
	parentPly,
	cellRole,
	depth,
	context,
}) {
	if (!variations.length) {
		return null;
	}

	const { expandedParents, currentPathSet, getTreeNode } = context;
	// A variation holding the current move is always shown: otherwise the move
	// the user just played would be hidden behind a collapsed toggle.
	const holdsCurrent = variations.some((child) => currentPathSet.has(child.id));
	const expanded = expandedParents.has(parentNode.id) || holdsCurrent;
	const count = variations.length;
	const countLabel = count === 1 ? "1 line" : `${count} lines`;

	const toggle = el("button", {
		type: "button",
		class: `tree-var-toggle ${expanded ? "expanded" : ""}`,
		dataset: { parentNodeId: String(parentNode.id), treeAction: "toggle-variations" },
		"aria-expanded": String(expanded),
		"aria-label": `${expanded ? "Collapse" : "Expand"} ${countLabel} after ${nodeLabel(parentNode)}`,
	}, [
		el("span", { class: "tree-var-arrow", "aria-hidden": "true", text: expanded ? "▾" : "▸" }),
		el("span", { class: "tree-var-count", text: countLabel }),
	]);

	const annotate = el("button", {
		type: "button",
		class: "tree-annotation-button",
		dataset: { nodeId: String(parentNode.id), treeAction: "edit-annotation" },
		"aria-label": `Annotate ${nodeLabel(parentNode)}`,
		text: "✎",
	});

	const head = el("div", { class: `tree-variation-toggle-row depth-${depth}` }, [toggle, annotate]);

	const blocks = expanded
		? el("div", { class: `tree-side-block variation depth-${depth}` }, variations.map((child) => renderLineBlock({
			pathNodeIds: getPreferredPathNodeIds(child.id, getTreeNode),
			startPly: parentPly + 1,
			laneClass: "variation",
			depth: depth + 1,
			context,
		})))
		: null;

	return el("div", { class: `tree-sideline-row variation tree-depth-${depth}` }, [
		el("div", { class: "tree-move-number" }),
		el("div", { class: `tree-sideline-span ${cellRole}` }, [head, blocks]),
	]);
}

/**
 * Renders one continuous line as full-move rows, with each move's alternatives
 * emitted directly beneath the row that contains it. Null when there is no
 * line to draw.
 */
export function renderLineBlock({ pathNodeIds, startPly, laneClass, depth = 0, context }) {
	const { getTreeNode, currentNodeId, currentPathSet, classIcons } = context;
	if (!pathNodeIds || pathNodeIds.length === 0) {
		return null;
	}

	const block = el("div", { class: `tree-branch-block ${laneClass} depth-${depth}` });

	let index = 0;
	while (index < pathNodeIds.length) {
		const ply = startPly + index;
		const firstNode = getTreeNode(pathNodeIds[index]);
		if (!firstNode) {
			break;
		}

		const startsWithWhite = ply % 2 === 1;
		const pairedNode = startsWithWhite && pathNodeIds[index + 1] ? getTreeNode(pathNodeIds[index + 1]) : null;
		const consumed = pairedNode ? 2 : 1;

		const whiteNode = startsWithWhite ? firstNode : null;
		const blackNode = startsWithWhite ? pairedNode : firstNode;
		const whitePly = startsWithWhite ? ply : null;
		const blackPly = startsWithWhite ? ply + 1 : ply;

		// The continuation of *this* line, which is what a variation is measured
		// against. `?? null` at the end of the array is deliberate.
		const whiteNextId = startsWithWhite ? (pathNodeIds[index + 1] ?? null) : null;
		const blackNextId = startsWithWhite ? (pathNodeIds[index + 2] ?? null) : (pathNodeIds[index + 1] ?? null);

		const whiteVariations = variationChildren(whiteNode, whiteNextId, getTreeNode);
		const blackVariations = variationChildren(blackNode, blackNextId, getTreeNode);

		block.append(
			el("div", { class: `tree-fullmove-row ${laneClass} tree-depth-${depth}` }, [
				el("div", { class: "tree-move-number", text: moveNumberLabel(ply) }),
				renderChip({ node: whiteNode, cellRole: "white", laneClass, currentNodeId, currentPathSet, classIcons }),
				renderChip({ node: blackNode, cellRole: "black", laneClass, currentNodeId, currentPathSet, classIcons }),
			]),
			frag([
				renderVariationBlock({ parentNode: whiteNode, variations: whiteVariations, parentPly: whitePly, cellRole: "white", depth, context }),
				renderVariationBlock({ parentNode: blackNode, variations: blackVariations, parentPly: blackPly, cellRole: "black", depth, context }),
			]),
		);

		index += consumed;
	}

	return block;
}

/**
 * Entry point: renders the reference line plus every reachable variation into
 * a detached element the caller mounts.
 */
export function renderMoveTree({
	pathNodeIds,
	getTreeNode,
	currentNodeId,
	expandedParents,
	classIcons = null,
	startPly = 1,
}) {
	const context = {
		getTreeNode,
		currentNodeId,
		currentPathSet: getNodePathSet(currentNodeId, getTreeNode),
		expandedParents: expandedParents || new Set(),
		classIcons,
	};

	return renderLineBlock({ pathNodeIds, startPly, laneClass: "mainline", depth: 0, context });
}
