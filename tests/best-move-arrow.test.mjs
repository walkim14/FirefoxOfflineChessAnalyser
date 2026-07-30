// The best-move arrow must always describe the position on the board right
// now, never a neighbouring ply's analysis.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

const SHORT_PGN = `[Event "Test"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *`;

/**
 * Answers with a move that is unique to the position it was asked about, so a
 * misattributed answer is obvious rather than coincidentally plausible.
 */
export function bestMoveFor(fen) {
	const moves = new Chess(fen).moves({ verbose: true });
	if (moves.length === 0) {
		return null;
	}
	// Deterministic but position-dependent: rotate by piece count.
	const index = (fen.replace(/[^a-zA-Z]/g, "").length * 7) % moves.length;
	const move = moves[index];
	return `${move.from}${move.to}${move.promotion || ""}`;
}

class PositionAwareWorker {
	constructor() {
		this.onmessage = null;
		this.onerror = null;
		this.searching = false;
		this.fen = null;
		// A real search takes far longer than a microtask, which is what lets
		// intermediate renders read half-updated state.
		this.latencyMs = PositionAwareWorker.latencyMs;
	}

	postMessage(command) {
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
			setTimeout(() => this.finish(), this.latencyMs);
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

		const best = bestMoveFor(this.fen);
		if (!best) {
			this.emit("bestmove (none)");
			return;
		}
		this.emit(`info depth 12 seldepth 14 multipv 1 score cp 21 nodes 900 nps 40000 pv ${best}`);
		this.emit(`bestmove ${best}`);
	}

	emit(line) {
		if (this.onmessage) {
			this.onmessage({ data: line });
		}
	}

	terminate() {}
}

PositionAwareWorker.latencyMs = 25;

async function bootPage() {
	const html = readFileSync(join(appDir, "analyzer.html"), "utf8");
	const dom = new JSDOM(html, { url: "https://example.invalid/analyzer.html", pretendToBeVisual: true });
	const { window } = dom;
	const storage = {};

	window.chrome = {
		runtime: { getURL: (path) => `moz-extension://test/${path}`, lastError: null },
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

	const previous = {
		document: globalThis.document,
		window: globalThis.window,
		chrome: globalThis.chrome,
		Worker: globalThis.Worker,
		HTMLElement: globalThis.HTMLElement,
		location: Object.getOwnPropertyDescriptor(globalThis, "location"),
	};

	globalThis.document = window.document;
	globalThis.window = window;
	globalThis.chrome = window.chrome;
	globalThis.Worker = PositionAwareWorker;
	globalThis.HTMLElement = window.HTMLElement;
	Object.defineProperty(globalThis, "location", { value: window.location, configurable: true, writable: true });

	const app = await import(`../app/core/analyzer-app.mjs?arrow=${Math.random()}`);
	await app.bootstrapAnalyzerApp();

	const settle = async (ms = 300) => {
		for (let i = 0; i < 15; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(ms / 15))));
		}
	};

	return {
		window,
		document: window.document,
		settle,
		arrow: () => window.document.getElementById("board-overlay").getAttribute("data-best-move"),
		/** FEN the board is actually showing, read back from the rendered squares. */
		boardFen: () => {
			const board = new Chess();
			board.clear();
			for (const square of window.document.querySelectorAll("#board .square")) {
				const image = square.querySelector("img.piece");
				if (!image) {
					continue;
				}
				const [color, type] = image.getAttribute("alt").split("");
				board.put({ type, color }, square.dataset.square);
			}
			return board;
		},
		restore: () => {
			globalThis.document = previous.document;
			globalThis.window = previous.window;
			globalThis.chrome = previous.chrome;
			globalThis.Worker = previous.Worker;
			globalThis.HTMLElement = previous.HTMLElement;
			if (previous.location) {
				Object.defineProperty(globalThis, "location", previous.location);
			}
			dom.window.close();
		},
	};
}

const click = (page, selector) =>
	page.document.querySelector(selector).dispatchEvent(new page.window.Event("click"));

