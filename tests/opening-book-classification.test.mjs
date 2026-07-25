import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lookupBookMove } from "../app/opening-book.mjs";
import { classifyMove } from "../app/move-classifier.mjs";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");

test("opening book lookup finds common opening move from start position", () => {
  const game = new Chess();
  game.move({ from: "e2", to: "e4" });
  const match = lookupBookMove({ fen: game.fen(), moveUci: "c7c5" });

  assert.ok(match, "Expected c7c5 to be present in opening book after 1.e4.");
  assert.ok(typeof match.eco === "string");
  assert.ok(typeof match.name === "string");
});

test("book membership overrides eval-based labels", () => {
  const gameBefore = new Chess();
  const gameAfter = new Chess();
  gameAfter.move({ from: "e2", to: "e4" });
  const afterFen = gameAfter.fen();

  const classification = classifyMove({
    beforeAnalysis: {
      bestMove: "d2d4",
      cpWhite: 20,
      lines: [
        { multipv: 1, cpWhite: 20 },
        { multipv: 2, cpWhite: 15 },
        { multipv: 3, cpWhite: 10 },
      ],
    },
    afterAnalysis: {
      cpWhite: -120,
      lines: [{ multipv: 1, cpWhite: -120 }],
    },
    playedMoveUci: "e2e4",
    moverColor: "w",
    playerElo: 1700,
    gameBefore,
    afterFen,
  });

  assert.equal(classification.label, "Book");
  assert.ok(classification.notes.some((note) => note.includes("Opening book")));
});
