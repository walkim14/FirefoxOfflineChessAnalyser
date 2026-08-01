/**
 * Renders trap search results.
 *
 * Every string that reaches this module has been through the network, so
 * everything interpolated into markup is escaped.
 */

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

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
		? ""
		: `<span class="trap-reply-empirical" title="How the side setting the trap has actually scored after this reply">scored ${percent(reply.heroEmpiricalScore)}</span>`;

	if (!reply.isTrapped) {
		return `
			<li class="trap-reply trap-reply-safe">
				<span class="trap-reply-move">${escapeHtml(reply.san)}</span>
				<span class="trap-reply-share">${percent(reply.share)}</span>
				<span class="trap-reply-note">holds</span>
				${empirical}
			</li>
		`;
	}

	const punish = reply.refutationSan
		? `<span class="trap-reply-punish">punish with <strong>${escapeHtml(reply.refutationSan)}</strong></span>`
		: "";

	return `
		<li class="trap-reply trap-reply-trapped">
			<span class="trap-reply-move">${escapeHtml(reply.san)}</span>
			<span class="trap-reply-share">${percent(reply.share)}</span>
			<span class="trap-reply-loss" title="Expected score the reply throws away">−${percent(reply.epLoss, 1)}</span>
			${punish}
			${empirical}
		</li>
	`;
}

function renderTrap(trap, index) {
	const tier = payoffTier(trap.expectedGain);
	const opening = trap.opening?.name
		? `<span class="trap-opening">${escapeHtml([trap.opening.eco, trap.opening.name].filter(Boolean).join(" "))}</span>`
		: "";
	const soundness = trap.heroEpLoss <= 0.005
		? "engine's top choice"
		: `costs ${percent(trap.heroEpLoss, 1)} against the best reply`;
	const empirical = trap.heroEmpiricalScoreWhenTrapped === null
		? ""
		: `<div class="trap-stat"><span class="trap-stat-value">${percent(trap.heroEmpiricalScoreWhenTrapped)}</span><span class="trap-stat-label">actual score when they fall in</span></div>`;

	return `
		<li class="trap-card ${tier.className}" data-trap-index="${index}">
			<div class="trap-head">
				<button class="trap-move" type="button" data-trap-action="play" data-trap-index="${index}" title="Play this move on the board">${escapeHtml(trap.san)}</button>
				<span class="trap-tier">${tier.label}</span>
				<span class="trap-games">${games(trap.games)}</span>
				${opening}
			</div>
			<div class="trap-stats">
				<div class="trap-stat">
					<span class="trap-stat-value">${percent(trap.trapShare)}</span>
					<span class="trap-stat-label">walk into it</span>
				</div>
				<div class="trap-stat">
					<span class="trap-stat-value">+${percent(trap.expectedGain, 1)}</span>
					<span class="trap-stat-label">expected gain per game</span>
				</div>
				${empirical}
			</div>
			<div class="trap-soundness">Your move: ${escapeHtml(soundness)}.</div>
			<ul class="trap-replies">${trap.replies.map(renderReply).join("")}</ul>
		</li>
	`;
}

/** Explains an empty result, which is a real answer and not a failure. */
function renderEmpty(result) {
	const nearMisses = result.rejected.slice(0, 3);
	const reasons = nearMisses.map((trap) => {
		const why = !trap.isSound
			? `gives up ${percent(trap.heroEpLoss, 1)} against the best reply`
			: `only ${percent(trap.trapShare)} of replies go wrong`;
		return `<li class="line-item">${escapeHtml(trap.san)} — ${escapeHtml(why)}</li>`;
	});

	return `
		<p class="trap-empty">No trap here: at this rating the opponent pool answers this position well.</p>
		${reasons.length ? `<p class="trap-empty-sub">Closest candidates:</p><ul class="trap-near-misses">${reasons.join("")}</ul>` : ""}
	`;
}

export function renderTrapResults(container, result, { onPlayMove } = {}) {
	if (!container) {
		return;
	}

	if (!result) {
		container.innerHTML = "<p class='trap-empty'>Search from the position on the board to see which moves the opponents you face tend to answer badly.</p>";
		return;
	}

	const heroName = result.heroColor === "w" ? "White" : "Black";
	const sourceNote = [
		`${heroName} to move`,
		games(result.rootGames),
		`${result.requestsUsed} explorer ${result.requestsUsed === 1 ? "request" : "requests"}`,
	].join(" · ");

	const warning = result.stoppedEarly === "rate-limited"
		? "<p class='trap-warning'>Lichess asked for a pause, so the search stopped early. What is shown is complete for the moves it reached; re-running in a minute picks up from the cache.</p>"
		: result.stoppedEarly === "budget"
			? "<p class='trap-warning'>Stopped at the request budget. Raise it in settings to look at more candidate moves.</p>"
			: "";

	const body = result.traps.length
		? `<ol class="trap-list">${result.traps.map(renderTrap).join("")}</ol>`
		: renderEmpty(result);

	container.innerHTML = `
		<div class="trap-source">${escapeHtml(sourceNote)}</div>
		${warning}
		${body}
	`;

	if (typeof onPlayMove === "function") {
		container.querySelectorAll("[data-trap-action='play']").forEach((button) => {
			button.addEventListener("click", () => {
				const trap = result.traps[Number(button.dataset.trapIndex)];
				if (trap) {
					onPlayMove(trap);
				}
			});
		});
	}
}

export function renderTrapStatus(element, message, tone = "info") {
	if (!element) {
		return;
	}
	element.textContent = message || "";
	element.className = `trap-status trap-status-${tone}`;
	element.classList.toggle("hidden", !message);
}
