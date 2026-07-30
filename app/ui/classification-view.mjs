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

export function classificationSlug(label) {
	return String(label || "unknown").toLowerCase().replace(/\s+/g, "-");
}

export function classificationHighlightColor(label) {
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

export function shortLabelForTag(label, classIcons) {
	const normalized = String(label || "").toLowerCase();
	return classIcons[normalized] || normalized.toUpperCase();
}

export function isReviewSkipLabel(label) {
	const slug = String(label || "").toLowerCase().replace(/\s+/g, "-");
	return slug === "book" || slug === "good" || slug === "excellent";
}

export function classificationHelpText(label) {
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

export function renderHelpBubble(label, helpText) {
	const safeHelp = escapeHtml(helpText);
	return `<span class="help-bubble" tabindex="0" role="button" aria-label="${escapeHtml(label)} help"><span class="help-bubble-mark">?</span><span class="help-tooltip" role="tooltip">${safeHelp}</span></span>`;
}

export function updateClassificationView(refs, result, classIcons) {
	if (!result) {
		refs.classificationPill.className = "pill neutral";
		refs.classificationPill.textContent = "No move classified yet";
		refs.classificationMeta.innerHTML = "";
		return;
	}

	const labelClass = result.label.toLowerCase().replace(/\s+/g, "-");
	refs.classificationPill.className = `pill ${labelClass}`;
	const icon = classIcons[labelClass] || "•";
	refs.classificationPill.innerHTML = `<span class="pill-icon">${icon}</span> ${result.label} ${renderHelpBubble(result.label, classificationHelpText(result.label))} <span class="pill-ep">EP loss ${(result.epLoss * 100).toFixed(1)}%</span>`;

	const bestCp = (result.bestCpWhite / 100).toFixed(2);
	const playedCp = (result.playedCpWhite / 100).toFixed(2);
	const rows = [
		`Best move: ${result.bestMove || "n/a"}`,
		`Played move: ${result.playedMoveUci || "n/a"}`,
		`Eval best: ${bestCp}`,
		`Eval played: ${playedCp}`,
	];

	for (const note of result.notes || []) {
		rows.push(note);
	}

	refs.classificationMeta.innerHTML = rows
		.map((row) => `<div class="line-item">${escapeHtml(row)}</div>`)
		.join("");
}

export function updateEngineLinesView(refs, analysis, expectedWhitePercent) {
	if (!analysis || !analysis.lines || analysis.lines.length === 0) {
		refs.engineLines.innerHTML = analysis?.terminal
			? `<div class='line-item'>Game over: ${escapeHtml(analysis.terminal)}.</div>`
			: "<div class='line-item'>No line yet.</div>";
		return;
	}

	refs.engineLines.innerHTML = analysis.lines
		.map((line) => {
			const whiteWin = expectedWhitePercent(line.cpWhite).toFixed(1);
			const head = `#${line.multipv} ${line.move} | eval ${line.evalText} | white win ${whiteWin}%`;
			return `<div class="line-item">${escapeHtml(head)}<br>${escapeHtml(line.pv)}</div>`;
		})
		.join("");
}

export function estimatedMoveAccuracy(classification, clamp) {
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

	const epPenalty = Math.min(18, epLoss * 140);
	const cpPenalty = Math.min(16, cpLoss / 35);
	return clamp(base - epPenalty - cpPenalty, 0, 100);
}

export function renderOverview({ refs, state, Chess, getTreeNode, classIcons, clamp }) {
	if (!refs.overviewWhite || !refs.overviewBlack || !refs.overviewBreakdown) {
		return;
	}

	const buckets = {
		white: { totalAccuracy: 0, counted: 0, labels: new Map() },
		black: { totalAccuracy: 0, counted: 0, labels: new Map() },
	};

	for (let ply = 1; ply <= state.lineMoves.length; ply += 1) {
		const nodeId = state.activeLineNodeIds[ply];
		const node = nodeId ? getTreeNode(state, nodeId) : null;
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
		const accuracy = estimatedMoveAccuracy(classification, clamp);
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
	// Player names come straight from PGN headers, so they are untrusted markup.
	const whiteName = escapeHtml(state.players.whiteName || "White");
	const blackName = escapeHtml(state.players.blackName || "Black");
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
		const icon = classIcons[slug] || "•";
		rows.push(
			`<div class='overview-row ${slug}'><span class='overview-label'><span class='overview-icon'>${icon}</span>${label}${renderHelpBubble(label, classificationHelpText(label))}</span><span class='overview-values'>${whiteName} ${w} | ${blackName} ${b}</span></div>`,
		);
	}

	refs.overviewBreakdown.innerHTML = `<div class='overview-breakdown-grid'>${rows.join("")}</div>`;
}
