import { el, replaceChildren } from "./dom.mjs";

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
	return el("span", { class: "help-bubble", tabindex: "0", role: "button", "aria-label": `${label} help` }, [
		el("span", { class: "help-bubble-mark", text: "?" }),
		el("span", { class: "help-tooltip", role: "tooltip", text: helpText }),
	]);
}

export function updateClassificationView(refs, result, classIcons) {
	if (!result) {
		refs.classificationPill.className = "pill neutral";
		refs.classificationPill.textContent = "No move classified yet";
		replaceChildren(refs.classificationMeta);
		return;
	}

	const labelClass = result.label.toLowerCase().replace(/\s+/g, "-");
	refs.classificationPill.className = `pill ${labelClass}`;
	const icon = classIcons[labelClass] || "•";
	// The pill lays out as inline text, so the spaces between its parts are
	// what keeps the label off the icon and the bubble.
	replaceChildren(refs.classificationPill, [
		el("span", { class: "pill-icon", text: icon }),
		` ${result.label} `,
		renderHelpBubble(result.label, classificationHelpText(result.label)),
		" ",
		el("span", { class: "pill-ep", text: `EP loss ${(result.epLoss * 100).toFixed(1)}%` }),
	]);

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

	replaceChildren(refs.classificationMeta, rows.map((row) => el("div", { class: "line-item", text: row })));
}

export function updateEngineLinesView(refs, analysis, expectedWhitePercent) {
	if (!analysis || !analysis.lines || analysis.lines.length === 0) {
		replaceChildren(refs.engineLines, el("div", {
			class: "line-item",
			text: analysis?.terminal ? `Game over: ${analysis.terminal}.` : "No line yet.",
		}));
		return;
	}

	replaceChildren(refs.engineLines, analysis.lines.map((line) => {
		const whiteWin = expectedWhitePercent(line.cpWhite).toFixed(1);
		const head = `#${line.multipv} ${line.move} | eval ${line.evalText} | white win ${whiteWin}%`;
		return el("div", { class: "line-item" }, [head, el("br"), line.pv]);
	}));
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

	// Player names come straight from PGN headers, so they are set as text.
	const whiteName = state.players.whiteName || "White";
	const blackName = state.players.blackName || "Black";

	if (refs.overviewHeading) {
		replaceChildren(refs.overviewHeading, [
			el("span", { class: "overview-eyebrow", text: "Accuracy" }),
			renderHelpBubble("Accuracy", ACCURACY_HELP),
		]);
	}
	replaceChildren(refs.overviewWhite, renderPlayerTile("white", whiteName, buckets.white));
	replaceChildren(refs.overviewBlack, renderPlayerTile("black", blackName, buckets.black));

	const allLabels = new Set([...buckets.white.labels.keys(), ...buckets.black.labels.keys()]);
	if (allLabels.size === 0) {
		replaceChildren(refs.overviewBreakdown, el("p", {
			class: "overview-empty",
			text: "Load a game to see how each move was played.",
		}));
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

		return el("div", { class: `overview-row ${slug}` }, [
			el("span", { class: "overview-label" }, [
				el("span", { class: "overview-icon", "aria-hidden": "true", text: icon }),
				el("span", { class: "overview-label-text", text: label }),
				renderHelpBubble(label, classificationHelpText(label)),
			]),
			renderTally("white", w),
			renderTrack("white", w / peak),
			renderTrack("black", b / peak),
			renderTally("black", b),
		]);
	});

	replaceChildren(refs.overviewBreakdown, [
		el("div", { class: "overview-eyebrow", text: "Moves by quality" }),
		el("div", { class: "overview-scale" }, [
			el("span", { class: "overview-scale-side white", text: whiteName }),
			el("span", { class: "overview-scale-side black", text: blackName }),
		]),
		el("div", { class: "overview-rows" }, rows),
	]);
}

function renderTally(side, count) {
	return el("span", {
		class: `overview-tally ${side}${count === 0 ? " zero" : ""}`,
		text: String(count),
	});
}

function renderTrack(side, share) {
	return el("span", { class: `overview-track ${side}` }, [
		el("span", { class: "overview-fill", style: { "inline-size": `${share * 100}%` } }),
	]);
}

export const SETTING_HELP = {
	depth: 'How far ahead the engine looks at the position on the board. Each extra step roughly doubles the time a search takes, so raise it for a sharper answer and lower it for a faster one.',
	reviewdepth: 'How far ahead the engine looks when scoring a whole game. It is kept lower than Depth because a review only has to sort each move into a band. At the default it still finds every inaccuracy, mistake and blunder; raising it mainly refines the gradation between Best, Excellent and Good.',
	multipv: 'How many candidate moves the engine reports for the position on the board. More lines cost more time.',
	hash: 'How much memory the engine may use to remember positions it has already worked out. A review shares this budget across the engines it runs in parallel.',
	elo: 'Used to judge whether a sacrifice was worth spotting, so Brilliant and Great mean roughly the same thing at your level.',
	traprating: 'Which players the trap statistics are drawn from. A trap is only a trap against a particular strength of opponent: what a 1400 walks into, a 2200 has seen before. "Around your rating" follows the rating set above.',
	trapspeed: 'Which time controls the games are drawn from. Faster games contain more traps, because nobody has time to check.',
	trapseverity: 'How badly a reply has to go wrong before it counts as falling into the trap, measured in expected score. A slighter setting finds more traps but weaker ones.',
	trapbudget: 'The most requests one search may send to the Lichess explorer. Each candidate move costs one request, and results are cached, so repeating a search over the same opening is usually free.',
	traptoken: 'A free Lichess personal access token. The opening explorer required no login until it was hit by request floods in early 2026; it now needs a token, though no scopes have to be granted. It is stored locally, like every other setting here.',
};

const ACCURACY_HELP =
	"Accuracy weighs how much each move cost, in expected points and in centipawns. 100 means every move matched the engine's first choice.";

function renderPlayerTile(side, name, bucket) {
	const hasMoves = bucket.counted > 0;
	const accuracy = hasMoves ? bucket.totalAccuracy / bucket.counted : null;
	const shown = hasMoves ? accuracy.toFixed(1) : "—";
	const moves = bucket.counted === 1 ? "1 move" : `${bucket.counted} moves`;

	return el("div", { class: `overview-player ${side}` }, [
		el("span", { class: "overview-side-chip", "aria-hidden": "true" }),
		el("span", { class: "overview-name", text: name }),
		el("span", { class: "overview-acc" }, [
			el("span", { class: "overview-acc-value", text: shown }),
			hasMoves ? el("span", { class: "overview-acc-unit", text: "%" }) : null,
		]),
		el("span", { class: "overview-meter" }, [
			el("span", { class: "overview-meter-fill", style: { "inline-size": `${hasMoves ? accuracy : 0}%` } }),
		]),
		el("span", { class: "overview-count", text: hasMoves ? moves : "not analysed yet" }),
	]);
}

export { ACCURACY_HELP };
