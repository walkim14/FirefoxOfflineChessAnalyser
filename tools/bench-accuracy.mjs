// How much classification accuracy does a shallower review cost?
//
//   node tools/bench-accuracy.mjs [--truth 22] [--candidates 18,16,14] [--plies 24]
//
// Scores each candidate review depth against a deep run of the same game, per
// move rather than by label counts. The metric that matters is not exact
// agreement — swapping Excellent for Good is noise — but whether a move lands
// on the right side of the line a player would act on.
//
// Each run is a fresh process so the engine's transposition table cannot carry
// over and flatter whichever run happens to go second.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Anything from here down is a move the player would want flagged. */
const COSTLY = new Set(["Inaccuracy", "Miss", "Mistake", "Blunder"]);

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const truthDepth = Number(arg("--truth", "22"));
const candidates = String(arg("--candidates", "18,16,14")).split(",").map(Number);
const plies = arg("--plies", "24");
const game = arg("--game", "quiet");

function review(reviewDepth) {
	const out = execFileSync(
		process.execPath,
		[join(root, "tools", "bench-scan.mjs"), "--depth", "22", "--review", String(reviewDepth), "--lines", "3", "--plies", String(plies), "--game", game, "--json"],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	const marker = out.lastIndexOf("__RESULT__");
	if (marker === -1) {
		throw new Error(`no result from review at depth ${reviewDepth}`);
	}
	return JSON.parse(out.slice(marker + "__RESULT__".length).trim());
}

console.log(`${game} game · ground truth at depth ${truthDepth}, ${plies} plies
`);
const truth = review(truthDepth);
console.log(`depth ${truthDepth} (truth)  ${truth.seconds.toFixed(1)}s  ${truth.searches} searches
`);

for (const depth of candidates) {
	const run = review(depth);
	let same = 0;
	let missed = 0;
	let invented = 0;
	const drift = [];

	run.labels.forEach((label, index) => {
		const expected = truth.labels[index];
		if (label === expected) {
			same += 1;
			return;
		}
		drift.push(`${Math.floor(index / 2) + 1}${index % 2 ? "..." : "."} ${expected}->${label}`);
		if (COSTLY.has(expected) && !COSTLY.has(label)) {
			missed += 1;
		}
		if (!COSTLY.has(expected) && COSTLY.has(label)) {
			invented += 1;
		}
	});

	console.log(
		`depth ${String(depth).padStart(2)}  ${run.seconds.toFixed(1).padStart(6)}s  ` +
			`${(truth.seconds / run.seconds).toFixed(1)}x faster  ` +
			`${((same / run.labels.length) * 100).toFixed(0).padStart(3)}% identical  ` +
			`${missed} missed, ${invented} invented`,
	);
	if (drift.length) {
		console.log(`          ${drift.join(", ")}`);
	}
}
