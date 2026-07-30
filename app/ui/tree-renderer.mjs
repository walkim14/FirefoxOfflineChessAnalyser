function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (character) => {
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
		return `<div class="tree-ply-cell ${cellRole} empty"></div>`;
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
	const badge = icon
		? `<span class="tree-chip-class ${escapeHtml(slug)}" aria-hidden="true">${escapeHtml(icon)}</span>`
		: "";
	const labelBadge = node.annotationLabel
		? `<span class="tree-node-label">${escapeHtml(node.annotationLabel)}</span>`
		: "";

	const titleParts = [nodeLabel(node)];
	if (classification) {
		titleParts.push(classification);
	}
	if (node.annotationNote) {
		titleParts.push(node.annotationNote);
	}
	const title = ` title="${escapeHtml(titleParts.join(" — "))}"`;

	const move = `<span class="tree-chip-move">${escapeHtml(nodeLabel(node))}</span>`;
	const chip = `<button type="button" class="${classes.join(" ")}" data-node-id="${node.id}" data-tree-action="jump-node"${title}>${badge}${move}${labelBadge}</button>`;
	return `<div class="tree-ply-cell ${cellRole}">${chip}</div>`;
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
		return "";
	}

	const { expandedParents, currentPathSet, currentNodeId, getTreeNode, classIcons } = context;
	// A variation holding the current move is always shown: otherwise the move
	// the user just played would be hidden behind a collapsed toggle.
	const holdsCurrent = variations.some((child) => currentPathSet.has(child.id));
	const expanded = expandedParents.has(parentNode.id) || holdsCurrent;
	const count = variations.length;
	const countLabel = count === 1 ? "1 line" : `${count} lines`;

	const toggle = `<button type="button" class="tree-var-toggle ${expanded ? "expanded" : ""}" data-parent-node-id="${parentNode.id}" data-tree-action="toggle-variations" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${escapeHtml(countLabel)} after ${escapeHtml(nodeLabel(parentNode))}"><span class="tree-var-arrow" aria-hidden="true">${expanded ? "▾" : "▸"}</span><span class="tree-var-count">${escapeHtml(countLabel)}</span></button>`;
	const annotate = `<button type="button" class="tree-annotation-button" data-node-id="${parentNode.id}" data-tree-action="edit-annotation" aria-label="Annotate ${escapeHtml(nodeLabel(parentNode))}">✎</button>`;
	const head = `<div class="tree-variation-toggle-row depth-${depth}">${toggle}${annotate}</div>`;

	if (!expanded) {
		return `<div class="tree-sideline-row variation tree-depth-${depth}"><div class="tree-move-number"></div><div class="tree-sideline-span ${cellRole}">${head}</div></div>`;
	}

	const blocks = variations
		.map((child) => renderLineBlock({
			pathNodeIds: getPreferredPathNodeIds(child.id, getTreeNode),
			startPly: parentPly + 1,
			laneClass: "variation",
			depth: depth + 1,
			context,
		}))
		.join("");

	return `<div class="tree-sideline-row variation tree-depth-${depth}"><div class="tree-move-number"></div><div class="tree-sideline-span ${cellRole}">${head}<div class="tree-side-block variation depth-${depth}">${blocks}</div></div></div>`;
}

/**
 * Renders one continuous line as full-move rows, with each move's alternatives
 * emitted directly beneath the row that contains it.
 */
export function renderLineBlock({ pathNodeIds, startPly, laneClass, depth = 0, context }) {
	const { getTreeNode, currentNodeId, currentPathSet, classIcons } = context;
	if (!pathNodeIds || pathNodeIds.length === 0) {
		return "";
	}

	let html = `<div class="tree-branch-block ${laneClass} depth-${depth}">`;

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

		html += `
			<div class="tree-fullmove-row ${laneClass} tree-depth-${depth}">
				<div class="tree-move-number">${escapeHtml(moveNumberLabel(ply))}</div>
				${renderChip({ node: whiteNode, cellRole: "white", laneClass, currentNodeId, currentPathSet, classIcons })}
				${renderChip({ node: blackNode, cellRole: "black", laneClass, currentNodeId, currentPathSet, classIcons })}
			</div>
			${renderVariationBlock({ parentNode: whiteNode, variations: whiteVariations, parentPly: whitePly, cellRole: "white", depth, context })}
			${renderVariationBlock({ parentNode: blackNode, variations: blackVariations, parentPly: blackPly, cellRole: "black", depth, context })}
		`;

		index += consumed;
	}

	html += "</div>";
	return html;
}

/**
 * Entry point: renders the reference line plus every reachable variation.
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
