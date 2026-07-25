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
	clearSelection,
	render,
	renderBoard,
	renderPlayers,
	closeTreeAnnotationDialog,
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
				state.reviewAnimating = false;
				return;
			}

			setCurrentPlyOnActiveLine(state.currentPly + direction);
			render();
			await delay(REVIEW_PLAYBACK_DELAY_MS);
		}

		state.reviewAnimating = false;
		schedulePositionAnalysis(80);
	}

	async function goPrev() {
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

	function onGlobalKeyDown(event) {
		if (event.defaultPrevented) {
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

		if (event.key === "ArrowLeft") {
			event.preventDefault();
			goPrev();
			return;
		}

		if (event.key === "ArrowRight") {
			event.preventDefault();
			goNext();
		}
	}

	function seekToPly(ply) {
		const safePly = clamp(Number(ply) || 0, 0, state.lineMoves.length);
		state.reviewPlaybackToken += 1;
		state.reviewAnimating = false;
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
		state.mainlineScanToken += 1;
		state.scanInProgress = false;
		const currentNode = getTreeNode(state.currentNodeId);
		if (!currentNode) {
			return;
		}

		const beforeGame = new Chess(currentNode.fen);
		const moverColor = beforeGame.turn();
		const beforeFen = beforeGame.fen();
		const result = beforeGame.move(uciToMoveObject(uci));
		if (!result) {
			return;
		}

		const afterFen = beforeGame.fen();
		let nextNode = null;
		let nextClockWhite = currentNode.clockWhite || null;
		let nextClockBlack = currentNode.clockBlack || null;
		if (moverColor === "w") {
			nextClockWhite = null;
		} else {
			nextClockBlack = null;
		}
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

		queueMoveClassification({
			beforeFen,
			afterFen,
			playedMoveUci: uci,
			moverColor,
			gameBefore: new Chess(beforeFen),
			nodeId: nextNode.id,
		});

		schedulePositionAnalysis(80);
	}

	function onSquareClick(square) {
		const game = new Chess(state.timelineFens[clamp(state.currentPly, 0, Math.max(0, state.timelineFens.length - 1))]);
		const turn = game.turn();
		const piece = game.get(square);

		if (state.selectedSquare) {
			const legalMoves = legalMovesFromSquare(game, state.selectedSquare);
			const targetCandidates = legalMoves.filter((move) => move.to === square);
			if (targetCandidates.length > 0) {
				const preferred = targetCandidates.find((move) => move.promotion === "q") || targetCandidates[0];
				playMoveAtCurrentPly(preferred.uci);
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
		onGlobalKeyDown,
		seekToPly,
		legalMovesFromSquare,
		playMoveAtCurrentPly,
		onSquareClick,
		onFlipBoard,
	};
}