/** Waits out the whole-game scan that a PGN load kicks off. */
async function waitForScan(page, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const label = page.document.getElementById("scrubber-label").textContent;
		if (!label.startsWith("Loading")) {
			await page.settle(200);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("the whole-game scan never finished");
}

/** The arrow must start from a piece that is actually on the board. */
function assertArrowIsLegalHere(page, expectedFen, context) {
	const arrow = page.arrow();
	assert.ok(arrow, `no arrow drawn ${context}`);

	const legal = new Chess(expectedFen)
		.moves({ verbose: true })
		.map((move) => `${move.from}${move.to}${move.promotion || ""}`);
	assert.ok(
		legal.includes(arrow),
		`${context}: arrow ${arrow} is not a legal move in the displayed position (${expectedFen})`,
	);
	assert.equal(arrow, bestMoveFor(expectedFen), `${context}: arrow must be this position's best move`);
}

test("the arrow matches the current ply after a whole-game scan", async () => {
	const page = await bootPage();
	try {
		page.document.getElementById("pgn-input").value = SHORT_PGN;
		click(page, "#load-pgn-btn");
		await waitForScan(page);

		// Loading parks the board at the start; the scan restores that ply.
		assert.equal(page.document.getElementById("scrubber-label").textContent, "Move 0 / 6");
		assertArrowIsLegalHere(page, new Chess().fen(), "at the start of the scanned game");
	} finally {
		page.restore();
	}
});

test("the arrow follows navigation to an earlier ply", async () => {
	const page = await bootPage();
	try {
		page.document.getElementById("pgn-input").value = SHORT_PGN;
		click(page, "#load-pgn-btn");
		await waitForScan(page);

		click(page, "#move-list button[data-ply='3']");
		await page.settle(400);

		const game = new Chess();
		for (const san of ["e4", "e5", "Nf3"]) {
			game.move(san);
		}
		assertArrowIsLegalHere(page, game.fen(), "after seeking to ply 3");
	} finally {
		page.restore();
	}
});

test("the arrow describes the sideline position, not the ply it branched from", async () => {
	const page = await bootPage();
	try {
		page.document.getElementById("pgn-input").value = SHORT_PGN;
		click(page, "#load-pgn-btn");
		await waitForScan(page);

		// Branch: 1. e4 e5 2. Bc4 instead of 2. Nf3.
		click(page, "#move-list button[data-ply='2']");
		await page.settle(400);
		click(page, "#board .square[data-square='f1']");
		await page.settle(200);
		click(page, "#board .square[data-square='c4']");
		await page.settle(800);

		const game = new Chess();
		for (const san of ["e4", "e5", "Bc4"]) {
			game.move(san);
		}
		assertArrowIsLegalHere(page, game.fen(), "on the played sideline");
	} finally {
		page.restore();
	}
});

test("the arrow keeps up while walking deeper into a sideline", async () => {
	const page = await bootPage();
	try {
		page.document.getElementById("pgn-input").value = SHORT_PGN;
		click(page, "#load-pgn-btn");
		await waitForScan(page);

		click(page, "#move-list button[data-ply='2']");
		await page.settle(400);
		click(page, "#board .square[data-square='f1']");
		await page.settle(200);
		click(page, "#board .square[data-square='c4']");
		await page.settle(800);

		// Continue the sideline with 2...Nf6.
		click(page, "#board .square[data-square='g8']");
		await page.settle(200);
		click(page, "#board .square[data-square='f6']");
		await page.settle(800);

		const game = new Chess();
		for (const san of ["e4", "e5", "Bc4", "Nf6"]) {
			game.move(san);
		}
		assertArrowIsLegalHere(page, game.fen(), "two plies into the sideline");

		// And stepping back up the sideline re-points it.
		page.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		await page.settle(600);

		const parent = new Chess();
		for (const san of ["e4", "e5", "Bc4"]) {
			parent.move(san);
		}
		assertArrowIsLegalHere(page, parent.fen(), "after stepping back one ply in the sideline");
	} finally {
		page.restore();
	}
});

test("branching while the scan is still running still points at the sideline", async () => {
	const page = await bootPage();
	try {
		page.document.getElementById("pgn-input").value = SHORT_PGN;
		click(page, "#load-pgn-btn");
		// Deliberately do NOT wait: interrupt the scan mid-flight.
		await page.settle(150);

		click(page, "#move-list button[data-ply='2']");
		await page.settle(200);
		click(page, "#board .square[data-square='f1']");
		await page.settle(100);
		click(page, "#board .square[data-square='c4']");
		await page.settle(1200);

		const game = new Chess();
		for (const san of ["e4", "e5", "Bc4"]) {
			game.move(san);
		}
		assertArrowIsLegalHere(page, game.fen(), "branching out of a running scan");
	} finally {
		page.restore();
	}
});

test("two sideline moves in quick succession leave the arrow on the last one", async () => {
	const page = await bootPage();
	try {
		page.document.getElementById("pgn-input").value = SHORT_PGN;
		click(page, "#load-pgn-btn");
		await waitForScan(page);

		click(page, "#move-list button[data-ply='2']");
		await page.settle(300);

		// Play 2.Bc4 then 2...Nf6 without letting the first classification settle.
		click(page, "#board .square[data-square='f1']");
		click(page, "#board .square[data-square='c4']");
		await page.settle(30);
		click(page, "#board .square[data-square='g8']");
		click(page, "#board .square[data-square='f6']");
		await page.settle(1500);

		const game = new Chess();
		for (const san of ["e4", "e5", "Bc4", "Nf6"]) {
			game.move(san);
		}
		assertArrowIsLegalHere(page, game.fen(), "after two quick sideline moves");
	} finally {
		page.restore();
	}
});

test("no arrow is drawn once the game is over", async () => {
	const page = await bootPage();
	try {
		page.document.getElementById("fen-input").value =
			"rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
		click(page, "#load-fen-btn");
		await page.settle(500);

		assert.equal(page.arrow(), null, "a finished position has no best move to point at");
	} finally {
		page.restore();
	}
});
