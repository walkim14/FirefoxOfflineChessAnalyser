const CANCEL_MESSAGE = "Canceled by newer request.";

// How long we wait for the `bestmove` that terminates a search we asked to
// stop. Stockfish always sends one; if it does not, the worker is wedged and
// gets restarted rather than leaving the queue stuck forever.
const STOP_DRAIN_TIMEOUT_MS = 5000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseScoreCp(scoreType, scoreValue) {
  if (scoreType === "cp") {
    return Number(scoreValue);
  }

  const mate = Number(scoreValue);
  const sign = Math.sign(mate) || 1;
  return sign * (10000 - Math.min(Math.abs(mate), 100) * 40);
}

function cpToWinPercent(cpWhite) {
  const scaled = 50 + 50 * ((2 / (1 + Math.exp(-0.00368208 * cpWhite))) - 1);
  return clamp(scaled, 0, 100);
}

function cpToEvalText(cp) {
  if (Math.abs(cp) >= 9500) {
    const movesToMate = Math.max(1, Math.round((10000 - Math.abs(cp)) / 40));
    return cp > 0 ? `+M${movesToMate}` : `-M${movesToMate}`;
  }

  const pawns = cp / 100;
  return pawns >= 0 ? `+${pawns.toFixed(2)}` : pawns.toFixed(2);
}

export class StockfishClient {
  constructor({ debugLabel = "main", debug = true } = {}) {
    this.worker = null;
    this.ready = false;
    this.readyPromise = null;
    this.onReadyResolve = null;
    this.onReadyReject = null;
    /** Search currently running inside the worker. */
    this.activeRequest = null;
    /** Request waiting for the worker to finish draining the previous search. */
    this.queuedRequest = null;
    /**
     * True between sending `stop` (or hitting a timeout) and receiving the
     * `bestmove` that terminates that search. While set, no new search may be
     * started: the pending `bestmove` belongs to the old position and would
     * otherwise resolve the next request with a stale, empty result.
     */
    this.drainingStoppedSearch = false;
    this.drainTimeoutId = null;
    this.requestId = 0;
    this.workerPath = null;
    this.needsRestart = false;
    this.options = { hashMb: 128, threads: 1, multiPV: 3 };
    this.debug = debug;
    this.debugLabel = debugLabel;
  }

  log(message, payload) {
    if (!this.debug) {
      return;
    }

    if (payload === undefined) {
      console.debug(`[engine:${this.debugLabel}] ${message}`);
      return;
    }

    console.debug(`[engine:${this.debugLabel}] ${message}`, payload);
  }

