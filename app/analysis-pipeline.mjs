import { classifyMove } from "./move-classifier.mjs";

function uciToMoveObject(uci) {
  if (!uci || uci.length < 4) {
    return null;
  }

  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
  };
}

export async function analyzeGameLine({
  startFen,
  lineMoves,
  playerElo,
  depth,
  multiPV,
  ChessImpl,
  engine,
}) {
  if (typeof ChessImpl !== "function") {
    throw new Error("Chess implementation is required.");
  }
  if (!engine || typeof engine.analyze !== "function") {
    throw new Error("Engine with analyze() is required.");
  }

  const game = new ChessImpl(startFen);
  const results = [];

  for (let i = 0; i < lineMoves.length; i += 1) {
    const playedMoveUci = lineMoves[i];
    const beforeFen = game.fen();
    const moverColor = game.turn();
    const gameBefore = new ChessImpl(beforeFen);

    const applied = game.move(uciToMoveObject(playedMoveUci));
    if (!applied) {
      throw new Error(`Illegal move at ply ${i + 1}: ${playedMoveUci}`);
    }

    const afterFen = game.fen();

    const beforeAnalysis = await engine.analyze(beforeFen, { depth, multiPV });
    const afterAnalysis = await engine.analyze(afterFen, { depth, multiPV: 1 });

    const classification = classifyMove({
      beforeAnalysis,
      afterAnalysis,
      playedMoveUci,
      moverColor,
      playerElo,
      gameBefore,
      afterFen,
    });

    results.push({
      ply: i + 1,
      playedMoveUci,
      moverColor,
      classification,
    });
  }

  return {
    plies: results.length,
    finalFen: game.fen(),
    results,
  };
}
