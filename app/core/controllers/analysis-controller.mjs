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
	updateMoveList,
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
		state.reviewPlaybackToken += 1;
		state.reviewAnimating = false;
		state.mainlineScanToken += 1;
		setScanProgress(0, 0, "idle");
	}

	function setScanProgress(done, total, phase) {
		state.scanProgress.done = done;
		state.scanProgress.total = total;
		state.scanProgress.phase = phase;

		if (!refs.scanProgressWrap || !refs.scanProgressBar || !refs.scanProgressLabel) {
			return;
		}

		refs.scanProgressWrap.classList.remove("hidden");
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
			if (refs.scrubberLabel) {
				refs.scrubberLabel.textContent = `Loading ${percent}%`;
			}
		} else if (phase === "idle") {
			refs.scanProgressBar.style.width = "0%";
			refs.scanProgressLabel.textContent = "";
		}
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

	async function analyzeCurrentPosition() {
		const game = gameAtPly(state.currentPly);
		const fen = game.fen();
		const cacheKey = cacheKeyFor(fen, state.settings.depth, state.settings.multiPV);
		const cachedExact = getCachedAnalysis(fen, state.settings.depth, state.settings.multiPV, false);
		const cachedApprox = getCachedAnalysis(fen, state.settings.depth, state.settings.multiPV, true);

		if (cachedExact?.analysis) {
			const { analysis } = cachedExact;
			state.latestBestMove = analysis.bestMove;
			updateEngineLinesView(analysis);
			renderBoard();
			renderEvalBar();
			const turnLabel = analysis.sideToMove === "w" ? "White" : "Black";
			setStatus(
				`${turnLabel} to move | eval ${analysis.evalText} | white win ${analysis.winPercentWhite.toFixed(1)}% | depth ${analysis.depthReached} | nps ${analysis.nps || 0} | cached`,
			);
			return;
		}

		if (cachedApprox?.analysis) {
			const { analysis } = cachedApprox;
			state.latestBestMove = analysis.bestMove;
			updateEngineLinesView(analysis);
			renderBoard();
			renderEvalBar();
		}

		setStatus("Analyzing current position...");
		debugLog("Position analysis requested", { fen, ply: state.currentPly });

		const token = ++state.latestPositionAnalysisToken;
		try {
			const { result: analysis, usedProfile } = await analyzeWithFallback({
				engine,
				fen,
				depth: state.settings.depth,
				multiPV: state.settings.multiPV,
				phase: "position",
				logger: debugLog,
			});

			if (token !== state.latestPositionAnalysisToken) {
				return;
			}

			state.positionCache.set(cacheKey, analysis);
			state.latestBestMove = analysis.bestMove;
			updateEngineLinesView(analysis);
			renderBoard();
			renderEvalBar();

			const turnLabel = analysis.sideToMove === "w" ? "White" : "Black";
			const fallbackSuffix =
				usedProfile.depth !== state.settings.depth || usedProfile.multiPV !== state.settings.multiPV
					? ` | fallback d${usedProfile.depth}/pv${usedProfile.multiPV}`
					: "";
			setStatus(
				`${turnLabel} to move | eval ${analysis.evalText} | white win ${analysis.winPercentWhite.toFixed(1)}% | depth ${analysis.depthReached} | nps ${analysis.nps || 0}${fallbackSuffix}`,
			);
		} catch (error) {
			if (String(error?.message || "") === "Canceled by newer request.") {
				return;
			}
			debugLog("Position analysis failed", error);
			setStatus(`Analysis error: ${error?.message || error}`);
		}
	}

	function getScanProfile() {
		return {
			depth: state.settings.depth,
			multiPV: state.settings.multiPV,
		};
	}

	async function queueMoveClassification({ beforeFen, afterFen, playedMoveUci, moverColor, gameBefore, nodeId }) {
		const token = ++state.latestMoveAnalysisToken;
		state.isClassifying = true;
		state.latestPositionAnalysisToken += 1;

		try {
			setStatus("Classifying played move...");
			debugLog("Move classification start", { token, playedMoveUci, beforeFen, afterFen });

			const { result: beforeAnalysis } = await analyzeWithFallback({
				engine,
				fen: beforeFen,
				depth: state.settings.depth,
				multiPV: state.settings.multiPV,
				phase: "classify-before",
				logger: debugLog,
			});
			const { result: afterAnalysis } = await analyzeWithFallback({
				engine,
				fen: afterFen,
				depth: state.settings.depth,
				multiPV: 1,
				phase: "classify-after",
				logger: debugLog,
			});

			if (token !== state.latestMoveAnalysisToken) {
				return;
			}

			state.positionCache.set(`${beforeFen}|d${state.settings.depth}|pv${state.settings.multiPV}`, beforeAnalysis);
			state.positionCache.set(`${afterFen}|d${state.settings.depth}|pv1`, afterAnalysis);

			state.latestClassification = classifyMove({
				beforeAnalysis,
				afterAnalysis,
				playedMoveUci,
				moverColor,
				playerElo: state.settings.playerElo,
				gameBefore,
				afterFen,
			});

			const moveNode = nodeId ? getTreeNode(nodeId) : null;
			if (moveNode) {
				moveNode.classification = state.latestClassification;
				syncLineFromTree();
			}

			updateClassificationView(state.latestClassification);
			setStatus(
				`Last move ${playedMoveUci}: ${state.latestClassification.label} (EP loss ${(state.latestClassification.epLoss * 100).toFixed(1)}%).`,
			);
		} catch (error) {
			if (String(error?.message || "") === "Canceled by newer request.") {
				return;
			}
			debugLog("Move classification failed", error);
			setStatus(`Classification error: ${error?.message || error}`);
		} finally {
			state.isClassifying = false;
			schedulePositionAnalysis(80);
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
		const { depth: scanDepth, multiPV: scanMultiPV } = getScanProfile();
		let done = 0;
		let previousAfterFen = null;
		let previousAfterAnalysis = null;
		setScanProgress(done, total, "running");
		clearSelection();

		debugLog("Mainline scan started", { plies: state.lineMoves.length, scanDepth, scanMultiPV });

		for (let ply = 1; ply <= state.lineMoves.length; ply += 1) {
			if (myToken !== state.mainlineScanToken) {
				debugLog("Mainline scan canceled", { ply });
				state.scanInProgress = false;
				setScanProgress(done, total, "canceled");
				return;
			}

			setCurrentPlyOnActiveLine(ply);
			renderBoard();
			updateMoveList();
			renderMoveTreePanel();
			setStatus(`Analyzing move ${ply}/${total}...`);
			await delay(SCAN_PLAYBACK_DELAY_MS);

			if (myToken !== state.mainlineScanToken) {
				debugLog("Mainline scan canceled during playback", { ply });
				state.scanInProgress = false;
				setScanProgress(done, total, "canceled");
				return;
			}

			const scanNodeId = state.activeLineNodeIds[ply];
			const scanNode = scanNodeId ? getTreeNode(scanNodeId) : null;
			if (scanNode?.classification) {
				done += 1;
				setScanProgress(done, total, "running");
				continue;
			}

			const beforeFen = state.timelineFens[ply - 1];
			const afterFen = state.timelineFens[ply];
			const playedMoveUci = state.lineMoves[ply - 1];
			const gameBefore = new Chess(beforeFen);
			const moverColor = gameBefore.turn();

			try {
				let beforeAnalysis = null;
				if (previousAfterAnalysis && previousAfterFen === beforeFen) {
					beforeAnalysis = previousAfterAnalysis;
				} else {
					const beforeCached = state.positionCache.get(`${beforeFen}|d${scanDepth}|pv${scanMultiPV}`);
					if (beforeCached) {
						beforeAnalysis = beforeCached;
					} else {
						const beforeResult = await analyzeWithFallback({
							engine,
							fen: beforeFen,
							depth: scanDepth,
							multiPV: scanMultiPV,
							phase: `scan-before-${ply}`,
							logger: debugLog,
						});
						beforeAnalysis = beforeResult.result;
						state.positionCache.set(`${beforeFen}|d${scanDepth}|pv${scanMultiPV}`, beforeAnalysis);
					}
				}

				const { result: afterAnalysis } = await analyzeWithFallback({
					engine,
					fen: afterFen,
					depth: scanDepth,
					multiPV: scanMultiPV,
					phase: `scan-after-${ply}`,
					logger: debugLog,
				});

				state.positionCache.set(`${afterFen}|d${scanDepth}|pv${scanMultiPV}`, afterAnalysis);
				previousAfterFen = afterFen;
				previousAfterAnalysis = afterAnalysis;

				const classification = classifyMove({
					beforeAnalysis,
					afterAnalysis,
					playedMoveUci,
					moverColor,
					playerElo: state.settings.playerElo,
					gameBefore,
					afterFen,
				});
				if (scanNode) {
					scanNode.classification = classification;
					syncLineFromTree();
				}

				if (state.currentPly === ply) {
					updateClassificationView(classification);
				}

				done += 1;
				setScanProgress(done, total, "running");
			} catch (error) {
				debugLog("Mainline scan failed", { ply, error: String(error?.message || error) });
				setStatus(`Mainline scan stopped at ply ${ply}: ${error?.message || error}`);
				state.scanInProgress = false;
				setScanProgress(done, total, "failed");
				setCurrentPlyOnActiveLine(originalPly);
				render();
				schedulePositionAnalysis(80);
				return;
			}
		}

		if (myToken === state.mainlineScanToken) {
			debugLog("Mainline scan complete", { plies: state.lineMoves.length });
			state.scanInProgress = false;
			setScanProgress(total, total, "done");
			setCurrentPlyOnActiveLine(originalPly);
			render();
			schedulePositionAnalysis(80);
		}
	}

	return {
		clearCaches,
		setScanProgress,
		schedulePositionAnalysis,
		analyzeCurrentPosition,
		getScanProfile,
		queueMoveClassification,
		scanMainlineClassifications,
	};
}
