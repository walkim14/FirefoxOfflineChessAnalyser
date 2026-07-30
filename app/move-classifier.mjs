import { lookupBookMove, lookupBookPosition } from "./opening-book.mjs";

const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

const THRESHOLDS = [
  { label: "Best", maxLoss: 0.0 },
  { label: "Excellent", maxLoss: 0.02 },
  { label: "Good", maxLoss: 0.05 },
  { label: "Inaccuracy", maxLoss: 0.1 },
  { label: "Mistake", maxLoss: 0.2 },
  { label: "Blunder", maxLoss: 1.0 },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function expectedWhitePercent(cpWhite) {
  const value = 50 + 50 * ((2 / (1 + Math.exp(-0.00368208 * cpWhite))) - 1);
  return clamp(value, 0, 100);
}

function expectedScoreForMover(cpWhite, moverColor) {
  const whiteWinProb = expectedWhitePercent(cpWhite) / 100;
  return moverColor === "w" ? whiteWinProb : 1 - whiteWinProb;
}

function cpForMover(cpWhite, moverColor) {
  return moverColor === "w" ? cpWhite : -cpWhite;
}

function classifyByExpectedLoss(epLoss, isBestMove) {
  if (isBestMove && epLoss <= 0.005) {
    return "Best";
  }

  for (const threshold of THRESHOLDS) {
    if (epLoss <= threshold.maxLoss) {
      return threshold.label;
    }
  }

  return "Blunder";
}

function moveFromUci(uci) {
  if (!uci || uci.length < 4) {
    return null;
  }

  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
  };
}

const NOT_A_SACRIFICE = { isSacrifice: false, minNetLoss: 0 };

function looksLikeSacrifice({ gameBefore, playedMoveUci, playerElo }) {
  const move = moveFromUci(playedMoveUci);
  if (!move) {
    return NOT_A_SACRIFICE;
  }

  const boardBefore = gameBefore.board();
  const movingPieceSquare = findSquare(boardBefore, move.from);
  if (!movingPieceSquare || movingPieceSquare.color !== gameBefore.turn()) {
    return NOT_A_SACRIFICE;
  }

  const pieceValue = PIECE_VALUES[movingPieceSquare.type] || 0;
  const minPieceValue = playerElo < 1200 ? 2 : 3;
  if (pieceValue < minPieceValue) {
    return NOT_A_SACRIFICE;
  }

  const gameAfter = new gameBefore.constructor(gameBefore.fen());
  let applied = null;
  try {
    // chess.js throws instead of returning null for a move it rejects.
    applied = gameAfter.move(move);
  } catch {
    return NOT_A_SACRIFICE;
  }
  if (!applied || applied.captured) {
    return NOT_A_SACRIFICE;
  }

  const replies = gameAfter.moves({ verbose: true });
  const immediateCaptures = replies.filter((reply) => reply.to === move.to && Boolean(reply.captured));
  if (immediateCaptures.length === 0) {
    return NOT_A_SACRIFICE;
  }

  let minNetLoss = Number.POSITIVE_INFINITY;
  for (const reply of immediateCaptures) {
    const afterCapture = new gameAfter.constructor(gameAfter.fen());
    let captureApplied = null;
    try {
      captureApplied = afterCapture.move(reply);
    } catch {
      continue;
    }
    if (!captureApplied) {
      continue;
    }

    const recaptures = afterCapture
      .moves({ verbose: true })
      .filter((next) => next.to === move.to && Boolean(next.captured));
    const bestRecaptureValue = recaptures.reduce((best, next) => {
      const value = PIECE_VALUES[next.captured] || 0;
      return Math.max(best, value);
    }, 0);

    const netLoss = pieceValue - bestRecaptureValue;
    if (netLoss < minNetLoss) {
      minNetLoss = netLoss;
    }
  }

  if (!Number.isFinite(minNetLoss)) {
    return NOT_A_SACRIFICE;
  }

  return {
    isSacrifice: minNetLoss >= 2,
    minNetLoss,
  };
}

