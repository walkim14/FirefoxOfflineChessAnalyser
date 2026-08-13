/**
 * Renders trap search results.
 *
 * Every string that reaches this module has been through the network, so it is
 * built into the panel as an element or a text node rather than as markup —
 * see `dom.mjs`.
 */

import { el, replaceChildren } from "./dom.mjs";

function percent(value, digits = 0) {
	return `${(value * 100).toFixed(digits)}%`;
}

function games(count) {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M games`;
	}
	if (count >= 1000) {
		return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k games`;
	}
	return count === 1 ? "1 game" : `${count} games`;
}

/**
 * Bands the payoff so the eye can sort the list before reading any numbers.
 *
 * The scale is set by what the quantity can actually reach: expected gain is a
 * share of the opponent pool multiplied by what that share gives up, so even a
 * fine trap — a quarter of opponents losing a third of a point — lands near
 * 0.08. Thresholds borrowed from the move classifier's would put everything in
 * the bottom band.
 */
function payoffTier(expectedGain) {
	if (expectedGain >= 0.08) {
		return { className: "trap-tier-high", label: "Strong" };
	}
	if (expectedGain >= 0.035) {
		return { className: "trap-tier-medium", label: "Solid" };
	}
	return { className: "trap-tier-low", label: "Slight" };
}

function renderReply(reply) {
	const empirical = reply.heroEmpiricalScore === null
		? null
		: el("span", {
			class: "trap-reply-empirical",
			title: "How the side setting the trap has actually scored after this reply",
			text: `scored ${percent(reply.heroEmpiricalScore)}`,
		});

	if (!reply.isTrapped) {
		return el("li", { class: "trap-reply trap-reply-safe" }, [
			el("span", { class: "trap-reply-move", text: reply.san }),
			el("span", { class: "trap-reply-share", text: percent(reply.share) }),
			el("span", { class: "trap-reply-note", text: "holds" }),
			empirical,
		]);
	}

	const punish = reply.refutationSan
		? el("span", { class: "trap-reply-punish" }, [
			"punish with ",
			el("strong", { text: reply.refutationSan }),
		])
		: null;

	return el("li", { class: "trap-reply trap-reply-trapped" }, [
		el("span", { class: "trap-reply-move", text: reply.san }),
		el("span", { class: "trap-reply-share", text: percent(reply.share) }),
		el("span", {
			class: "trap-reply-loss",
			title: "Expected score the reply throws away",
			text: `−${percent(reply.epLoss, 1)}`,
		}),
		punish,
		empirical,
	]);
}

function renderStat(value, label) {
	return el("div", { class: "trap-stat" }, [
		el("span", { class: "trap-stat-value", text: value }),
		el("span", { class: "trap-stat-label", text: label }),
	]);
}

function renderTrap(trap, index, onPlayMove) {
	const tier = payoffTier(trap.expectedGain);
	const opening = trap.opening?.name
		? el("span", {
			class: "trap-opening",
			text: [trap.opening.eco, trap.opening.name].filter(Boolean).join(" "),
		})
		: null;
	const soundness = trap.heroEpLoss <= 0.005
		? "engine's top choice"
		: `costs ${percent(trap.heroEpLoss, 1)} against the best reply`;

	const moveButton = el("button", {
		class: "trap-move",
		type: "button",
		title: "Play this move on the board",
		dataset: { trapAction: "play", trapIndex: String(index) },
		text: trap.san,
	});
	if (typeof onPlayMove === "function") {
		moveButton.addEventListener("click", () => onPlayMove(trap));
	}

	return el("li", { class: `trap-card ${tier.className}`, dataset: { trapIndex: String(index) } }, [
		el("div", { class: "trap-head" }, [
			moveButton,
			el("span", { class: "trap-tier", text: tier.label }),
			el("span", { class: "trap-games", text: games(trap.games) }),
			opening,
		]),
		el("div", { class: "trap-stats" }, [
			renderStat(percent(trap.trapShare), "walk into it"),
			renderStat(`+${percent(trap.expectedGain, 1)}`, "expected gain per game"),
			trap.heroEmpiricalScoreWhenTrapped === null
				? null
				: renderStat(percent(trap.heroEmpiricalScoreWhenTrapped), "actual score when they fall in"),
		]),
		el("div", { class: "trap-soundness", text: `Your move: ${soundness}.` }),
		el("ul", { class: "trap-replies" }, trap.replies.map(renderReply)),
	]);
}

/** Explains an empty result, which is a real answer and not a failure. */
function renderEmpty(result) {
	const nearMisses = result.rejected.slice(0, 3);
	const reasons = nearMisses.map((trap) => {
		const why = !trap.isSound
			? `gives up ${percent(trap.heroEpLoss, 1)} against the best reply`
			: `only ${percent(trap.trapShare)} of replies go wrong`;
		return el("li", { class: "line-item", text: `${trap.san} — ${why}` });
	});

	return [
		el("p", {
			class: "trap-empty",
			text: "No trap here: at this rating the opponent pool answers this position well.",
		}),
		reasons.length ? el("p", { class: "trap-empty-sub", text: "Closest candidates:" }) : null,
		reasons.length ? el("ul", { class: "trap-near-misses" }, reasons) : null,
	];
}

function renderWarning(stoppedEarly) {
	if (stoppedEarly === "rate-limited") {
		return el("p", {
			class: "trap-warning",
			text: "Lichess asked for a pause, so the search stopped early. What is shown is complete for the moves it reached; re-running in a minute picks up from the cache.",
		});
	}
	if (stoppedEarly === "budget") {
		return el("p", {
			class: "trap-warning",
			text: "Stopped at the request budget. Raise it in settings to look at more candidate moves.",
		});
	}
	return null;
}

export function renderTrapResults(container, result, { onPlayMove } = {}) {
	if (!container) {
		return;
	}

	if (!result) {
		replaceChildren(container, el("p", {
			class: "trap-empty",
			text: "Search from the position on the board to see which moves the opponents you face tend to answer badly.",
		}));
		return;
	}

	const heroName = result.heroColor === "w" ? "White" : "Black";
	const sourceNote = [
		`${heroName} to move`,
		games(result.rootGames),
		`${result.requestsUsed} explorer ${result.requestsUsed === 1 ? "request" : "requests"}`,
	].join(" · ");

	const body = result.traps.length
		? el("ol", { class: "trap-list" }, result.traps.map((trap, index) => renderTrap(trap, index, onPlayMove)))
		: renderEmpty(result);

	replaceChildren(container, [
		el("div", { class: "trap-source", text: sourceNote }),
		renderWarning(result.stoppedEarly),
		body,
	]);
}

export function renderTrapStatus(element, message, tone = "info") {
	if (!element) {
		return;
	}
	element.textContent = message || "";
	element.className = `trap-status trap-status-${tone}`;
	element.classList.toggle("hidden", !message);
}
