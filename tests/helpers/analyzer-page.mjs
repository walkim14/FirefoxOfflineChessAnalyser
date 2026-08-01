// Boots the real `analyzer.html` + `analyzer-app.mjs` in jsdom against a fake
// Stockfish worker. This is the closest thing to loading the extension page:
// it catches broken DOM wiring, missing element ids and runtime errors that
// unit tests over the controllers cannot see.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");
const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "..", "app");

/** The explorer keys by position, so tests can too. */
export function fenKey(fen) {
	return String(fen).trim().split(/\s+/).slice(0, 4).join(" ");
}

/**
 * A worker that answers every search instantly with a plausible line.
 *
 * `scores` maps a position (see `fenKey`) to a centipawn score from White's
 * side, so a test can hand the engine an opinion where it needs one. Anything
 * not listed evaluates as equal.
 */
export class FakeStockfishWorker {
	constructor() {
		this.onmessage = null;
		this.onerror = null;
		this.searching = false;
		this.commands = [];
		FakeStockfishWorker.instances.push(this);
	}

	postMessage(command) {
		this.commands.push(command);
		if (command === "uci") {
			this.emit("uciok");
			return;
		}
		if (command === "isready") {
			this.emit("readyok");
			return;
		}
		if (command.startsWith("position fen ")) {
			this.fen = command.slice("position fen ".length);
			return;
		}
		if (/^go\b/.test(command)) {
			this.searching = true;
			queueMicrotask(() => this.finish());
			return;
		}
		if (command === "stop" && this.searching) {
			this.finish();
		}
	}

	finish() {
		if (!this.searching) {
			return;
		}
		this.searching = false;

		let move = "e2e4";
		let sideToMove = "w";
		try {
			const game = new Chess(this.fen);
			sideToMove = game.turn();
			const moves = game.moves({ verbose: true });
			if (moves.length === 0) {
				this.emit("bestmove (none)");
				return;
			}
			move = `${moves[0].from}${moves[0].to}${moves[0].promotion || ""}`;
		} catch {
			// Fall back to the placeholder move.
		}

		const cpWhite = FakeStockfishWorker.scores[fenKey(this.fen)] ?? 24;
		// UCI scores are from the side to move; the client converts back.
		const cpRaw = sideToMove === "w" ? cpWhite : -cpWhite;

		this.emit(`info depth 12 seldepth 14 multipv 1 score cp ${cpRaw} nodes 1000 nps 50000 pv ${move}`);
		this.emit(`bestmove ${move}`);
	}

	emit(line) {
		if (this.onmessage) {
			this.onmessage({ data: line });
		}
	}

	terminate() {}
}

FakeStockfishWorker.instances = [];
FakeStockfishWorker.scores = {};

/**
 * @param {object} [options]
 * @param {Record<string, number>} [options.scores] per-position evaluations
 * @param {Function} [options.fetchImpl] stands in for the network
 */
export async function bootAnalyzerPage({ scores = {}, fetchImpl = null } = {}) {
	const html = readFileSync(join(appDir, "analyzer.html"), "utf8");
	const dom = new JSDOM(html, { url: "https://example.invalid/analyzer.html", pretendToBeVisual: true });
	const { window } = dom;

	const storage = {};
	const errors = [];

	FakeStockfishWorker.instances.length = 0;
	FakeStockfishWorker.scores = scores;
	window.Worker = FakeStockfishWorker;
	window.chrome = {
		runtime: { getURL: (path) => `moz-extension://test/${path}`, lastError: null },
		storage: {
			local: {
				get(key, callback) {
					const result = key in storage ? { [key]: storage[key] } : {};
					callback(result);
				},
				set(value, callback) {
					Object.assign(storage, value);
					callback();
				},
			},
		},
	};

	// The app module reads these off the global scope, not off `window`.
	const previous = {
		document: globalThis.document,
		window: globalThis.window,
		chrome: globalThis.chrome,
		Worker: globalThis.Worker,
		HTMLElement: globalThis.HTMLElement,
		fetch: globalThis.fetch,
		location: Object.getOwnPropertyDescriptor(globalThis, "location"),
	};

	globalThis.document = window.document;
	globalThis.window = window;
	globalThis.chrome = window.chrome;
	globalThis.Worker = FakeStockfishWorker;
	globalThis.HTMLElement = window.HTMLElement;
	if (fetchImpl) {
		globalThis.fetch = fetchImpl;
	}
	Object.defineProperty(globalThis, "location", { value: window.location, configurable: true, writable: true });

	window.addEventListener("error", (event) => errors.push(event.error || event.message));

	// Cache-bust so each test gets a fresh module instance with fresh state.
	const app = await import(`../../app/core/analyzer-app.mjs?boot=${FakeStockfishWorker.instances.length}-${Math.random()}`);
	await app.bootstrapAnalyzerApp();

	const restore = () => {
		globalThis.document = previous.document;
		globalThis.window = previous.window;
		globalThis.chrome = previous.chrome;
		globalThis.Worker = previous.Worker;
		globalThis.HTMLElement = previous.HTMLElement;
		globalThis.fetch = previous.fetch;
		if (previous.location) {
			Object.defineProperty(globalThis, "location", previous.location);
		}
		dom.window.close();
	};

	const settle = async (ms = 60) => {
		for (let i = 0; i < 12; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(ms / 12))));
		}
	};

	return { dom, window, document: window.document, errors, restore, settle, storage };
}

export const id = (doc, elementId) => doc.getElementById(elementId);
