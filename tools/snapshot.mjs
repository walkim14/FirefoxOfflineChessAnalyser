// Renders the real analyzer page to a PNG so UI changes can be looked at.
//
//   node tools/snapshot.mjs <out.png> [--mode cp|ep] [--force-tooltip] [--clip selector]
//
// Boots app/analyzer.html in jsdom against a fake engine, plays a short game so
// the panels have content, then serialises the live DOM next to the real
// stylesheet and screenshots it with headless Edge.
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const PGN = `[Event "Snapshot"]
[White "Kasparov"]
[Black "Topalov"]
[WhiteElo "2812"]
[BlackElo "2700"]
[Result "1-0"]

1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Be3 Bg7 5. Qd2 c6 6. f3 b5 7. Nge2 Nbd7
8. Bh6 Bxh6 9. Qxh6 Bb7 10. a3 e5 11. O-O-O Qe7 1-0`;

class FakeWorker {
	constructor() {
		this.onmessage = null;
		this.onerror = null;
		this.searching = false;
		this.fen = null;
	}

	postMessage(command) {
		if (command === "uci") {
			return this.emit("uciok");
		}
		if (command === "isready") {
			return this.emit("readyok");
		}
		if (command.startsWith("position fen ")) {
			this.fen = command.slice("position fen ".length);
			return undefined;
		}
		if (/^go\b/.test(command)) {
			this.searching = true;
			queueMicrotask(() => this.finish());
			return undefined;
		}
		if (command === "stop") {
			return this.finish();
		}
		return undefined;
	}

	finish() {
		if (!this.searching) {
			return;
		}
		this.searching = false;

		let moves = [];
		let sideToMove = "w";
		try {
			const game = new Chess(this.fen);
			sideToMove = game.turn();
			moves = game.moves({ verbose: true });
		} catch {
			moves = [];
		}
		if (!moves.length) {
			return this.emit("bestmove (none)");
		}

		// `--traps` needs specific evaluations rather than the hashed spread below.
		if (FakeWorker.scores) {
			const positionKey = this.fen.trim().split(/\s+/).slice(0, 4).join(" ");
			const cpWhite = FakeWorker.scores[positionKey] ?? 20;
			const move = moves[0];
			this.emit(
				`info depth 18 seldepth 22 multipv 1 score cp ${sideToMove === "w" ? cpWhite : -cpWhite} nodes 120000 nps 900000 pv ${move.from}${move.to}`,
			);
			return this.emit(`bestmove ${move.from}${move.to}`);
		}

		// Hash the position to a wide eval range so consecutive plies differ a
		// lot and every classification band gets exercised.
		let hash = 0;
		for (const ch of this.fen) {
			hash = (hash * 31 + ch.charCodeAt(0)) % 100000;
		}
		const seed = hash;
		const base = ((hash % 1400) - 700);
		for (let pv = 1; pv <= Math.min(3, moves.length); pv += 1) {
			const move = moves[(seed * pv * 5) % moves.length];
			const cp = base - (pv - 1) * 60;
			this.emit(
				`info depth 18 seldepth 22 multipv ${pv} score cp ${cp} nodes 120000 nps 900000 pv ${move.from}${move.to}`,
			);
		}
		const best = moves[(seed * 5) % moves.length];
		return this.emit(`bestmove ${best.from}${best.to}`);
	}

	emit(line) {
		if (this.onmessage) {
			this.onmessage({ data: line });
		}
	}

	terminate() {}
}

const args = process.argv.slice(2);
const outPath = resolve(args[0] || join(root, "snapshot.png"));
const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "cp";
const forceTooltip = args.includes("--force-tooltip");
const clip = args.includes("--clip") ? args[args.indexOf("--clip") + 1] : null;

const html = readFileSync(join(appDir, "analyzer.html"), "utf8");
const dom = new JSDOM(html, { url: "https://example.invalid/analyzer.html", pretendToBeVisual: true });
const { window } = dom;
const storage = {};

