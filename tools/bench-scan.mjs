// Runs the real whole-game review pipeline against the real engine, so the
// number reported is the one a user waits through after clicking Load game.
//
//   node tools/bench-scan.mjs [--depth 22] [--review 18] [--lines 3] [--plies 24]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession } from "../tests/helpers/analyzer-session.mjs";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");
const initEngine = require("stockfish");

const GAMES = {
	// Kasparov-Topalov 1999: a strong game, so almost every move is "good".
	// Useful for measuring evaluation drift, useless for measuring whether
	// mistakes still get caught.
	quiet: `1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Be3 Bg7 5. Qd2 c6 6. f3 b5 7. Nge2 Nbd7
8. Bh6 Bxh6 9. Qxh6 Bb7 10. a3 e5 11. O-O-O Qe7 12. Kb1 a6 13. Nc1 O-O-O
14. Nb3 exd4 15. Rxd4 c5 16. Rd1 Nb6 17. g3 Kb8 18. Na5 Ba8 19. Bh3 d5
20. Qf4+ Ka7 21. Rhe1 d4 22. Nd5 Nbxd5 23. exd5 Qd6 24. Rxd4 cxd4 25. Re7+`,
	// Morphy's Opera Game: Black defends badly and loses material repeatedly,
	// so the review has real inaccuracies, mistakes and blunders to find.
	sharp: `1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6
7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8
13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8#`,
};

function pickGame() {
	const index = process.argv.indexOf("--game");
	const name = index === -1 ? "quiet" : process.argv[index + 1];
	if (!GAMES[name]) {
		throw new Error(`unknown game "${name}"; expected one of ${Object.keys(GAMES).join(", ")}`);
	}
	return GAMES[name];
}

const PGN = pickGame();

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : Number(process.argv[index + 1]);
}

const depth = arg("--depth", 22);
const reviewDepth = arg("--review", 18);
const multiPV = arg("--lines", 3);
const maxPlies = arg("--plies", 24);

/** Adapts the UCI engine to the `analyze()` contract the controllers expect. */
async function createEngineAdapter() {
	const engine = await initEngine("lite-single");
	const listeners = [];
	engine.listener = (line) => {
		for (const listener of [...listeners]) {
			listener(String(line));
		}
	};
	const send = (command) => engine.sendCommand(command);
	const waitFor = (predicate) =>
		new Promise((resolve) => {
			const listener = (line) => {
				const value = predicate(line);
				if (value !== undefined && value !== false) {
					listeners.splice(listeners.indexOf(listener), 1);
					resolve(value);
				}
			};
			listeners.push(listener);
		});

	send("uci");
	await waitFor((line) => (line === "uciok" ? true : undefined));
	send("setoption name Hash value 128");
	send("setoption name Threads value 1");
	send("setoption name UCI_AnalyseMode value true");

	const calls = [];
	return {
		calls,
		async analyze(fen, { depth: searchDepth = 22, multiPV: lines = 3 } = {}) {
			calls.push({ fen, depth: searchDepth, multiPV: lines });
			const sideToMove = fen.split(" ")[1] || "w";
			const byPv = new Map();
			let best = null;

			send(`setoption name MultiPV value ${lines}`);
			send(`position fen ${fen}`);
			send(`go depth ${searchDepth}`);
			await waitFor((line) => {
				if (line.startsWith("bestmove")) {
					best = line.split(/\s+/)[1];
					return true;
				}
				const score = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
				const pv = line.match(/\bpv\s+(.+)$/);
				const pvIndex = line.match(/\bmultipv\s+(\d+)/);
				if (score && pv && !/\b(upperbound|lowerbound)\b/.test(line)) {
					const raw = score[1] === "cp" ? Number(score[2]) : Math.sign(Number(score[2])) * 9000;
					byPv.set(Number(pvIndex?.[1] || 1), {
						multipv: Number(pvIndex?.[1] || 1),
						cpWhite: sideToMove === "w" ? raw : -raw,
						move: pv[1].split(/\s+/)[0],
						pv: pv[1],
					});
				}
				return undefined;
			});

			const linesOut = [...byPv.values()].sort((a, b) => a.multipv - b.multipv);
			const top = linesOut[0] || { cpWhite: 0 };
			return {
				fen,
				sideToMove,
				depthReached: searchDepth,
				nps: 0,
				nodes: 0,
				bestMove: best === "(none)" ? null : best,
				lines: linesOut,
				cpWhite: top.cpWhite,
				evalText: (top.cpWhite / 100).toFixed(2),
				winPercentWhite: 50,
			};
		},
	};
}

const game = new Chess();
const moves = [];
for (const san of PGN.replace(/\d+\.\s*/g, "").split(/\s+/).filter(Boolean)) {
	if (moves.length >= maxPlies) {
		break;
	}
	try {
		const applied = game.move(san);
		moves.push(`${applied.from}${applied.to}${applied.promotion || ""}`);
	} catch {
		break;
	}
}

const engine = await createEngineAdapter();
const session = createSession({ engine, depth, reviewDepth, multiPV, playbackDelayMs: 0 });
session.loadLine(new Chess().fen(), moves);

if (!process.argv.includes("--json")) {
	console.log(`reviewing ${moves.length} plies`);
}
console.log(`  board depth ${depth}/${multiPV} lines · review depth ${reviewDepth}\n`);

const json = process.argv.includes("--json");
const started = Date.now();
await session.analysisController.scanMainlineClassifications();
const elapsed = (Date.now() - started) / 1000;

if (json) {
	process.stdout.write(`
__RESULT__${JSON.stringify({
		seconds: elapsed,
		searches: engine.calls.length,
		labels: session.state.moveClassifications.map((entry) => entry?.label || "?"),
	})}
`);
	process.exit(0);
}

const labels = session.state.moveClassifications.filter(Boolean).map((entry) => entry.label);
const tally = labels.reduce((acc, label) => ({ ...acc, [label]: (acc[label] || 0) + 1 }), {});

console.log(`  ${elapsed.toFixed(1)}s for ${moves.length} plies (${(elapsed / moves.length).toFixed(2)}s per move)`);
console.log(`  ${engine.calls.length} engine searches`);
console.log(`  labels: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ")}`);
process.exit(0);
