// Multi-threaded Stockfish needs SharedArrayBuffer, which an extension page
// does not get (see tools/probe/run-probe.mjs). But a whole-game review is a
// pile of independent positions, so the parallelism can come from running
// several single-threaded engines at once instead.
//
//   node tools/bench-pool.mjs [--positions 16] [--depth 16] [--workers 1,2,4,6]
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");
const initEngine = require("stockfish");

const PGN = `1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Be3 Bg7 5. Qd2 c6 6. f3 b5 7. Nge2 Nbd7
8. Bh6 Bxh6 9. Qxh6 Bb7 10. a3 e5 11. O-O-O Qe7 12. Kb1 a6 13. Nc1 O-O-O
14. Nb3 exd4 15. Rxd4 c5 16. Rd1 Nb6 17. g3 Kb8 18. Na5 Ba8 19. Bh3 d5`;

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const positionCount = Number(arg("--positions", "16"));
const depth = Number(arg("--depth", "16"));
const hashPerWorker = Number(arg("--hash", "32"));
const workerCounts = String(arg("--workers", "1,2,4,6,8")).split(",").map(Number);

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Runs `fens` in a dedicated process, the way a browser Worker would. */
function runLane(fens, depth, hash) {
	return new Promise((resolve, reject) => {
		const child = fork(join(here, "one-engine.mjs"), [JSON.stringify({ depth, hash, fens })], { stdio: "ignore", silent: true });
		child.on("message", (message) => {
			if (message === "ready") {
				child.send("go");
				return;
			}
			resolve(message.ms);
		});
		child.on("error", reject);
	});
}

const game = new Chess();
const fens = [game.fen()];
for (const san of PGN.replace(/\d+\.\s*/g, "").split(/\s+/).filter(Boolean)) {
	if (fens.length > positionCount) {
		break;
	}
	try {
		game.move(san);
	} catch {
		break;
	}
	fens.push(game.fen());
}
const positions = fens.slice(0, positionCount);

console.log(`${positions.length} positions at depth ${depth}, 2 lines, ${hashPerWorker}MB per engine`);
console.log(`machine reports ${require("node:os").cpus().length} cores\n`);

const results = [];
for (const count of workerCounts) {
	// Deal positions round-robin across the lanes.
	const lanes = Array.from({ length: count }, () => []);
	positions.forEach((fen, index) => lanes[index % count].push(fen));

	const started = Date.now();
	await Promise.all(lanes.map((fens) => runLane(fens, depth, hashPerWorker)));
	const seconds = (Date.now() - started) / 1000;
	results.push({ count, seconds });
	console.log(
		`${String(count).padStart(2)} engine(s)  ${seconds.toFixed(1).padStart(6)}s  ` +
			`${(results[0].seconds / seconds).toFixed(2)}x vs one`,
	);
}

process.exit(0);