window.chrome = {
	// Relative so the dumped page resolves real art from app/.
	runtime: { getURL: (path) => `../${path}`, lastError: null },
	storage: {
		local: {
			get: (key, callback) => callback(key in storage ? { [key]: storage[key] } : {}),
			set: (value, callback) => {
				Object.assign(storage, value);
				callback();
			},
		},
	},
};

globalThis.document = window.document;
globalThis.window = window;
globalThis.chrome = window.chrome;
globalThis.Worker = FakeWorker;
globalThis.HTMLElement = window.HTMLElement;
Object.defineProperty(globalThis, "location", { value: window.location, configurable: true, writable: true });

const app = await import(`../app/core/analyzer-app.mjs?snapshot=${Date.now()}`);
await app.bootstrapAnalyzerApp();

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// `--traps` runs a real trap search against a stubbed explorer, so the panel can
// be looked at with results in it.
if (args.includes("--traps")) {
	const TRAP_ROOT = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
	const key = (fen) => String(fen).trim().split(/\s+/).slice(0, 4).join(" ");
	const played = (fen, uci) => {
		const game = new Chess(fen);
		game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
		return game.fen();
	};
	const afterBc4 = played(TRAP_ROOT, "f1c4");
	const afterNf3 = played(TRAP_ROOT, "g1f3");
	const split = (total) => ({ white: Math.round(total * 0.52), draws: Math.round(total * 0.08), black: total - Math.round(total * 0.52) - Math.round(total * 0.08) });
	const mv = (uci, san, total) => ({ uci, san, ...split(total) });

	const stats = {
		[key(TRAP_ROOT)]: { ...split(184_000), opening: { eco: "C20", name: "King's Pawn Game" }, moves: [mv("g1f3", "Nf3", 96_000), mv("f1c4", "Bc4", 41_000), mv("b1c3", "Nc3", 22_000)] },
		[key(afterBc4)]: { ...split(41_000), opening: { eco: "C23", name: "Bishop's Opening" }, moves: [mv("g8f6", "Nf6", 19_000), mv("b8c6", "Nc6", 11_000), mv("f8c5", "Bc5", 6000), mv("d7d5", "d5", 5000)] },
		[key(afterNf3)]: { ...split(96_000), opening: { eco: "C40", name: "King's Knight Opening" }, moves: [mv("b8c6", "Nc6", 62_000), mv("d7d6", "d6", 21_000), mv("f7f6", "f6", 13_000)] },
	};
	const scores = {
		[key(TRAP_ROOT)]: 28,
		[key(afterBc4)]: 25,
		[key(afterNf3)]: 30,
		[key(played(afterBc4, "g8f6"))]: 20,
		[key(played(afterBc4, "b8c6"))]: 25,
		[key(played(afterBc4, "f8c5"))]: 30,
		[key(played(afterBc4, "d7d5"))]: 380,
		[key(played(afterNf3, "b8c6"))]: 30,
		[key(played(afterNf3, "d7d6"))]: 45,
		[key(played(afterNf3, "f7f6"))]: 260,
	};

	FakeWorker.scores = scores;
	globalThis.fetch = async (url) => ({
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => stats[key(new URL(url).searchParams.get("fen"))] || { white: 0, draws: 0, black: 0, moves: [], opening: null },
	});

	window.document.getElementById("fen-input").value = TRAP_ROOT;
	window.document.getElementById("load-fen-btn").dispatchEvent(new window.Event("click"));
	await wait(400);

	window.document.getElementById("trap-token-input").value = "lip_snapshot";
	window.document.getElementById("find-traps-btn").dispatchEvent(new window.Event("click"));
	for (let i = 0; i < 600; i += 1) {
		if (window.document.querySelector("#trap-results .trap-card")) {
			break;
		}
		await wait(50);
	}
	await wait(200);

	// The panel ships collapsed; open it for the screenshot.
	const card = window.document.getElementById("trap-finder-card");
	card.classList.remove("collapsed");
	card.querySelector("[data-collapsible-toggle]").setAttribute("aria-expanded", "true");
	window.document.getElementById("side-panel").classList.remove("collapsed");
} else {

window.document.getElementById("pgn-input").value = PGN;
window.document.getElementById("load-pgn-btn").dispatchEvent(new window.Event("click"));

for (let i = 0; i < 400; i += 1) {
	if (!window.document.getElementById("scrubber-label").textContent.startsWith("Loading")) {
		break;
	}
	await wait(25);
}
await wait(400);

// Park on a mid-game move so the classification panel has something to show.
{ const sc = window.document.getElementById("timeline-scrubber"); sc.value = "16"; sc.dispatchEvent(new window.Event("input", { bubbles: true })); }
await wait(400);

if (mode === "ep") {
	window.document.getElementById("eval-mode-btn").dispatchEvent(new window.Event("click"));
	await wait(200);
}

// Sidebar starts collapsed after a PGN load; open it for the screenshot.
const sidePanel = window.document.getElementById("side-panel");
sidePanel.classList.remove("collapsed");

}

