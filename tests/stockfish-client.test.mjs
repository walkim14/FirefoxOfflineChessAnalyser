import test from "node:test";
import assert from "node:assert/strict";

const FEN_A = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FEN_B = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

class MockWorker {
	constructor(url) {
		this.url = url;
		this.sent = [];
		this.onmessage = null;
		this.onerror = null;
		this.searching = false;
		MockWorker.instances.push(this);
	}

	postMessage(command) {
		this.sent.push(command);
		if (command === "uci") {
			this.emit("uciok");
			return;
		}
		if (command === "isready") {
			this.emit("readyok");
			return;
		}
		if (/^go\b/.test(command)) {
			this.searching = true;
			return;
		}
		if (command === "stop") {
			// A real engine always terminates a search with a `bestmove` line.
			if (this.searching) {
				this.searching = false;
				this.emit("bestmove a2a3");
			}
		}
	}

	emit(line) {
		if (this.onmessage) {
			this.onmessage({ data: line });
		}
	}

	finishSearch(bestMove) {
		this.searching = false;
		this.emit(`bestmove ${bestMove}`);
	}

	terminate() {
		this.terminated = true;
	}

	get lastGo() {
		return [...this.sent].reverse().find((command) => /^go\b/.test(command)) || null;
	}

	get positions() {
		return this.sent.filter((command) => command.startsWith("position fen "));
	}
}

MockWorker.instances = [];

globalThis.Worker = MockWorker;
globalThis.chrome = { runtime: { getURL: (path) => path } };
globalThis.crossOriginIsolated = false;

const { StockfishClient } = await import("../app/stockfish-client.mjs");

function flush() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootClient() {
	MockWorker.instances.length = 0;
	const client = new StockfishClient({ debug: false });
	await client.init();
	return { client, worker: MockWorker.instances[0] };
}

test("a canceled search does not let its stale bestmove resolve the next request", async () => {
	const { client, worker } = await bootClient();

	const first = client.analyze(FEN_A, { depth: 12, multiPV: 1 });
	await flush();
	worker.emit("info depth 12 multipv 1 score cp 30 nodes 1000 nps 50000 pv e2e4 e7e5");

	const second = client.analyze(FEN_B, { depth: 12, multiPV: 1 });
	await assert.rejects(first, /Canceled by newer request/);
	await flush();

	// The stale `bestmove a2a3` produced by `stop` must not be attributed to
	// the new request, and the new search must not start before it arrives.
	let settled = false;
	second.then(() => {
		settled = true;
	}, () => {
		settled = true;
	});
	await flush();
	assert.equal(settled, false, "new request resolved from the previous search's bestmove");

	assert.equal(worker.positions.at(-1), `position fen ${FEN_B}`);
	worker.emit("info depth 12 multipv 1 score cp -18 nodes 900 nps 40000 pv e7e5 g1f3");
	worker.finishSearch("e7e5");

	const result = await second;
	assert.equal(result.fen, FEN_B);
	assert.equal(result.bestMove, "e7e5");
	assert.equal(result.lines.length, 1);
	assert.equal(result.cpWhite, 18, "black-to-move score must be flipped to white's point of view");
});

test("queued analyze requests run in order and only the newest survives", async () => {
	const { client, worker } = await bootClient();

	const first = client.analyze(FEN_A, { depth: 12, multiPV: 1 });
	await flush();

	const second = client.analyze(FEN_B, { depth: 12, multiPV: 1 });
	const third = client.analyze(FEN_A, { depth: 14, multiPV: 2 });

	await assert.rejects(first, /Canceled by newer request/);
	await assert.rejects(second, /Canceled by newer request/);
	await flush();

	assert.equal(worker.positions.at(-1), `position fen ${FEN_A}`);
	assert.equal(worker.lastGo, "go depth 14");

	worker.emit("info depth 14 multipv 1 score cp 25 nodes 10 nps 10 pv e2e4");
	worker.emit("info depth 14 multipv 2 score cp 10 nodes 10 nps 10 pv d2d4");
	worker.finishSearch("e2e4");

	const result = await third;
	assert.equal(result.lines.length, 2);
	assert.equal(result.bestMove, "e2e4");
});

test("bounded (upperbound/lowerbound) info lines are ignored", async () => {
	const { client, worker } = await bootClient();

	const pending = client.analyze(FEN_A, { depth: 12, multiPV: 1 });
	await flush();

	worker.emit("info depth 12 multipv 1 score cp 30 nodes 10 nps 10 pv e2e4");
	worker.emit("info depth 12 multipv 1 score cp 900 upperbound nodes 10 nps 10 pv d2d4");
	worker.finishSearch("e2e4");

	const result = await pending;
	assert.equal(result.cpWhite, 30);
	assert.equal(result.lines[0].move, "e2e4");
});

test("a timed out search still drains its bestmove before the next search starts", async () => {
	const { client, worker } = await bootClient();

	const pending = client.analyze(FEN_A, { depth: 12, multiPV: 1, timeoutMs: 15000 });
	await flush();
	assert.equal(worker.searching, true);

	const next = client.analyze(FEN_B, { depth: 12, multiPV: 1 });
	await assert.rejects(pending, /Canceled by newer request/);
	await flush();

	worker.emit("info depth 12 multipv 1 score cp -20 nodes 10 nps 10 pv e7e5");
	worker.finishSearch("e7e5");
	const result = await next;
	assert.equal(result.fen, FEN_B);
});

test("dispose rejects in-flight and queued work", async () => {
	const { client, worker } = await bootClient();

	const pending = client.analyze(FEN_A, { depth: 12, multiPV: 1 });
	await flush();
	worker.emit("info depth 12 multipv 1 score cp 30 nodes 10 nps 10 pv e2e4");

	client.dispose();
	await assert.rejects(pending, /disposed|crashed|Canceled/i);
});
