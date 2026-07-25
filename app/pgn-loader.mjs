function verboseMoveToUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function extractFenFromPgnText(pgn) {
  const fenMatch = pgn.match(/\[FEN\s+"([^"]+)"\]/i);
  return fenMatch ? fenMatch[1] : null;
}

function toFiniteElo(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric);
}

export function parsePgnToLine(pgnText, ChessImpl) {
  if (typeof ChessImpl !== "function") {
    throw new Error("Chess implementation is required.");
  }

  const pgn = (pgnText || "").trim();
  if (!pgn) {
    throw new Error("PGN is empty.");
  }

  const game = new ChessImpl();

  try {
    game.loadPgn(pgn, { strict: false });
  } catch (error) {
    throw new Error(`PGN parse failed: ${error?.message || error}`);
  }

  const moveList = game.history({ verbose: true }).map(verboseMoveToUci);
  const fenFromTag = extractFenFromPgnText(pgn);
  const headers = typeof game.getHeaders === "function" ? game.getHeaders() : {};
  const whiteElo = toFiniteElo(headers.WhiteElo);
  const blackElo = toFiniteElo(headers.BlackElo);
  const suggestedElo =
    whiteElo !== null && blackElo !== null
      ? Math.round((whiteElo + blackElo) / 2)
      : whiteElo !== null
        ? whiteElo
        : blackElo;

  return {
    startFen: fenFromTag || new ChessImpl().fen(),
    lineMoves: moveList,
    finalFen: game.fen(),
    headers,
    whiteElo,
    blackElo,
    suggestedElo: suggestedElo ?? null,
  };
}
