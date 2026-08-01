import { terminalAnalysis } from "../../terminal-position.mjs";

// The engine client rejects superseded searches with a "Canceled by ..."
// message; those are expected control flow, not failures to report.
function isCancellation(error) {
	return /^Canceled\b/.test(String(error?.message || error || ""));
}

export function createAnalysisController({
	state,
	refs,
	engine,
	Chess,
	classifyMove,
	analyzeWithFallback,
	SCAN_PLAYBACK_DELAY_MS,
	clamp,
	delay,
	gameAtPly,
	cacheKeyFor,
	getCachedAnalysis,
	getTreeNode,
	setCurrentPlyOnActiveLine,
	syncLineFromTree,
	setStatus,
	debugLog,
	clearSelection,
	renderBoard,
	renderEvalBar,
	renderMoveTreePanel,
	render,
	updateClassificationView,
	updateEngineLinesView,
}) {
	function clearCaches() {
		state.positionCache.clear();
		for (const node of state.treeNodes.values()) {
			node.classification = null;
		}
		state.moveClassifications = state.activeLineNodeIds.slice(1).map(() => null);
		state.latestClassification = null;
		state.latestBestMove = null;
		state.latestBestMoveFen = null;
		state.reviewPlaybackToken += 1;
		state.reviewAnimating = false;
		cancelMainlineScan();
		setScanProgress(0, 0, "idle");
	}

	/**
	 * Stops an in-flight whole-game scan. Safe to call when nothing is running;
	 * callers are responsible for whatever navigation they do next.
	 */
	function cancelMainlineScan() {
		const wasRunning = state.scanInProgress;
		state.mainlineScanToken += 1;
		state.scanInProgress = false;
		return wasRunning;
	}

	function setScanProgress(done, total, phase) {
		state.scanProgress.done = done;
		state.scanProgress.total = total;
		state.scanProgress.phase = phase;

		if (!refs.scanProgressWrap || !refs.scanProgressBar || !refs.scanProgressLabel) {
			return;
		}

		// The widget doubles as the timeline scrubber, so it stays visible as
		// soon as there is a game to scrub through.
		const hasGame = state.lineMoves.length > 0;
		refs.scanProgressWrap.classList.toggle("hidden", phase === "idle" && !hasGame);
		refs.scanProgressWrap.classList.toggle("loading", phase === "running" && total > 0);

		if (phase !== "idle" && total > 0) {
			const percent = Math.round((Math.max(0, done) / Math.max(1, total)) * 100);
			refs.scanProgressBar.style.width = `${percent}%`;
			refs.scanProgressLabel.textContent = phase === "running"
				? `Classifying moves: ${Math.max(0, done)}/${total} (${percent}%)`
				: phase === "done"
					? "Analysis complete"
					: phase === "failed"
						? "Analysis failed"
						: phase === "canceled"
							? "Analysis canceled"
							: refs.scanProgressLabel.textContent;
			if (refs.scrubberLabel && phase === "running") {
				refs.scrubberLabel.textContent = `Loading ${percent}%`;
			}
		} else if (phase === "idle") {
			refs.scanProgressBar.style.width = "0%";
			refs.scanProgressLabel.textContent = "";
		}
	}

	/**
	 * Single entry point for every engine call: finished positions are decided
	 * by the rules and never reach the worker.
	 */
	async function analyzePosition({ fen, depth, multiPV, phase }) {
		const terminal = terminalAnalysis(fen, Chess);
		if (terminal) {
			debugLog("Terminal position, skipping engine", { fen, phase, terminal: terminal.terminal });
			return { result: terminal, usedProfile: { depth, multiPV }, attempt: 0 };
		}

		return analyzeWithFallback({
			engine,
			fen,
			depth,
			multiPV,
			phase,
			logger: debugLog,
		});
	}

	function schedulePositionAnalysis(delayMs = 80) {
		if (state.analysisDebounceHandle) {
			clearTimeout(state.analysisDebounceHandle);
		}

		state.analysisDebounceHandle = setTimeout(() => {
			state.analysisDebounceHandle = null;
			analyzeCurrentPosition().catch((error) => {
				debugLog("Scheduled position analysis failed", String(error?.message || error));
			});
		}, delayMs);
	}

	function paintAnalysis(analysis, suffix) {
		state.latestBestMove = analysis.bestMove;
		state.latestBestMoveFen = analysis.fen;
		updateEngineLinesView(analysis);
		renderBoard();
		renderEvalBar();

		if (analysis.terminal) {
			setStatus(`Game over — ${analysis.terminal}`);
			return;
		}

		const turnLabel = analysis.sideToMove === "w" ? "White" : "Black";
		setStatus(
			`${turnLabel} to move · ${analysis.evalText} · White scores ${analysis.winPercentWhite.toFixed(0)}% · depth ${analysis.depthReached}${suffix}`,
		);
	}

	async function analyzeCurrentPosition() {
		// The scan and the move classifier drive the engine themselves and both
		// re-schedule a position analysis when they finish. Racing them here
		// only cancels their searches.
		if (state.scanInProgress || state.isClassifying) {
			return;
		}

		const game = gameAtPly(state.currentPly);
		const fen = game.fen();
		const cacheKey = cacheKeyFor(fen, state.settings.depth, state.settings.multiPV);
		const cached = getCachedAnalysis(fen, state.settings.depth, state.settings.multiPV, true);

		if (cached?.mode === "exact") {
			paintAnalysis(cached.analysis, " · cached");
			return;
		}

		if (cached?.analysis) {
			// A weaker cached result (lower depth, or the single-PV result the
			// classifier stored) is a useful placeholder, but it must not stop
			// the full-strength analysis from running.
			paintAnalysis(cached.analysis, " · cached");
		} else {
			setStatus("Analyzing current position...");
		}

		debugLog("Position analysis requested", { fen, ply: state.currentPly });

		const token = ++state.latestPositionAnalysisToken;
		try {
			const { result: analysis, usedProfile } = await analyzePosition({
				fen,
				depth: state.settings.depth,
				multiPV: state.settings.multiPV,
				phase: "position",
			});

			if (token !== state.latestPositionAnalysisToken) {
				return;
			}

			state.positionCache.set(cacheKey, analysis);
			if (usedProfile.depth !== state.settings.depth || usedProfile.multiPV !== state.settings.multiPV) {
				state.positionCache.set(cacheKeyFor(fen, usedProfile.depth, usedProfile.multiPV), analysis);
			}

			const fallbackSuffix =
				usedProfile.depth !== state.settings.depth || usedProfile.multiPV !== state.settings.multiPV
					? ` · reduced to depth ${usedProfile.depth}`
					: "";
			paintAnalysis(analysis, fallbackSuffix);
		} catch (error) {
			if (isCancellation(error)) {
				return;
			}
			debugLog("Position analysis failed", error);
			setStatus(`Analysis error: ${error?.message || error}`);
		}
	}

	/**
	 * The whole-game review does not need the depth the user picked for the
	 * single position they are staring at. Classification only has to sort each
	 * move into one of seven expected-point buckets, and at the shipped
	 * single-threaded engine the interactive profile costs roughly six times as
	 * much per position as a review profile that lands in the same buckets.
	 *
	 * Two candidate lines are enough to spot an only-move; the third is needed
	 * solely to confirm a Great or Brilliant, which is rare enough to fetch on
	 * demand. See `confirmStandoutMove`.
	 */
	function getScanProfile() {
		return {
			depth: Math.min(state.settings.reviewDepth, state.settings.depth),
			multiPV: Math.min(2, state.settings.multiPV),
		};
	}

	/** Profile used for a single position the user is looking at. */
	function getPositionProfile() {
		return {
			depth: state.settings.depth,
			multiPV: state.settings.multiPV,
		};
	}

	const STANDOUT_LABELS = new Set(["Great", "Brilliant"]);

	/**
	 * `Great` and `Brilliant` both require every alternative to be clearly worse,
	 * which the classifier checks against the second *and* third engine lines.
	 * The review runs on two lines, so a standout label is re-checked against a
	 * three-line search before it is kept. Only a handful of moves per game get
	 * this far, so it costs far less than reviewing everything on three lines.
	 */
	async function confirmStandoutMove({ classification, beforeFen, afterAnalysis, playedMoveUci, moverColor, gameBefore, afterFen, depth, ply }) {
		if (!STANDOUT_LABELS.has(classification.label) || state.settings.multiPV < 3) {
			return classification;
		}

		const key = cacheKeyFor(beforeFen, depth, 3);
		let beforeAnalysis = state.positionCache.get(key);
		if (!beforeAnalysis) {
			const { result } = await analyzePosition({ fen: beforeFen, depth, multiPV: 3, phase: `scan-confirm-${ply}` });
			beforeAnalysis = result;
			state.positionCache.set(key, beforeAnalysis);
		}

		debugLog("Confirming standout move on three lines", { ply, label: classification.label });
		return classifyMove({
			beforeAnalysis,
			afterAnalysis,
			playedMoveUci,
			moverColor,
			playerElo: state.settings.playerElo,
			gameBefore,
			afterFen,
		});
	}

	async function queueMoveClassification({ beforeFen, afterFen, playedMoveUci, moverColor, gameBefore, nodeId }) {
		const token = ++state.latestMoveAnalysisToken;
		state.isClassifying = true;
		state.latestPositionAnalysisToken += 1;
		// A move the user just played is a single position, so it is worth the
		// full interactive profile rather than the cheaper review one.
		const { depth, multiPV } = getPositionProfile();

		try {
			setStatus("Classifying played move...");
			debugLog("Move classification start", { token, playedMoveUci, beforeFen, afterFen });

			const { result: beforeAnalysis } = await analyzePosition({
				fen: beforeFen,
				depth,
				multiPV,
				phase: "classify-before",
			});

			if (token !== state.latestMoveAnalysisToken) {
				return;
			}

			const { result: afterAnalysis } = await analyzePosition({
				fen: afterFen,
				depth,
				multiPV: 1,
				phase: "classify-after",
			});

			if (token !== state.latestMoveAnalysisToken) {
				return;
			}

			state.positionCache.set(cacheKeyFor(beforeFen, depth, multiPV), beforeAnalysis);
			state.positionCache.set(cacheKeyFor(afterFen, depth, 1), afterAnalysis);

			const classification = classifyMove({
				beforeAnalysis,
				afterAnalysis,
				playedMoveUci,
				moverColor,
				playerElo: state.settings.playerElo,
				gameBefore,
				afterFen,
			});
			state.latestClassification = classification;

			const moveNode = nodeId ? getTreeNode(nodeId) : null;
			if (moveNode) {
				moveNode.classification = classification;
				syncLineFromTree();
			}

			updateClassificationView(classification);
			renderMoveTreePanel();
			renderBoard();
			setStatus(
				`Last move ${playedMoveUci}: ${classification.label} (EP loss ${(classification.epLoss * 100).toFixed(1)}%).`,
			);
		} catch (error) {
			if (isCancellation(error)) {
				return;
			}
			debugLog("Move classification failed", error);
			setStatus(`Classification error: ${error?.message || error}`);
		} finally {
			if (token === state.latestMoveAnalysisToken) {
				state.isClassifying = false;
				schedulePositionAnalysis(80);
			}
		}
	}

	async function scanMainlineClassifications() {
		const myToken = ++state.mainlineScanToken;
		if (state.lineMoves.length === 0) {
			return;
		}

		state.scanInProgress = true;
		const originalPly = state.currentPly;
		const total = state.lineMoves.length;
		const scanNodeIds = state.activeLineNodeIds.slice();
		const { depth: scanDepth, multiPV: scanMultiPV } = getScanProfile();
		let done = 0;
		let previousAfterFen = null;
		let previousAfterAnalysis = null;
		setScanProgress(done, total, "running");
		clearSelection();

		debugLog("Mainline scan started", { plies: state.lineMoves.length, scanDepth, scanMultiPV });

		const isCanceled = () => myToken !== state.mainlineScanToken;
		const finishCanceled = (ply) => {
			debugLog("Mainline scan canceled", { ply });
			// Only report the cancellation if no newer scan has already taken over.
			if (!state.scanInProgress) {
				setScanProgress(done, total, "canceled");
			}
		};

		for (let ply = 1; ply <= state.lineMoves.length; ply += 1) {
			if (isCanceled()) {
				finishCanceled(ply);
				return;
			}

			const scanNodeId = scanNodeIds[ply];
			const scanNode = scanNodeId ? getTreeNode(scanNodeId) : null;
			if (scanNode?.classification) {
				// Already scored: step the board forward without paying for a search.
				setCurrentPlyOnActiveLine(ply);
				renderBoard();
				renderEvalBar();
				renderMoveTreePanel();
				state.moveClassifications[ply - 1] = scanNode.classification;
				done += 1;
				setScanProgress(done, total, "running");
				continue;
			}

			const beforeFen = state.timelineFens[ply - 1];
			const afterFen = state.timelineFens[ply];
			const playedMoveUci = state.lineMoves[ply - 1];
			if (!beforeFen || !afterFen || !playedMoveUci) {
				debugLog("Mainline scan skipped incomplete ply", { ply });
				continue;
			}

			const gameBefore = new Chess(beforeFen);
			const moverColor = gameBefore.turn();

			try {
				// Each ply's "after" position is the next ply's "before", so the
				// review costs one search per ply rather than two.
				let beforeAnalysis = null;
				if (previousAfterAnalysis && previousAfterFen === beforeFen) {
					beforeAnalysis = previousAfterAnalysis;
				} else {
					const beforeCached = state.positionCache.get(cacheKeyFor(beforeFen, scanDepth, scanMultiPV));
					if (beforeCached) {
						beforeAnalysis = beforeCached;
					} else {
						const beforeResult = await analyzePosition({
							fen: beforeFen,
							depth: scanDepth,
							multiPV: scanMultiPV,
							phase: `scan-before-${ply}`,
						});
						beforeAnalysis = beforeResult.result;
						state.positionCache.set(cacheKeyFor(beforeFen, scanDepth, scanMultiPV), beforeAnalysis);
					}
				}

				if (isCanceled()) {
					finishCanceled(ply);
					return;
				}

				// Start the search first, then play the move on the board. The
				// playback beat runs while the engine works instead of after it.
				const afterSearch = analyzePosition({
					fen: afterFen,
					depth: scanDepth,
					multiPV: scanMultiPV,
					phase: `scan-after-${ply}`,
				});

				setCurrentPlyOnActiveLine(ply);
				renderBoard();
				renderEvalBar();
				renderMoveTreePanel();
				setStatus(`Reviewing move ${ply} of ${total}...`);

				const [{ result: afterAnalysis }] = await Promise.all([
					afterSearch,
					delay(SCAN_PLAYBACK_DELAY_MS),
				]);

				if (isCanceled()) {
					finishCanceled(ply);
					return;
				}

				state.positionCache.set(cacheKeyFor(afterFen, scanDepth, scanMultiPV), afterAnalysis);
				previousAfterFen = afterFen;
				previousAfterAnalysis = afterAnalysis;

				const classification = await confirmStandoutMove({
					classification: classifyMove({
						beforeAnalysis,
						afterAnalysis,
						playedMoveUci,
						moverColor,
						playerElo: state.settings.playerElo,
						gameBefore,
						afterFen,
					}),
					beforeFen,
					afterAnalysis,
					playedMoveUci,
					moverColor,
					gameBefore,
					afterFen,
					depth: scanDepth,
					ply,
				});

				if (isCanceled()) {
					finishCanceled(ply);
					return;
				}

				if (scanNode) {
					scanNode.classification = classification;
				}
				state.moveClassifications[ply - 1] = classification;

				if (originalPly === ply) {
					updateClassificationView(classification);
				}

				done += 1;
				setScanProgress(done, total, "running");
			} catch (error) {
				if (isCanceled() || isCancellation(error)) {
					finishCanceled(ply);
					return;
				}

				debugLog("Mainline scan failed", { ply, error: String(error?.message || error) });
				setStatus(`Mainline scan stopped at ply ${ply}: ${error?.message || error}`);
				state.scanInProgress = false;
				setScanProgress(done, total, "failed");
				syncLineFromTree();
				setCurrentPlyOnActiveLine(originalPly);
				render();
				schedulePositionAnalysis(80);
				return;
			}
		}

		if (isCanceled()) {
			finishCanceled(state.lineMoves.length);
			return;
		}

		debugLog("Mainline scan complete", { plies: state.lineMoves.length });
		state.scanInProgress = false;
		setScanProgress(total, total, "done");
		syncLineFromTree();
		setCurrentPlyOnActiveLine(originalPly);
		render();
		schedulePositionAnalysis(80);
	}

	return {
		clearCaches,
		cancelMainlineScan,
		setScanProgress,
		schedulePositionAnalysis,
		analyzeCurrentPosition,
		getScanProfile,
		queueMoveClassification,
		scanMainlineClassifications,
	};
}
