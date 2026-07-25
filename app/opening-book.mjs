import { OPENING_BOOK } from "./opening-book-data.mjs";

function normalizeFenToBookKey(fen) {
  if (!fen || typeof fen !== "string") {
    return "";
  }

  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    return "";
  }

  return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
}

export function lookupBookMove({ fen, moveUci }) {
  const key = normalizeFenToBookKey(fen);
  if (!key || !moveUci) {
    return null;
  }

  const entry = OPENING_BOOK[key];
  if (!entry || !Array.isArray(entry.moves)) {
    return null;
  }

  if (!entry.moves.includes(moveUci)) {
    return null;
  }

  return {
    eco: entry.eco || "",
    name: entry.name || "",
    key,
  };
}

export function lookupBookPosition(fen) {
  const key = normalizeFenToBookKey(fen);
  if (!key) {
    return null;
  }

  const entry = OPENING_BOOK[key];
  if (!entry) {
    return null;
  }

  return {
    eco: entry.eco || "",
    name: entry.name || "",
    key,
  };
}

export function isBookPosition(fen) {
  const key = normalizeFenToBookKey(fen);
  return Boolean(key && OPENING_BOOK[key]);
}