  async init() {
    if (this.needsRestart) {
      this.dispose();
      this.needsRestart = false;
    }

    if (this.ready) {
      return;
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    const prefersThreads = globalThis.crossOriginIsolated && (globalThis.navigator?.hardwareConcurrency || 1) > 2;
    const workerPath = prefersThreads ? "engine/stockfish-lite.js" : "engine/stockfish-lite-single.js";
    this.workerPath = workerPath;
    this.log("starting worker", { workerPath, crossOriginIsolated: globalThis.crossOriginIsolated });

    this.worker = new Worker(chrome.runtime.getURL(workerPath));
    this.worker.onmessage = (event) => this.onMessage(String(event.data || ""));
    this.worker.onerror = (error) => {
      this.log("worker error", error);
      this.needsRestart = true;
      this.failAll(new Error("Stockfish worker crashed. Worker restart required."));

      if (!this.ready && this.onReadyReject) {
        this.onReadyReject(new Error("Stockfish worker failed to initialize."));
        this.onReadyReject = null;
        this.onReadyResolve = null;
      }
    };

    this.readyPromise = new Promise((resolve, reject) => {
      this.onReadyResolve = resolve;
      this.onReadyReject = reject;
    });

    this.send("uci");
    return this.readyPromise;
  }

  send(command) {
    if (!this.worker) {
      throw new Error("Engine worker not initialized.");
    }

    if (/^go\b/.test(command) || /^position\b/.test(command) || /^setoption\b/.test(command)) {
      this.log("send", command);
    }

    this.worker.postMessage(command);
  }

  async configure({ hashMb = 128, threads = 1, multiPV = 3 } = {}) {
    await this.init();

    const safeHash = clamp(Math.trunc(hashMb), 64, 1024);
    const safeThreads = clamp(Math.trunc(threads), 1, 32);
    const safeMultiPv = clamp(Math.trunc(multiPV), 1, 4);
    this.options = { hashMb: safeHash, threads: safeThreads, multiPV: safeMultiPv };

    // UCI options may only be changed while the engine is idle.
    this.cancelAll("Canceled by engine reconfiguration.");

    this.send(`setoption name Hash value ${safeHash}`);
    this.send(`setoption name Threads value ${safeThreads}`);
    this.send(`setoption name MultiPV value ${safeMultiPv}`);
    this.send("setoption name UCI_AnalyseMode value true");
    this.send("isready");
    this.log("configured", this.options);
  }

  isBusy() {
    return Boolean(this.activeRequest || this.queuedRequest || this.drainingStoppedSearch);
  }

  /** Aborts everything in flight without starting anything new. */
  cancelAll(message = CANCEL_MESSAGE) {
    if (this.queuedRequest) {
      const queued = this.queuedRequest;
      this.queuedRequest = null;
      queued.reject(new Error(message));
    }

    if (this.activeRequest) {
      this.stopActiveRequest(new Error(message));
    }
  }

  failAll(error) {
    this.clearDrainTimeout();
    this.drainingStoppedSearch = false;

    const queued = this.queuedRequest;
    const active = this.activeRequest;
    this.queuedRequest = null;
    this.activeRequest = null;

    if (active) {
      clearTimeout(active.timeoutId);
      active.reject(error);
    }
    if (queued) {
      queued.reject(error);
    }
  }

  clearDrainTimeout() {
    if (this.drainTimeoutId) {
      clearTimeout(this.drainTimeoutId);
      this.drainTimeoutId = null;
    }
  }

  /**
   * Asks the engine to abandon the running search. The request is rejected
   * immediately, but the worker still owes us a `bestmove`, so the queue stays
   * blocked until that arrives (or the drain watchdog restarts the worker).
   */
  stopActiveRequest(error) {
    const request = this.activeRequest;
    if (!request) {
      return;
    }

    this.activeRequest = null;
    clearTimeout(request.timeoutId);
    this.drainingStoppedSearch = true;
    this.armDrainWatchdog();

    try {
      this.send("stop");
    } catch (sendError) {
      this.log("stop failed", String(sendError?.message || sendError));
    }

    request.reject(error);
  }

  armDrainWatchdog() {
    this.clearDrainTimeout();
    this.drainTimeoutId = setTimeout(() => {
      this.drainTimeoutId = null;
      if (!this.drainingStoppedSearch) {
        return;
      }

      this.log("stopped search never returned bestmove; restarting worker");
      const queued = this.queuedRequest;
      this.queuedRequest = null;
      this.dispose();
      this.needsRestart = false;

      if (!queued) {
        return;
      }

      this.init()
        .then(() => {
          this.applyPersistedOptions();
          this.queuedRequest = queued;
          this.startNextRequest();
        })
        .catch((error) => {
          queued.reject(error instanceof Error ? error : new Error(String(error)));
        });
    }, STOP_DRAIN_TIMEOUT_MS);
  }

  applyPersistedOptions() {
    try {
      this.send(`setoption name Hash value ${this.options.hashMb}`);
      this.send(`setoption name Threads value ${this.options.threads}`);
      this.send("setoption name UCI_AnalyseMode value true");
    } catch (error) {
      this.log("reapplying options failed", String(error?.message || error));
    }
  }

  async analyze(fen, { depth = 22, multiPV = 3, timeoutMs = null } = {}) {
    try {
      await this.init();
    } catch {
      this.dispose();
      this.needsRestart = false;
      await this.init();
    }

    const sideToMove = fen.split(" ")[1] || "w";
    const safeDepth = clamp(Math.trunc(depth), 10, 30);
    const safeMultiPv = clamp(Math.trunc(multiPV), 1, 4);
    const requestId = ++this.requestId;
    const computedTimeout = timeoutMs ?? 18000 + safeDepth * 1200 + safeMultiPv * 3500;
    const safeTimeoutMs = clamp(Math.trunc(computedTimeout), 15000, 120000);

    return new Promise((resolve, reject) => {
      const request = {
        requestId,
        fen,
        sideToMove,
        depth: safeDepth,
        multiPV: safeMultiPv,
        timeoutMs: safeTimeoutMs,
        linesByPv: new Map(),
        depthReached: 0,
        maxNps: 0,
        maxNodes: 0,
        timeoutId: null,
        resolve,
        reject,
      };

      // A newer request always wins: drop anything queued, stop anything running.
      if (this.queuedRequest) {
        const superseded = this.queuedRequest;
        this.queuedRequest = null;
        superseded.reject(new Error(CANCEL_MESSAGE));
      }

      this.queuedRequest = request;

      if (this.activeRequest) {
        this.stopActiveRequest(new Error(CANCEL_MESSAGE));
        return;
      }

      this.startNextRequest();
    });
  }

  startNextRequest() {
    if (this.activeRequest || this.drainingStoppedSearch || !this.queuedRequest) {
      return;
    }

    const request = this.queuedRequest;
    this.queuedRequest = null;
    this.activeRequest = request;

    this.log("analyze start", {
      requestId: request.requestId,
      depth: request.depth,
      multiPV: request.multiPV,
      fen: request.fen,
    });

    request.timeoutId = setTimeout(() => {
      if (this.activeRequest?.requestId !== request.requestId) {
        return;
      }

      this.log("analyze timeout", {
        requestId: request.requestId,
        depth: request.depth,
        multiPV: request.multiPV,
        timeoutMs: request.timeoutMs,
      });
      this.stopActiveRequest(
        new Error(
          `Analysis timed out at depth ${request.depth}, multiPV ${request.multiPV}, timeout ${request.timeoutMs}ms.`,
        ),
      );
    }, request.timeoutMs);

    try {
      this.send(`setoption name MultiPV value ${request.multiPV}`);
      this.send(`position fen ${request.fen}`);
      this.send(`go depth ${request.depth}`);
    } catch (error) {
      this.activeRequest = null;
      clearTimeout(request.timeoutId);
      request.reject(error instanceof Error ? error : new Error(String(error)));
      this.startNextRequest();
    }
  }

  onMessage(line) {
    if (!line) {
      return;
    }

    if (line === "uciok") {
      this.ready = true;
      if (this.onReadyResolve) {
        this.onReadyResolve();
        this.onReadyResolve = null;
        this.onReadyReject = null;
      }
      this.log("engine ready");
      return;
    }

    if (line.startsWith("bestmove ")) {
      this.onBestMove(line);
      return;
    }

    if (!this.activeRequest) {
      return;
    }

    const info = this.parseInfoLine(line);
    if (!info) {
      return;
    }

    const request = this.activeRequest;
    request.depthReached = Math.max(request.depthReached, info.depth);
    request.maxNps = Math.max(request.maxNps, info.nps);
    request.maxNodes = Math.max(request.maxNodes, info.nodes);

    const existing = request.linesByPv.get(info.multipv);
    if (!existing || info.depth >= existing.depth) {
      request.linesByPv.set(info.multipv, info);
    }
  }

  onBestMove(line) {
    // `bestmove` for a search we already abandoned: swallow it, then let the
    // queue move on.
    if (this.drainingStoppedSearch) {
      this.drainingStoppedSearch = false;
      this.clearDrainTimeout();
      this.log("drained stale bestmove", line);
      this.startNextRequest();
      return;
    }

    const request = this.activeRequest;
    if (!request) {
      return;
    }

    this.activeRequest = null;
    clearTimeout(request.timeoutId);

    const lines = [...request.linesByPv.values()].sort((a, b) => a.multipv - b.multipv);
    const enriched = lines.map((entry) => {
      const cpRaw = parseScoreCp(entry.scoreType, entry.scoreValue);
      const cpWhite = request.sideToMove === "w" ? cpRaw : -cpRaw;
      return {
        multipv: entry.multipv,
        depth: entry.depth,
        move: entry.move,
        pv: entry.pv,
        scoreType: entry.scoreType,
        scoreValue: entry.scoreValue,
        cpWhite,
        evalText: cpToEvalText(cpWhite),
        winPercentWhite: cpToWinPercent(cpWhite),
      };
    });

    const reportedBestMove = line.split(/\s+/)[1] || null;
    const bestLine = enriched.find((lineItem) => lineItem.multipv === 1) || enriched[0] || null;
    // `bestmove (none)` is emitted for checkmate/stalemate positions.
    const bestMove = reportedBestMove && reportedBestMove !== "(none)" ? reportedBestMove : null;

    request.resolve({
      fen: request.fen,
      sideToMove: request.sideToMove,
      requestedDepth: request.depth,
      requestedMultiPV: request.multiPV,
      depthReached: request.depthReached,
      nps: request.maxNps,
      nodes: request.maxNodes,
      bestMove,
      lines: enriched,
      cpWhite: bestLine ? bestLine.cpWhite : 0,
      evalText: bestLine ? bestLine.evalText : "+0.00",
      winPercentWhite: bestLine ? bestLine.winPercentWhite : 50,
    });

    this.log("analyze done", {
      requestId: request.requestId,
      bestMove,
      depth: request.depthReached,
      nps: request.maxNps,
    });

    this.startNextRequest();
  }

  parseInfoLine(line) {
    if (!line.startsWith("info ") || !line.includes(" score ") || !line.includes(" pv ")) {
      return null;
    }

    // Fail-soft aspiration-window scores are not usable evaluations.
    if (/\b(upperbound|lowerbound)\b/.test(line)) {
      return null;
    }

    const depthMatch = line.match(/\bdepth\s+(\d+)/);
    const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    const pvMatch = line.match(/\bpv\s+(.+)$/);

    if (!depthMatch || !scoreMatch || !pvMatch) {
      return null;
    }

    const multipvMatch = line.match(/\bmultipv\s+(\d+)/);
    const multipv = multipvMatch ? Number(multipvMatch[1]) : 1;
    const depth = Number(depthMatch[1]);
    const scoreType = scoreMatch[1];
    const scoreValue = Number(scoreMatch[2]);
    const pv = pvMatch[1].trim();
    const move = pv.split(/\s+/)[0] || null;
    const npsMatch = line.match(/\bnps\s+(\d+)/);
    const nodesMatch = line.match(/\bnodes\s+(\d+)/);
    const nps = npsMatch ? Number(npsMatch[1]) : 0;
    const nodes = nodesMatch ? Number(nodesMatch[1]) : 0;

    return {
      multipv,
      depth,
      scoreType,
      scoreValue,
      pv,
      move,
      nps,
      nodes,
    };
  }

  dispose() {
    this.failAll(new Error("Engine worker disposed."));

    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }

    this.ready = false;
    this.readyPromise = null;
    this.onReadyResolve = null;
    this.onReadyReject = null;
  }
}
