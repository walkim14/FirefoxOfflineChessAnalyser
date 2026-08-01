/**
 * Drives the trap finder: reads the controls, runs the search from the position
 * on the board, and paints the result.
 *
 * The search itself lives in `app/traps/trap-finder.mjs` and knows nothing about
 * the DOM. This file is the part that has to care about the engine pool being
 * shared with the whole-game review, about a search the user cancels halfway,
 * and about turning a failed network call into a sentence worth reading.
 */

import { findTraps } from "../../traps/trap-finder.mjs";
import { bucketsAroundRating, ExplorerAuthError, ExplorerRateLimitError } from "../../traps/explorer-client.mjs";
import { renderTrapResults, renderTrapStatus } from "../../ui/traps-view.mjs";

export function createTrapController({
	state,
	refs,
	Chess,
	enginePool,
	explorer,
	explorerCache,
	dispatchPositions,
	getScanProfile,
	cancelMainlineScan,
	gameAtPly,
	playMoveAtCurrentPly,
	setStatus,
	debugLog,
	saveSettings,
}) {
	let abortController = null;

	function isSearching() {
		return Boolean(abortController);
	}

	/** Which rating buckets to ask about, honouring "around your rating". */
	function ratingsForSearch() {
		const band = state.settings.trapRatingBand;
		if (!band || band === "auto") {
			return bucketsAroundRating(state.settings.playerElo);
		}
		return String(band)
			.split(",")
			.map((value) => Number(value))
			.filter((value) => Number.isFinite(value));
	}

	function speedsForSearch() {
		return String(state.settings.trapSpeeds || "blitz,rapid").split(",").filter(Boolean);
	}

	/** Pushes stored settings into the controls. Called once, at boot. */
	function syncTrapControls() {
		if (refs.trapRatingSelect) {
			refs.trapRatingSelect.value = state.settings.trapRatingBand || "auto";
		}
		if (refs.trapSpeedSelect) {
			refs.trapSpeedSelect.value = state.settings.trapSpeeds || "blitz,rapid";
		}
		if (refs.trapSeveritySelect) {
			refs.trapSeveritySelect.value = String(state.settings.trapBlunderEpLoss ?? 0.15);
		}
		if (refs.trapBudgetInput) {
			refs.trapBudgetInput.value = String(state.settings.trapRequestBudget ?? 14);
		}
		if (refs.trapTokenInput) {
			refs.trapTokenInput.value = state.settings.lichessToken || "";
		}
	}

	function readTrapControls() {
		if (refs.trapRatingSelect) {
			state.settings.trapRatingBand = refs.trapRatingSelect.value || "auto";
		}
		if (refs.trapSpeedSelect) {
			state.settings.trapSpeeds = refs.trapSpeedSelect.value || "blitz,rapid";
		}
		if (refs.trapSeveritySelect) {
			state.settings.trapBlunderEpLoss = Number(refs.trapSeveritySelect.value) || 0.15;
		}
		if (refs.trapBudgetInput) {
			const budget = Number(refs.trapBudgetInput.value);
			state.settings.trapRequestBudget = Number.isFinite(budget) ? Math.max(2, Math.min(30, Math.trunc(budget))) : 14;
			refs.trapBudgetInput.value = String(state.settings.trapRequestBudget);
		}
		if (refs.trapTokenInput) {
			state.settings.lichessToken = refs.trapTokenInput.value.trim();
		}
		saveSettings();
	}

	function setBusy(busy) {
		if (refs.findTrapsBtn) {
			refs.findTrapsBtn.disabled = busy;
			refs.findTrapsBtn.textContent = busy ? "Searching..." : "Find traps";
		}
		if (refs.cancelTrapsBtn) {
			refs.cancelTrapsBtn.classList.toggle("hidden", !busy);
		}
	}

	function reportProgress(update) {
		const label = update.phase === "explorer"
			? `${update.label} — ${update.done}/${update.total} positions looked up`
			: `${update.label} — ${update.done}/${update.total} searched`;
		renderTrapStatus(refs.trapStatus, label, "info");
	}

	function describeFailure(error) {
		if (error instanceof ExplorerAuthError) {
			refs.trapTokenInput?.focus();
			return { message: error.message, tone: "warn" };
		}
		if (error instanceof ExplorerRateLimitError) {
			return { message: error.message, tone: "warn" };
		}
		if (error?.name === "AbortError") {
			return { message: "Trap search canceled.", tone: "info" };
		}
		return { message: error?.message || String(error), tone: "error" };
	}

	async function findTrapsFromBoard() {
		if (isSearching()) {
			return;
		}

		readTrapControls();
		// The pool is shared with the whole-game review, and this is about to take
		// it over.
		cancelMainlineScan();

		const rootFen = gameAtPly(state.currentPly).fen();
		abortController = new AbortController();
		setBusy(true);
		renderTrapStatus(refs.trapStatus, "Starting search...", "info");

		const { depth } = getScanProfile();
		let result = null;

		try {
			await enginePool.start({ hashMb: state.settings.hashMb });
			debugLog("Trap search started", {
				rootFen,
				ratings: ratingsForSearch(),
				speeds: speedsForSearch(),
				budget: state.settings.trapRequestBudget,
			});

			result = await findTraps({
				rootFen,
				explorer,
				ChessImpl: Chess,
				ratings: ratingsForSearch(),
				speeds: speedsForSearch(),
				// Only the score and the best reply matter here, so one line is enough.
				evaluateAll: (fens) => dispatchPositions({ fens, depth, multiPV: 1 }),
				options: {
					blunderEpLoss: state.settings.trapBlunderEpLoss,
					requestBudget: state.settings.trapRequestBudget,
				},
				onProgress: reportProgress,
				signal: abortController.signal,
			});
		} catch (error) {
			const { message, tone } = describeFailure(error);
			debugLog("Trap search failed", String(error?.message || error));
			renderTrapStatus(refs.trapStatus, message, tone);
			return;
		} finally {
			// Hand the machine back; the pool is only needed while searching.
			enginePool.dispose();
			abortController = null;
			setBusy(false);
		}

		state.trapResult = result;
		renderTrapResults(refs.trapResults, result, { onPlayMove: onPlayTrapMove });

		const found = result.traps.length;
		renderTrapStatus(
			refs.trapStatus,
			found
				? `${found} trap${found === 1 ? "" : "s"} found · ${result.requestsUsed} explorer request${result.requestsUsed === 1 ? "" : "s"} · ${result.positionsEvaluated} positions searched at depth ${depth}`
				: `No trap found here · ${result.requestsUsed} explorer request${result.requestsUsed === 1 ? "" : "s"}`,
			found ? "ok" : "info",
		);
		setStatus(found ? `Trap finder: ${found} candidate${found === 1 ? "" : "s"} from this position.` : "Trap finder: nothing at this rating.");
	}

	function cancelTrapSearch() {
		if (!abortController) {
			return;
		}
		abortController.abort();
		enginePool.cancel("Trap search canceled.");
		renderTrapStatus(refs.trapStatus, "Canceling...", "info");
	}

	async function onPlayTrapMove(trap) {
		await playMoveAtCurrentPly(trap.uci);
		setStatus(`Played ${trap.san} — the trap line is on the board.`);
	}

	async function clearTrapCache() {
		await explorerCache.clear();
		state.trapResult = null;
		renderTrapResults(refs.trapResults, null);
		renderTrapStatus(refs.trapStatus, "Cached explorer data cleared. The next search will re-fetch it.", "info");
	}

	return {
		findTrapsFromBoard,
		cancelTrapSearch,
		clearTrapCache,
		syncTrapControls,
		readTrapControls,
		isSearching,
	};
}
