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
		try {
			moves = new Chess(this.fen).moves({ verbose: true });
		} catch {
			moves = [];
		}
		if (!moves.length) {
			return this.emit("bestmove (none)");
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

const overrides = window.document.createElement("style");
overrides.textContent = `
	.bg-shape { display: none; }
	${forceTooltip ? "#overview-breakdown .overview-rows .overview-row:nth-child(2) .help-tooltip { opacity: 1 !important; visibility: visible !important; transform: translateY(0) !important; }" : ""}
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
		const bubble = scope.querySelector(".overview-rows .overview-row:nth-child(2) .help-bubble");
		if (bubble) {
			const anchor = bubble.closest(".overview-row");
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
