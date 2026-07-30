export function createGameplayController({
	state,
	Chess,
	REVIEW_PLAYBACK_DELAY_MS,
	clamp,
	delay,
	getTreeNode,
	setCurrentNode,
	setCurrentPlyOnActiveLine,
	syncLineFromTree,
	createTreeNode,
	uciToMoveObject,
	verboseMoveToUci,
	isReviewSkipLabel,
	queueMoveClassification,
	schedulePositionAnalysis,
	cancelMainlineScan,
	clearSelection,
	render,
	renderBoard,
	renderPlayers,
	closeTreeAnnotationDialog,
	requestPromotionChoice,
	setStatus,
	debugLog,
}) {
	function isBottomBoardMove(ply) {
		if (ply < 1 || ply > state.lineMoves.length) {
			return false;
		}

		const beforeFen = state.timelineFens[ply - 1];
		if (!beforeFen) {
			return false;
		}

		const moverColor = new Chess(beforeFen).turn();
		const bottomColor = state.orientation === "white" ? "w" : "b";
		return moverColor === bottomColor;
	}

	function reviewStopPly(direction) {
		if (direction > 0) {
			for (let ply = state.currentPly + 1; ply <= state.lineMoves.length; ply += 1) {
				if (!isBottomBoardMove(ply)) {
					continue;
				}
				const classification = state.moveClassifications[ply - 1];
				if (!classification) {
					return ply;
				}
				if (!isReviewSkipLabel(classification.label)) {
					return ply;
				}
			}
			return state.lineMoves.length;
		}

		for (let ply = state.currentPly - 1; ply >= 1; ply -= 1) {
			if (!isBottomBoardMove(ply)) {
				continue;
			}
			const classification = state.moveClassifications[ply - 1];
			if (!classification) {
				return ply;
			}
			if (!isReviewSkipLabel(classification.label)) {
				return ply;
			}
		}

		return 0;
	}

	async function animateToPly(targetPly) {
		const clampedTarget = clamp(targetPly, 0, state.lineMoves.length);
		if (clampedTarget === state.currentPly) {
			render();
			schedulePositionAnalysis(80);
			return;
		}

		const token = ++state.reviewPlaybackToken;
		state.reviewAnimating = true;
		clearSelection();

		const direction = clampedTarget > state.currentPly ? 1 : -1;
		while (state.currentPly !== clampedTarget) {
			if (token !== state.reviewPlaybackToken) {
				return;
			}

			setCurrentPlyOnActiveLine(state.currentPly + direction);
			render();
			await delay(REVIEW_PLAYBACK_DELAY_MS);
		}

		if (token !== state.reviewPlaybackToken) {
			return;
		}

		state.reviewAnimating = false;
		render();
		schedulePositionAnalysis(80);
	}

	/**
	 * Every user-driven navigation takes the board away from the whole-game
	 * scan, which walks `currentPly` on its own. Leaving the scan running would
	 * make it fight the user for the board.
	 */
	function takeOverFromScan() {
		return cancelMainlineScan();
	}

	async function goPrev() {
		takeOverFromScan();
		if (state.reviewAnimating) {
			return;
		}

		if (state.settings.reviewMode) {
			const targetPly = reviewStopPly(-1);
			await animateToPly(targetPly);
			return;
		}

		const current = getTreeNode(state.currentNodeId);
		if (!current || !current.parentId) {
			return;
		}
		setCurrentNode(current.parentId);
		clearSelection();
		render();
		schedulePositionAnalysis(80);
	}

	async function goNext() {
		takeOverFromScan();
		if (state.reviewAnimating) {
			return;
		}

		if (state.settings.reviewMode) {
			const targetPly = reviewStopPly(1);
			await animateToPly(targetPly);
			return;
		}

		const current = getTreeNode(state.currentNodeId);
		if (!current) {
			return;
		}
		const nextId = current.preferredChildId || current.children[0];
		if (!nextId) {
			return;
		}
		setCurrentNode(nextId);
		clearSelection();
		render();
		schedulePositionAnalysis(80);
	}

	function goToStart() {
		seekToPly(0);
	}

	function goToEnd() {
		seekToPly(state.lineMoves.length);
	}

	function onGlobalKeyDown(event) {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}

		if (event.key === "Escape" && state.annotationDialogNodeId) {
			event.preventDefault();
			closeTreeAnnotationDialog();
			return;
		}

		const target = event.target;
		if (target instanceof HTMLElement) {
			const tag = target.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
				return;
			}
		}

		switch (event.key) {
			case "ArrowLeft":
				event.preventDefault();
				goPrev();
				return;
			case "ArrowRight":
				event.preventDefault();
				goNext();
				return;
			case "Home":
				event.preventDefault();
				goToStart();
				return;
			case "End":
				event.preventDefault();
				goToEnd();
				return;
			case "Escape":
				if (state.selectedSquare) {
					event.preventDefault();
					clearSelection();
					renderBoard();
				}
				return;
			case "f":
			case "F":
				event.preventDefault();
				onFlipBoard();
				return;
			default:
		}
	}

	function seekToPly(ply) {
		takeOverFromScan();
		state.reviewPlaybackToken += 1;
		state.reviewAnimating = false;
		const safePly = clamp(Number(ply) || 0, 0, state.lineMoves.length);
		setCurrentPlyOnActiveLine(safePly);
		clearSelection();
		render();
		schedulePositionAnalysis(80);
	}

	function legalMovesFromSquare(game, square) {
		return game
			.moves({ square, verbose: true })
			.map((move) => ({
				uci: verboseMoveToUci(move),
				to: move.to,
				promotion: move.promotion || null,
			}));
	}

	async function playMoveAtCurrentPly(uci) {
		takeOverFromScan();
		state.reviewPlaybackToken += 1;
		state.reviewAnimating = false;

		const currentNode = getTreeNode(state.currentNodeId);
		if (!currentNode) {
			return;
		}

		const beforeGame = new Chess(currentNode.fen);
		const moverColor = beforeGame.turn();
		const beforeFen = beforeGame.fen();

		// chess.js throws on an illegal move rather than returning null.
		let moveSan = uci;
		try {
			const applied = beforeGame.move(uciToMoveObject(uci));
			if (!applied) {
				return;
			}
			moveSan = applied.san || uci;
		} catch (error) {
			debugLog("Rejected illegal move", { uci, beforeFen, error: String(error?.message || error) });
			setStatus(`Illegal move: ${uci}`);
			clearSelection();
			renderBoard();
			return;
		}

		const afterFen = beforeGame.fen();
		let nextNode = null;
		// The mover's own clock is unknown for a move that was never played in
		// the source game; the opponent's stays as it was.
		const nextClockWhite = moverColor === "w" ? null : currentNode.clockWhite || null;
		const nextClockBlack = moverColor === "b" ? null : currentNode.clockBlack || null;

		for (const childId of currentNode.children) {
			const child = getTreeNode(childId);
			if (child && child.moveUci === uci && child.fen === afterFen) {
				nextNode = child;
				break;
			}
		}

		if (!nextNode) {
			const nodeId = state.nextTreeNodeId;
			state.nextTreeNodeId += 1;
			nextNode = createTreeNode({
				id: nodeId,
				fen: afterFen,
				moveUci: uci,
				moveSan,
				parentId: currentNode.id,
				clockWhite: nextClockWhite,
				clockBlack: nextClockBlack,
			});
			state.treeNodes.set(nodeId, nextNode);
			currentNode.children.push(nodeId);
		}

		currentNode.preferredChildId = nextNode.id;
		state.currentNodeId = nextNode.id;
		syncLineFromTree();
		clearSelection();
		render();

		// `queueMoveClassification` re-schedules the position analysis when it
		// settles. Scheduling one here as well would cancel its engine search
		// before the move could ever be classified.
		await queueMoveClassification({
			beforeFen,
			afterFen,
			playedMoveUci: uci,
			moverColor,
			gameBefore: new Chess(beforeFen),
			nodeId: nextNode.id,
		});
	}

	async function onSquareClick(square) {
		// Freeze the scan on the very first click: otherwise the piece the user
		// aimed at has already moved on by the time they pick a target.
		takeOverFromScan();

		const game = gameAtCurrentPly();
		const turn = game.turn();
		const piece = game.get(square);

		if (state.selectedSquare) {
			if (state.selectedSquare === square) {
				clearSelection();
				renderBoard();
				return;
			}

			const legalMoves = legalMovesFromSquare(game, state.selectedSquare);
			const targetCandidates = legalMoves.filter((move) => move.to === square);
			if (targetCandidates.length > 0) {
				const chosen = await choosePromotionMove(targetCandidates, turn);
				if (!chosen) {
					return;
				}
				await playMoveAtCurrentPly(chosen.uci);
				return;
			}
		}

		if (piece && piece.color === turn) {
			state.selectedSquare = square;
			state.legalTargets = legalMovesFromSquare(game, square).map((move) => move.to);
		} else {
			clearSelection();
		}

		renderBoard();
	}

	function gameAtCurrentPly() {
		const safePly = clamp(state.currentPly, 0, Math.max(0, state.timelineFens.length - 1));
		return new Chess(state.timelineFens[safePly]);
	}

	async function choosePromotionMove(candidates, moverColor) {
		const promotions = candidates.filter((move) => move.promotion);
		if (promotions.length <= 1) {
			return candidates[0];
		}

		if (typeof requestPromotionChoice !== "function") {
			return promotions.find((move) => move.promotion === "q") || promotions[0];
		}

		const piece = await requestPromotionChoice(moverColor);
		if (!piece) {
			return null;
		}

		return promotions.find((move) => move.promotion === piece) || promotions[0];
	}

	function onFlipBoard() {
		state.orientation = state.orientation === "white" ? "black" : "white";
		renderBoard();
		renderPlayers();
	}

	return {
		isBottomBoardMove,
		reviewStopPly,
		animateToPly,
		goPrev,
		goNext,
		goToStart,
		goToEnd,
		onGlobalKeyDown,
		seekToPly,
		legalMovesFromSquare,
		playMoveAtCurrentPly,
		onSquareClick,
		onFlipBoard,
	};
}
