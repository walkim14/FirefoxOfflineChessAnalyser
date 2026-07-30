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

class AlwaysTimesOutEngine {
  constructor() {
    this.calls = [];
  }

  async analyze(_fen, options) {
    this.calls.push(options);
    throw new Error(`Analysis timed out at depth ${options.depth}, multiPV ${options.multiPV}, timeout 50000ms.`);
  }
}

test("fallback profiles never retry harder than the requested profile", async () => {
  const engine = new AlwaysTimesOutEngine();

  await assert.rejects(
    analyzeWithFallback({
      engine,
      fen: "rn1qkbnr/pppb1ppp/3pp3/8/3PP3/2N2N2/PPP2PPP/R1BQKB1R w KQkq - 0 5",
      // A low requested depth used to be "recovered" upward to 16.
      depth: 12,
      multiPV: 1,
      phase: "position",
      logger: () => {},
    }),
    /timed out/,
  );

  assert.ok(engine.calls.length > 0);
  for (const call of engine.calls) {
    assert.ok(call.depth <= 12, `retry depth ${call.depth} exceeded the requested depth`);
    assert.ok(call.multiPV <= 1);
  }

  const depths = engine.calls.map((call) => call.depth);
  assert.deepEqual(depths, [...depths].sort((a, b) => b - a), "each retry must be no harder than the last");
});

class CanceledEngine {
  constructor() {
    this.calls = 0;
  }

  async analyze() {
    this.calls += 1;
    throw new Error("Canceled by newer request.");
  }
}

test("a cancellation is propagated instead of triggering fallback retries", async () => {
  const engine = new CanceledEngine();

  await assert.rejects(
    analyzeWithFallback({
      engine,
      fen: "rn1qkbnr/pppb1ppp/3pp3/8/3PP3/2N2N2/PPP2PPP/R1BQKB1R w KQkq - 0 5",
      depth: 22,
      multiPV: 3,
      phase: "position",
      logger: () => {},
    }),
    /Canceled by newer request/,
  );

  assert.equal(engine.calls, 1, "retrying would only fight the newer request for the engine");
});
