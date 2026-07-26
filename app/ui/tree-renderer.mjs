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

function getPreferredPathNodeIds(startNodeId, getTreeNode) {
	const nodeIds = [];
	let cursor = getTreeNode(startNodeId);

	while (cursor) {
		nodeIds.push(cursor.id);
		const nextId = cursor.children[0];
		if (!nextId) {
			break;
		}
		cursor = getTreeNode(nextId);
	}

	return nodeIds;
}

function renderSidelineBody({
	node,
	nodePly,
	mainChildId,
	depth,
	treeExpandedParents,
	getTreeNode,
	currentNodeId,
	rootNodeId,
}) {
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

	const expanded = treeExpandedParents.has(node.id);
	const toggle = `<button type="button" class="tree-var-toggle ${expanded ? "expanded" : ""}" data-parent-node-id="${node.id}" data-tree-action="toggle-variations" aria-label="${expanded ? "Collapse" : "Expand"} variations"><span class="tree-var-arrow">${expanded ? "▾" : "▸"}</span></button>`;
	const annotate = `<button type="button" class="tree-annotation-button" data-node-id="${node.id}" data-tree-action="edit-annotation" aria-label="Annotate sideline">✎</button>`;

	if (!expanded) {
		return `<div class="tree-variation-toggle-row depth-${depth}">${annotate}${toggle}</div>`;
	}

	const nested = sideChildren
		.map((child) => renderLineBlock({
			startNodeId: child.id,
			startPly: nodePly + 1,
			laneClass: "variation",
			depth: depth + 1,
			getTreeNode,
			treeExpandedParents,
			currentNodeId,
			rootNodeId,
		}))
		.join("");

	return `
		<div class="tree-variation-toggle-row depth-${depth}">${annotate}${toggle}</div>
		<div class="tree-side-block variation depth-${depth}">${nested}</div>
	`;
}

function renderNodeCell({ node, laneClass, cellRole, currentNodeId, currentPathSet }) {
	if (!node) {
		return `<div class="tree-ply-cell ${cellRole} empty"></div>`;
	}

	const isCurrent = currentNodeId === node.id;
	const noteTitle = node.annotationNote ? ` title="${escapeHtml(node.annotationNote)}"` : "";
	const labelBadge = node.annotationLabel ? `<span class="tree-node-label">${escapeHtml(node.annotationLabel)}</span>` : "";
	const classes = ["tree-chip", cellRole, laneClass === "mainline" ? "mainline" : "variation"];
	if (isCurrent) {
		classes.push("current");
	}
	if (currentPathSet.has(node.id)) {
		classes.push("in-current-path");
	}

	const chip = `<button type="button" class="${classes.join(" ")}" data-node-id="${node.id}" data-tree-action="jump-node"${noteTitle}>${escapeHtml(node.moveUci)}${labelBadge}</button>`;

	return `<div class="tree-ply-cell ${cellRole}">${chip}</div>`;
}

function renderSidelineRow(content, cellRole, laneClass, depth) {
	if (!content) {
		return "";
	}

	return `
		<div class="tree-sideline-row ${laneClass} tree-depth-${depth}">
			<div class="tree-move-number"></div>
			<div class="tree-sideline-span ${cellRole}">${content}</div>
		</div>
	`;
}

export function getNodePathSet(nodeId, getTreeNode) {
	const ids = new Set();
	let cursor = getTreeNode(nodeId);

	while (cursor) {
		ids.add(cursor.id);
		cursor = cursor.parentId ? getTreeNode(cursor.parentId) : null;
	}

	return ids;
}

export function getReferenceMainlineNodeIds(treeRootId, getTreeNode) {
	const nodeIds = [treeRootId];
	let cursor = getTreeNode(treeRootId);

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

export function renderLineBlock({
	startNodeId,
	startPly,
	laneClass,
	depth = 0,
	pathNodeIds = null,
	getTreeNode,
	treeExpandedParents,
	currentNodeId,
	rootNodeId,
}) {
	const preferredPathNodeIds = pathNodeIds || getPreferredPathNodeIds(startNodeId, getTreeNode);
	const resolvedPathNodeIds = startNodeId === rootNodeId ? preferredPathNodeIds.slice(1) : preferredPathNodeIds;
	if (!resolvedPathNodeIds.length) {
		return "";
	}

	const currentPathSet = getNodePathSet(currentNodeId, getTreeNode);
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
			whiteMainChildId = nextNode ? nextNode.id : (currentNode.children[0] || null);
			blackMainChildId = resolvedPathNodeIds[index + 2] ? resolvedPathNodeIds[index + 2] : null;
		} else {
			blackNode = currentNode;
			blackMainChildId = nextNode ? nextNode.id : (currentNode.children[0] || null);
		}

		const whiteSideline = whiteNode
			? renderSidelineBody({
				node: whiteNode,
				nodePly: whitePly,
				mainChildId: whiteMainChildId,
				depth,
				treeExpandedParents,
				getTreeNode,
				currentNodeId,
				rootNodeId,
			})
			: "";
		const blackSideline = blackNode
			? renderSidelineBody({
				node: blackNode,
				nodePly: blackPly,
				mainChildId: blackMainChildId,
				depth,
				treeExpandedParents,
				getTreeNode,
				currentNodeId,
				rootNodeId,
			})
			: "";

		html += `
			<div class="tree-fullmove-row ${laneClass} tree-depth-${depth}">
				<div class="tree-move-number">${escapeHtml(rowLabel)}</div>
				${renderNodeCell({ node: whiteNode, laneClass, cellRole: "white", currentNodeId, currentPathSet })}
				${renderNodeCell({ node: blackNode, laneClass, cellRole: "black", currentNodeId, currentPathSet })}
			</div>
			${renderSidelineRow(whiteSideline, "white", laneClass, depth)}
			${renderSidelineRow(blackSideline, "black", laneClass, depth)}
		`;

		if (ply % 2 === 1 && nextNode) {
			index += 2;
			ply += 2;
		} else {
			index += 1;
			ply += 1;
		}
	}

	html += "</div>";
	return html;
}
