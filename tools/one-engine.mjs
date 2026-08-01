// One engine, one process: the unit a browser Worker corresponds to.
// Reads {depth, hash, fens} as JSON on argv, prints elapsed ms.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const initEngine = require("stockfish");

const job = JSON.parse(process.argv[2]);
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
			if (predicate(line)) {
				listeners.splice(listeners.indexOf(listener), 1);
				resolve();
			}
		};
		listeners.push(listener);
	});

send("uci");
await waitFor((line) => line === "uciok");
send(`setoption name Hash value ${job.hash}`);
send("setoption name UCI_AnalyseMode value true");
send("setoption name MultiPV value 2");

process.send?.("ready");
await new Promise((resolve) => process.once("message", resolve));

const started = Date.now();
for (const fen of job.fens) {
	send(`position fen ${fen}`);
	send(`go depth ${job.depth}`);
	await waitFor((line) => line.startsWith("bestmove"));
}
process.send?.({ ms: Date.now() - started });
process.exit(0);
