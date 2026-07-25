import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithFallback } from "../app/analysis-fallback.mjs";

class TimeoutThenSuccessEngine {
  constructor() {
    this.calls = [];
  }

  async analyze(_fen, options) {
    this.calls.push(options);
    if (this.calls.length === 1) {
      throw new Error("Analysis timed out at depth 22, multiPV 3, timeout 50000ms.");
    }

    return {
      bestMove: "e2e4",
      cpWhite: 10,
      evalText: "+0.10",
      winPercentWhite: 51,
      depthReached: options.depth,
      nps: 100000,
      nodes: 123456,
      sideToMove: "w",
      lines: [
        {
          multipv: 1,
          depth: options.depth,
          move: "e2e4",
          pv: "e2e4",
          scoreType: "cp",
          scoreValue: 10,
          cpWhite: 10,
          evalText: "+0.10",
          winPercentWhite: 51,
        },
      ],
    };
  }
}

test("analyzeWithFallback retries after timeout and succeeds with lighter profile", async () => {
  const engine = new TimeoutThenSuccessEngine();

  const { usedProfile, attempt, result } = await analyzeWithFallback({
    engine,
    fen: "rn1qkbnr/pppb1ppp/3pp3/8/3PP3/2N2N2/PPP2PPP/R1BQKB1R w KQkq - 0 5",
    depth: 22,
    multiPV: 3,
    phase: "position",
    logger: () => {},
  });

  assert.equal(attempt, 2);
  assert.equal(usedProfile.depth, 20);
  assert.equal(usedProfile.multiPV, 2);
  assert.equal(result.bestMove, "e2e4");
});