// jsdom keeps a select's choice as a property; both `cloneNode` (below, for
// --clip) and serialising to HTML carry only the `selected` attribute, so
// without this every dropdown screenshots as its first option.
for (const select of window.document.querySelectorAll("select")) {
	for (const option of select.options) {
		option.toggleAttribute("selected", option.value === select.value);
	}
}

const overrides = window.document.createElement("style");
overrides.textContent = `
	.bg-shape { display: none; }
	${forceTooltip ? (process.argv.includes("--setting-tooltip") ? "#review-depth-input" : "#overview-breakdown .overview-rows .overview-row:nth-child(2)").replace(/^#review-depth-input$/, ".setting-row:nth-child(2)") + " .help-tooltip { opacity: 1 !important; visibility: visible !important; transform: translateY(0) !important; }" : ""}
	${clip ? `body > *:not(#__clip) { display: none !important; }` : ""}
`;
window.document.head.appendChild(overrides);

if (clip) {
	const target = window.document.querySelector(clip);
	if (!target) {
		throw new Error(`--clip selector matched nothing: ${clip}`);
	}
	const holder = window.document.createElement("div");
	holder.id = "__clip";
	const zoom = args.includes("--zoom") ? Number(args[args.indexOf("--zoom") + 1]) : 1;
	const height = args.includes("--height") ? args[args.indexOf("--height") + 1] : "auto";
	holder.style.cssText = [
		"padding:24px",
		"width:420px",
		`height:${height}`,
		"display:flex",
		"gap:28px",
		"align-items:stretch",
		zoom !== 1 ? `zoom:${zoom}` : "",
	].filter(Boolean).join(";");
	const clone = target.cloneNode(true);
	clone.style.flex = "1 1 auto";
	clone.style.minWidth = "0";
	holder.appendChild(clone);
	window.document.body.appendChild(holder);
}

// jsdom has no layout, so the arrow offset is measured in the browser instead.
if (forceTooltip) {
	const script = window.document.createElement("script");
	script.textContent = `
		const scope = document.getElementById("__clip") || document;
		const bubble = scope.querySelector(".overview-rows .overview-row:nth-child(2) .help-bubble") || scope.querySelector(".setting-row:nth-child(2) .help-bubble");
		if (bubble) {
			const anchor = bubble.closest(".overview-row, .setting-row");
			const b = bubble.getBoundingClientRect();
			const a = anchor.getBoundingClientRect();
			anchor.style.setProperty("--help-arrow-x", Math.round(b.left + b.width / 2 - a.left) + "px");
		}
	`;
	window.document.body.appendChild(script);
}

const previewPath = join(appDir, "__snapshot.html");
writeFileSync(previewPath, `<!doctype html>\n${window.document.documentElement.outerHTML}`, "utf8");

try {
	execFileSync(
		EDGE,
		[
			"--headless",
			"--disable-gpu",
			"--hide-scrollbars",
			`--screenshot=${outPath}`,
			`--window-size=${clip ? "560,900" : "1500,1180"}`,
			previewPath,
		],
		{ stdio: "ignore" },
	);
} finally {
	if (existsSync(previewPath)) {
		unlinkSync(previewPath);
	}
}

console.log(`wrote ${outPath}`);
process.exit(0);
