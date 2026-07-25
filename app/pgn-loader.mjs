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

function parseClockTokenToSeconds(token) {
  if (!token) {
    return null;
  }

  const trimmed = String(token).trim();
  const parts = trimmed.split(":").map((part) => part.trim());
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }

  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = numbers;
    return Math.round(minutes * 60 + seconds);
  }

  const [hours, minutes, seconds] = numbers;
  return Math.round(hours * 3600 + minutes * 60 + seconds);
}

function formatClockSeconds(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return null;
  }

  const whole = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function extractClockTimelineFromPgnText(pgnText, startFen, moveCount, ChessImpl) {
  const emptyTimeline = Array.from({ length: moveCount + 1 }, () => ({ white: null, black: null }));
  if (!pgnText || moveCount <= 0) {
    return emptyTimeline;
  }

  const matches = [...pgnText.matchAll(/\[%clk\s+([^\]]+)\]/gi)];
  if (!matches.length) {
    return emptyTimeline;
  }

  let turn = "w";
  try {
    const game = new ChessImpl(startFen);
    turn = game.turn();
  } catch {
    turn = "w";
  }

  const timeline = [{ white: null, black: null }];
  let whiteClock = null;
  let blackClock = null;

  for (let ply = 0; ply < moveCount; ply += 1) {
    const raw = matches[ply]?.[1] || "";
    const seconds = parseClockTokenToSeconds(raw);
    const display = formatClockSeconds(seconds);

    if (display) {
      if (turn === "w") {
        whiteClock = display;
      } else {
        blackClock = display;
      }
    }

    timeline.push({
      white: whiteClock,
      black: blackClock,
    });

    turn = turn === "w" ? "b" : "w";
  }

  return timeline;
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
  const startFen = fenFromTag || new ChessImpl().fen();
  const clockTimeline = extractClockTimelineFromPgnText(pgn, startFen, moveList.length, ChessImpl);
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
    startFen,
    lineMoves: moveList,
    finalFen: game.fen(),
    headers,
    whiteElo,
    blackElo,
    suggestedElo: suggestedElo ?? null,
    clockTimeline,
  };
}