function findSquare(boardRows, square) {
  const file = square.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number(square[1]);
  const row = 8 - rank;
  if (row < 0 || row > 7 || file < 0 || file > 7) {
    return null;
  }

  return boardRows[row][file];
}

export function classifyMove({
  beforeAnalysis,
  afterAnalysis,
  playedMoveUci,
  moverColor,
  playerElo = 1600,
  gameBefore,
  afterFen,
}) {
  const bestMove = beforeAnalysis.bestMove;
  const isBestMove = playedMoveUci === bestMove;
  const beforeFen = gameBefore && typeof gameBefore.fen === "function" ? gameBefore.fen() : null;
  let bookMatch = beforeFen ? lookupBookMove({ fen: beforeFen, moveUci: playedMoveUci }) : null;
  let usedAfterPositionBookFallback = false;

  if (!bookMatch && afterFen) {
    const afterPositionBook = lookupBookPosition(afterFen);
    if (afterPositionBook) {
      bookMatch = afterPositionBook;
      usedAfterPositionBookFallback = true;
    }
  }

  const bestEp = expectedScoreForMover(beforeAnalysis.cpWhite, moverColor);
  const playedEp = expectedScoreForMover(afterAnalysis.cpWhite, moverColor);
  const epLoss = clamp(bestEp - playedEp, 0, 1);

  let label = classifyByExpectedLoss(epLoss, isBestMove);
  const notes = [];

  const secondLine = beforeAnalysis.lines.find((line) => line.multipv === 2);
  const thirdLine = beforeAnalysis.lines.find((line) => line.multipv === 3);
  const bestCpForMover = cpForMover(beforeAnalysis.cpWhite, moverColor);
  const secondCpForMover = secondLine ? cpForMover(secondLine.cpWhite, moverColor) : null;
  const thirdCpForMover = thirdLine ? cpForMover(thirdLine.cpWhite, moverColor) : null;
  const uniqueDefenseGap = secondLine ? bestEp - expectedScoreForMover(secondLine.cpWhite, moverColor) : 0;
  const cpGap2 = secondCpForMover !== null ? bestCpForMover - secondCpForMover : 0;
  const cpGap3 = thirdCpForMover !== null ? bestCpForMover - thirdCpForMover : 0;
  const allAlternativesWorse = secondLine
    && uniqueDefenseGap >= 0.15
    && cpGap2 >= 140
    && (!thirdLine || cpGap3 >= 170);

  if (!bookMatch && isBestMove && secondLine) {
    if (allAlternativesWorse) {
      label = "Great";
      notes.push("Only move that keeps the position together; alternatives fail clearly.");
    }
  }

  if (!bookMatch && isBestMove && epLoss <= 0.005 && gameBefore) {
    const moverFavoredBefore = moverColor === "w" ? beforeAnalysis.cpWhite : -beforeAnalysis.cpWhite;
    const notTriviallyWinning = moverFavoredBefore < 250;
    const sacrificeAssessment = looksLikeSacrifice({ gameBefore, playedMoveUci, playerElo });
    const brilliantRequiresGreat = allAlternativesWorse;

    if (notTriviallyWinning && brilliantRequiresGreat && sacrificeAssessment.isSacrifice) {
      label = "Brilliant";
      notes.push(`Best and only move with a real sacrifice (minimum net material risk ${sacrificeAssessment.minNetLoss}).`);
    }
  }

  if (bookMatch) {
    label = "Book";
    const openingText = [bookMatch.eco, bookMatch.name].filter(Boolean).join(" ").trim();
    if (usedAfterPositionBookFallback) {
      notes.push(openingText ? `Opening book (transposition): ${openingText}.` : "Opening book move (transposition)." );
    } else {
      notes.push(openingText ? `Opening book: ${openingText}.` : "Opening book move.");
    }
  }

  return {
    label,
    bestMove,
    playedMoveUci,
    isBestMove,
    bestEp,
    playedEp,
    epLoss,
    bestCpWhite: beforeAnalysis.cpWhite,
    playedCpWhite: afterAnalysis.cpWhite,
    notes,
  };
}
