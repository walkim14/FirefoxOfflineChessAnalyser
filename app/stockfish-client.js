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
    return cp > 0 ? "+M" : "-M";
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
    this.currentRequest = null;
    this.requestId = 0;
    this.workerPath = null;
    this.needsRestart = false;
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

    const prefersThreads = globalThis.crossOriginIsolated && navigator.hardwareConcurrency > 2;
    const workerPath = prefersThreads ? "engine/stockfish-lite.js" : "engine/stockfish-lite-single.js";
    this.workerPath = workerPath;
    this.log("starting worker", { workerPath, crossOriginIsolated: globalThis.crossOriginIsolated });

    this.worker = new Worker(chrome.runtime.getURL(workerPath));
    this.worker.onmessage = (event) => this.onMessage(String(event.data || ""));
    this.worker.onerror = (error) => {
      this.log("worker error", error);
      this.needsRestart = true;

      if (this.currentRequest?.reject) {
        this.currentRequest.reject(new Error("Stockfish worker crashed. Worker restart required."));
        this.currentRequest = null;
      }

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

  async configure({ hashMb = 256, threads = 1, multiPV = 3 } = {}) {
    await this.init();

    const safeHash = clamp(Math.trunc(hashMb), 64, 1024);
    const safeThreads = clamp(Math.trunc(threads), 1, 32);
    const safeMultiPv = clamp(Math.trunc(multiPV), 1, 4);

    this.send(`setoption name Hash value ${safeHash}`);
    this.send(`setoption name Threads value ${safeThreads}`);
    this.send(`setoption name MultiPV value ${safeMultiPv}`);
    this.send("setoption name UCI_AnalyseMode value true");
    this.send("isready");
    this.log("configured", { safeHash, safeThreads, safeMultiPv });
  }

  async analyze(fen, { depth = 22, multiPV = 3, timeoutMs = null } = {}) {
    try {
      await this.init();
    } catch {
      this.dispose();
      this.needsRestart = false;
      await this.init();
    }

    if (this.currentRequest) {
      this.send("stop");
      this.currentRequest.reject(new Error("Canceled by newer request."));
      this.currentRequest = null;
    }

    const sideToMove = fen.split(" ")[1] || "w";
    const safeDepth = clamp(Math.trunc(depth), 10, 30);
    const safeMultiPv = clamp(Math.trunc(multiPV), 1, 4);
    const requestId = ++this.requestId;
    const computedTimeout = timeoutMs ?? 18000 + safeDepth * 1200 + safeMultiPv * 3500;
    const safeTimeoutMs = clamp(Math.trunc(computedTimeout), 15000, 120000);
    this.log("analyze start", { requestId, safeDepth, safeMultiPv, fen });

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.currentRequest || this.currentRequest.requestId !== requestId) {
          return;
        }

        this.log("analyze timeout", { requestId, safeDepth, safeMultiPv, safeTimeoutMs });
        this.send("stop");
        this.currentRequest.reject(
          new Error(`Analysis timed out at depth ${safeDepth}, multiPV ${safeMultiPv}, timeout ${safeTimeoutMs}ms.`),
        );
        this.currentRequest = null;
      }, safeTimeoutMs);

      this.currentRequest = {
        requestId,
        fen,
        sideToMove,
        linesByPv: new Map(),
        depthReached: 0,
        maxNps: 0,
        maxNodes: 0,
        timeoutId,
        resolve,
        reject,
      };

      this.send(`setoption name MultiPV value ${safeMultiPv}`);
      this.send(`position fen ${fen}`);
      this.send(`go depth ${safeDepth}`);
    });
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

    if (!this.currentRequest) {
      return;
    }

    const info = this.parseInfoLine(line);
    if (info) {
      const req = this.currentRequest;
      req.depthReached = Math.max(req.depthReached, info.depth);
      req.maxNps = Math.max(req.maxNps, info.nps);
      req.maxNodes = Math.max(req.maxNodes, info.nodes);

      const existing = req.linesByPv.get(info.multipv);
      if (!existing || info.depth >= existing.depth) {
        req.linesByPv.set(info.multipv, info);
      }
      return;
    }

    if (line.startsWith("bestmove ")) {
      const req = this.currentRequest;
      this.currentRequest = null;
      clearTimeout(req.timeoutId);

      const lines = [...req.linesByPv.values()].sort((a, b) => a.multipv - b.multipv);
      const enriched = lines.map((entry) => {
        const cpRaw = parseScoreCp(entry.scoreType, entry.scoreValue);
        const cpWhite = req.sideToMove === "w" ? cpRaw : -cpRaw;
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

      const bestMove = line.split(/\s+/)[1] || null;
      const bestLine = enriched.find((lineItem) => lineItem.multipv === 1) || enriched[0] || null;

      req.resolve({
        fen: req.fen,
        sideToMove: req.sideToMove,
        depthReached: req.depthReached,
        nps: req.maxNps,
        nodes: req.maxNodes,
        bestMove,
        lines: enriched,
        cpWhite: bestLine ? bestLine.cpWhite : 0,
        evalText: bestLine ? bestLine.evalText : "+0.00",
        winPercentWhite: bestLine ? bestLine.winPercentWhite : 50,
      });

      this.log("analyze done", {
        requestId: req.requestId,
        bestMove,
        depth: req.depthReached,
        nps: req.maxNps,
      });
    }
  }

  parseInfoLine(line) {
    if (!line.startsWith("info ") || !line.includes(" score ") || !line.includes(" pv ")) {
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
    if (this.currentRequest) {
      clearTimeout(this.currentRequest.timeoutId);
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.currentRequest = null;
    this.ready = false;
    this.readyPromise = null;
    this.onReadyResolve = null;
    this.onReadyReject = null;
  }
}
