// Measures whole-game scan cost against the engine the extension actually
// ships (stockfish-18-lite-single, the same build as engine/*.wasm).
//
//   node tools/bench.mjs [--plies 16] [--profiles "22/3,18/3,18/1,16/1"]
//
// Reports wall time per position and the projected time for a full game, which
// is the number a user feels when they load a PGN.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const initEngine = require("stockfish");

// Kasparov–Topalov, Wijk aan Zee 1999. A sharp middlegame is the honest case:
// quiet positions resolve far faster than tactical ones.
const PGN = `1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Be3 Bg7 5. Qd2 c6 6. f3 b5 7. Nge2 Nbd7
8. Bh6 Bxh6 9. Qxh6 Bb7 10. a3 e5 11. O-O-O Qe7 12. Kb1 a6 13. Nc1 O-O-O
14. Nb3 exd4 15. Rxd4 c5 16. Rd1 Nb6 17. g3 Kb8 18. Na5 Ba8 19. Bh3 d5
20. Qf4+ Ka7 21. Rhe1 d4 22. Nd5 Nbxd5 23. exd5 Qd6 24. Rxd4 cxd4 25. Re7+`;

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const maxPlies = Number(arg("--plies", "16"));
const profiles = String(arg("--profiles", "22/3,20/2,18/1,16/1,14/1"))
	.split(",")
	.map((entry) => {
		const [depth, multiPV] = entry.split("/").map(Number);
		return { depth, multiPV };
	});

async function startEngine() {
	// "lite-single" is the same build the extension ships in engine/.
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
	await waitFor((line) => line === "uciok");
	return { send, waitFor };
}

/** One search, returning wall time and the nodes the engine reported. */
async function search({ send, waitFor }, fen, depth, multiPV) {
	send(`setoption name MultiPV value ${multiPV}`);
	send(`position fen ${fen}`);
	let nodes = 0;
	const started = process.hrtime.bigint();
	send(`go depth ${depth}`);
	await waitFor((line) => {
		const match = line.match(/\bnodes\s+(\d+)/);
		if (match) {
			nodes = Math.max(nodes, Number(match[1]));
		}
		return line.startsWith("bestmove") ? true : undefined;
	});
	return { ms: Number(process.hrtime.bigint() - started) / 1e6, nodes };
}

const game = new Chess();
const fens = [game.fen()];
for (const san of PGN.replace(/\d+\.\s*/g, "").split(/\s+/).filter(Boolean)) {
	try {
		game.move(san);
	} catch {
		break;
	}
	fens.push(game.fen());
}

const positions = fens.slice(0, maxPlies + 1);
const fullGamePlies = fens.length - 1;

console.log(`engine   stockfish-18-lite-single (single thread)`);
console.log(`sampling ${positions.length} positions of a ${fullGamePlies}-ply game\n`);

const engine = await startEngine();
engine.send("setoption name Hash value 128");
engine.send("setoption name Threads value 1");
engine.send("setoption name UCI_AnalyseMode value true");

const results = [];
for (const profile of profiles) {
	// A fresh table per profile keeps one run from flattering the next.
	engine.send("ucinewgame");
	engine.send("isready");
	await engine.waitFor((line) => (line === "readyok" ? true : undefined));

	let totalMs = 0;
	let totalNodes = 0;
	for (const fen of positions) {
		const { ms, nodes } = await search(engine, fen, profile.depth, profile.multiPV);
		totalMs += ms;
		totalNodes += nodes;
	}

	const perPosition = totalMs / positions.length;
	// The scan runs one search per ply plus one for the starting position.
	const projected = (perPosition * (fullGamePlies + 1)) / 1000;
	results.push({ profile, perPosition, projected, totalNodes });
	console.log(
		`depth ${String(profile.depth).padStart(2)} / ${profile.multiPV} line(s)` +
			`  ${perPosition.toFixed(0).padStart(6)} ms/position` +
			`  ${projected.toFixed(1).padStart(6)} s for the game` +
			`  ${(totalNodes / 1e6).toFixed(1)}M nodes`,
	);
}

const baseline = results[0];
console.log("");
for (const entry of results.slice(1)) {
	const speedup = baseline.perPosition / entry.perPosition;
	console.log(
		`depth ${String(entry.profile.depth).padStart(2)}/${entry.profile.multiPV} is ` +
			`${speedup.toFixed(1)}x faster than depth ${baseline.profile.depth}/${baseline.profile.multiPV}` +
			`  (${baseline.projected.toFixed(0)}s -> ${entry.projected.toFixed(0)}s)`,
	);
}

process.exit(0);
