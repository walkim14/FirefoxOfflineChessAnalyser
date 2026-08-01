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
	// One job each: say what this label means. The expected-points scale is
	// explained once, on the accuracy heading, instead of on all ten of these.
	const helpByLabel = {
		book: "Matches the offline opening database, either for this position or one it transposes into.",
		brilliant: "The only move that holds the position, and it gives up material to do it.",
		great: "The only move that holds the position — every alternative is clearly worse.",
		best: "The engine's first choice.",
		excellent: "All but identical to the best move: it costs under 2% of a point.",
		good: "Close to the best move, costing under 5% of a point.",
		inaccuracy: "Loses ground without losing the game: 5% to 10% of a point.",
		miss: "A winning move or tactic was available and went unplayed.",
		mistake: "Hands over 10% to 20% of a point.",
		blunder: "Hands over more than 20% of a point, usually to a tactic.",
	};

	return helpByLabel[slug] || "How this move compares with the engine's first choice.";
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

	// Player names come straight from PGN headers, so they are untrusted markup.
	const whiteName = escapeHtml(state.players.whiteName || "White");
	const blackName = escapeHtml(state.players.blackName || "Black");

	if (refs.overviewHeading) {
		refs.overviewHeading.innerHTML =
			`<span class="overview-eyebrow">Accuracy</span>${renderHelpBubble("Accuracy", ACCURACY_HELP)}`;
	}
	refs.overviewWhite.innerHTML = renderPlayerTile("white", whiteName, buckets.white);
	refs.overviewBlack.innerHTML = renderPlayerTile("black", blackName, buckets.black);

	const allLabels = new Set([...buckets.white.labels.keys(), ...buckets.black.labels.keys()]);
	if (allLabels.size === 0) {
		refs.overviewBreakdown.innerHTML =
			"<p class='overview-empty'>Load a game to see how each move was played.</p>";
		return;
	}

	// Best to worst: the list itself is the severity scale, so the ordering
	// carries meaning that the (deliberately close) label colours do not.
	const labelOrder = ["Brilliant", "Great", "Best", "Book", "Excellent", "Good", "Inaccuracy", "Miss", "Mistake", "Blunder"];
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

	// One shared scale across every row, so bar lengths are comparable.
	let peak = 1;
	for (const label of orderedLabels) {
		peak = Math.max(peak, buckets.white.labels.get(label) || 0, buckets.black.labels.get(label) || 0);
	}

	const rows = orderedLabels.map((label) => {
		const w = buckets.white.labels.get(label) || 0;
		const b = buckets.black.labels.get(label) || 0;
		const slug = classificationSlug(label);
		const icon = classIcons[slug] || "•";
		const help = renderHelpBubble(label, classificationHelpText(label));

		return `<div class="overview-row ${slug}">
			<span class="overview-label"><span class="overview-icon" aria-hidden="true">${icon}</span><span class="overview-label-text">${escapeHtml(label)}</span>${help}</span>
			<span class="overview-tally white ${w === 0 ? "zero" : ""}">${w}</span>
			<span class="overview-track white"><span class="overview-fill" style="inline-size:${(w / peak) * 100}%"></span></span>
			<span class="overview-track black"><span class="overview-fill" style="inline-size:${(b / peak) * 100}%"></span></span>
			<span class="overview-tally black ${b === 0 ? "zero" : ""}">${b}</span>
		</div>`;
	});

	refs.overviewBreakdown.innerHTML = `
		<div class="overview-eyebrow">Moves by quality</div>
		<div class="overview-scale">
			<span class="overview-scale-side white">${whiteName}</span>
			<span class="overview-scale-side black">${blackName}</span>
		</div>
		<div class="overview-rows">${rows.join("")}</div>
	`;
}

const ACCURACY_HELP =
	"Accuracy weighs how much each move cost, in expected points and in centipawns. 100 means every move matched the engine's first choice.";

function renderPlayerTile(side, name, bucket) {
	const hasMoves = bucket.counted > 0;
	const accuracy = hasMoves ? bucket.totalAccuracy / bucket.counted : null;
	const shown = hasMoves ? accuracy.toFixed(1) : "—";
	const moves = bucket.counted === 1 ? "1 move" : `${bucket.counted} moves`;

	return `
		<div class="overview-player ${side}">
			<span class="overview-side-chip" aria-hidden="true"></span>
			<span class="overview-name">${name}</span>
			<span class="overview-acc"><span class="overview-acc-value">${shown}</span>${hasMoves ? '<span class="overview-acc-unit">%</span>' : ""}</span>
			<span class="overview-meter"><span class="overview-meter-fill" style="inline-size:${hasMoves ? accuracy : 0}%"></span></span>
			<span class="overview-count">${hasMoves ? moves : "not analysed yet"}</span>
		</div>
	`;
}

export { ACCURACY_HELP };
