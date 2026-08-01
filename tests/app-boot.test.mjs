// Boots the real `analyzer.html` + `analyzer-app.mjs` in jsdom against a fake
// Stockfish worker. This is the closest thing to loading the extension page:
// it catches broken DOM wiring, missing element ids and runtime errors that
// unit tests over the controllers cannot see.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");
const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "app");

const SHORT_PGN = `[Event "Test"]
[White "Alice"]
[Black "Bob"]
[WhiteElo "1500"]
[BlackElo "1700"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *`;

/** A worker that answers every search instantly with a plausible line. */
class FakeStockfishWorker {
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
		try {
			const moves = new Chess(this.fen).moves({ verbose: true });
			if (moves.length === 0) {
				this.emit("bestmove (none)");
				return;
			}
			move = `${moves[0].from}${moves[0].to}${moves[0].promotion || ""}`;
		} catch {
			// Fall back to the placeholder move.
		}

		this.emit(`info depth 12 seldepth 14 multipv 1 score cp 24 nodes 1000 nps 50000 pv ${move}`);
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

async function bootAnalyzerPage() {
	const html = readFileSync(join(appDir, "analyzer.html"), "utf8");
	const dom = new JSDOM(html, { url: "https://example.invalid/analyzer.html", pretendToBeVisual: true });
	const { window } = dom;

	const storage = {};
	const errors = [];

	FakeStockfishWorker.instances.length = 0;
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
		location: Object.getOwnPropertyDescriptor(globalThis, "location"),
	};

	globalThis.document = window.document;
	globalThis.window = window;
	globalThis.chrome = window.chrome;
	globalThis.Worker = FakeStockfishWorker;
	globalThis.HTMLElement = window.HTMLElement;
	Object.defineProperty(globalThis, "location", { value: window.location, configurable: true, writable: true });

	window.addEventListener("error", (event) => errors.push(event.error || event.message));

	// Cache-bust so each test gets a fresh module instance with fresh state.
	const app = await import(`../app/core/analyzer-app.mjs?boot=${FakeStockfishWorker.instances.length}-${Math.random()}`);
	await app.bootstrapAnalyzerApp();

	const restore = () => {
		globalThis.document = previous.document;
		globalThis.window = previous.window;
		globalThis.chrome = previous.chrome;
		globalThis.Worker = previous.Worker;
		globalThis.HTMLElement = previous.HTMLElement;
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

/** Navigate to a ply through the timeline scrubber; the move list is gone. */
function seek(page, ply) {
	const scrubber = page.document.getElementById("timeline-scrubber");
	scrubber.value = String(ply);
	scrubber.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}

/** The SAN of every move chip currently rendered in the tree. */
function treeMoves(page) {
	return [...page.document.querySelectorAll("#tree-path button[data-tree-action='jump-node']")]
		.map((button) => button.querySelector(".tree-chip-move").textContent.trim());
}

const id = (doc, elementId) => doc.getElementById(elementId);

test("the analyzer page boots, renders a board and analyses the start position", async () => {
	const page = await bootAnalyzerPage();
	try {
		await page.settle();

		const squares = page.document.querySelectorAll("#board .square");
		assert.equal(squares.length, 64, "the board must render 64 squares");

		// 32 pieces on the initial position.
		assert.equal(page.document.querySelectorAll("#board img.piece").length, 32);

		const status = id(page.document, "status").textContent;
		assert.match(status, /to move · [+-]?\d/, `unexpected status: ${status}`);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);

		// The engine actually received a configured search.
		const worker = FakeStockfishWorker.instances[0];
		assert.ok(worker.commands.includes("setoption name Hash value 128"), "hash setting must reach the engine");
		assert.ok(worker.commands.some((command) => command.startsWith("go depth ")));
	} finally {
		page.restore();
	}
});

test("loading a PGN populates the tree, scrubber and player strips", async () => {
	const page = await bootAnalyzerPage();
	try {
		id(page.document, "pgn-input").value = SHORT_PGN;
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(400);

		assert.deepEqual(treeMoves(page), ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"], "every ply must reach the tree");

		assert.match(id(page.document, "player-bottom").textContent, /Alice \(1500\)/);
		assert.match(id(page.document, "player-top").textContent, /Bob \(1700\)/);

		assert.equal(id(page.document, "timeline-scrubber").max, "6");
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("clicking two squares plays a live move and branches the loaded game", async () => {
	const page = await bootAnalyzerPage();
	try {
		id(page.document, "pgn-input").value = SHORT_PGN;
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(500);

		// Jump to the position after 1.e4 e5, then play 2.Bc4 instead of 2.Nf3.
		seek(page, 2);
		await page.settle();

		const click = (square) =>
			page.document.querySelector(`#board .square[data-square='${square}']`)
				.dispatchEvent(new page.window.Event("click"));

		click("f1");
		await page.settle();
		assert.ok(
			page.document.querySelectorAll("#board .square.target").length > 0,
			"selecting a piece must highlight its legal targets",
		);

		click("c4");
		await page.settle(500);

		assert.equal(id(page.document, "timeline-scrubber").max, "3", "the branch replaces the rest of the line");
		assert.equal(id(page.document, "scrubber-label").textContent, "Move 3 / 3");
		assert.ok(treeMoves(page).includes("Bc4"), `expected Bc4 in the tree: ${treeMoves(page).join(" ")}`);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);

		// The classification panel reports the played move rather than staying empty.
		const pill = id(page.document, "classification-pill").textContent;
		assert.match(pill, /EP loss/, `unexpected classification pill: ${pill}`);
	} finally {
		page.restore();
	}
});

test("the move tree shows a played variation and folds it away again", async () => {
	const page = await bootAnalyzerPage();
	try {
		id(page.document, "pgn-input").value = SHORT_PGN;
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(500);

		const chipText = () =>
			[...page.document.querySelectorAll("#tree-path button[data-tree-action='jump-node']")]
				.map((button) => button.querySelector(".tree-chip-move").textContent.trim());

		assert.deepEqual(chipText(), ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"], "the tree reads as notation, not UCI");

		// Branch off with 2.Bc4 instead of the game's 2.Nf3.
		seek(page, 2);
		await page.settle();
		page.document.querySelector("#board .square[data-square='f1']").dispatchEvent(new page.window.Event("click"));
		await page.settle();
		page.document.querySelector("#board .square[data-square='c4']").dispatchEvent(new page.window.Event("click"));
		await page.settle(500);

		assert.ok(chipText().includes("Bc4"), `the played variation must be visible: ${chipText().join(" ")}`);
		const toggle = page.document.querySelector("#tree-path button[data-tree-action='toggle-variations']");
		assert.ok(toggle, "a variation toggle must exist");
		assert.equal(toggle.getAttribute("aria-expanded"), "true");
		assert.match(toggle.textContent, /1 line/);

		// The current chip is the move just played.
		const current = page.document.querySelector("#tree-path .tree-chip.current");
		assert.equal(current.querySelector(".tree-chip-move").textContent.trim(), "Bc4");

		// Stepping back onto the loaded game folds the variation away again.
		seek(page, 1);
		await page.settle(300);
		assert.ok(!chipText().includes("Bc4"), "an off-path variation collapses");
		assert.equal(
			page.document.querySelector("#tree-path button[data-tree-action='toggle-variations']")
				.getAttribute("aria-expanded"),
			"false",
		);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("the variation toggle expands and collapses on click", async () => {
	const page = await bootAnalyzerPage();
	try {
		id(page.document, "pgn-input").value = SHORT_PGN;
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(500);

		seek(page, 2);
		await page.settle();
		page.document.querySelector("#board .square[data-square='f1']").dispatchEvent(new page.window.Event("click"));
		await page.settle();
		page.document.querySelector("#board .square[data-square='c4']").dispatchEvent(new page.window.Event("click"));
		await page.settle(500);

		// Move off the variation so the toggle reflects user intent rather than the path.
		seek(page, 1);
		await page.settle(300);

		const findToggle = () => page.document.querySelector("#tree-path button[data-tree-action='toggle-variations']");
		assert.equal(findToggle().getAttribute("aria-expanded"), "false");

		findToggle().dispatchEvent(new page.window.Event("click"));
		await page.settle();
		assert.equal(findToggle().getAttribute("aria-expanded"), "true");
		assert.ok(
			[...page.document.querySelectorAll("#tree-path button[data-tree-action='jump-node']")]
				.some((button) => button.querySelector(".tree-chip-move").textContent.trim() === "Bc4"),
		);

		findToggle().dispatchEvent(new page.window.Event("click"));
		await page.settle();
		assert.equal(findToggle().getAttribute("aria-expanded"), "false");
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("clicking a tree chip navigates to that node", async () => {
	const page = await bootAnalyzerPage();
	try {
		id(page.document, "pgn-input").value = SHORT_PGN;
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(500);

		const chip = [...page.document.querySelectorAll("#tree-path button[data-tree-action='jump-node']")]
			.find((button) => button.querySelector(".tree-chip-move").textContent.trim() === "Bb5");
		assert.ok(chip, "Bb5 must be in the tree");

		chip.dispatchEvent(new page.window.Event("click"));
		await page.settle(300);

		assert.equal(id(page.document, "scrubber-label").textContent, "Move 5 / 6");
		assert.equal(
			page.document.querySelector("#tree-path .tree-chip.current .tree-chip-move").textContent.trim(),
			"Bb5",
		);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("flip, eval mode and reset controls stay functional after a game is loaded", async () => {
	const page = await bootAnalyzerPage();
	try {
		id(page.document, "pgn-input").value = SHORT_PGN;
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(400);

		const firstSquare = () => page.document.querySelector("#board .square").dataset.square;
		assert.equal(firstSquare(), "a8", "white at the bottom puts a8 first");

		id(page.document, "flip-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle();
		assert.equal(firstSquare(), "h1", "flipping must re-render the board from black's side");
		assert.ok(id(page.document, "eval-bar").classList.contains("flipped"));

		id(page.document, "eval-mode-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle();
		assert.equal(id(page.document, "eval-mode-btn").textContent, "Eval: win %");
		assert.ok(id(page.document, "eval-bar").classList.contains("ep-mode"));

		id(page.document, "reset-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(200);
		assert.deepEqual(treeMoves(page), [], "resetting clears the tree");
		assert.match(id(page.document, "status").textContent, /reset|to move/i);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("keyboard navigation walks the loaded line", async () => {
	const page = await bootAnalyzerPage();
	try {
		id(page.document, "pgn-input").value = SHORT_PGN;
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(400);

		const press = (key) =>
			page.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key, bubbles: true }));

		press("Home");
		await page.settle();
		assert.equal(id(page.document, "scrubber-label").textContent, "Move 0 / 6");

		press("ArrowRight");
		await page.settle();
		assert.equal(id(page.document, "scrubber-label").textContent, "Move 1 / 6");

		press("End");
		await page.settle();
		assert.equal(id(page.document, "scrubber-label").textContent, "Move 6 / 6");

		press("ArrowLeft");
		await page.settle();
		assert.equal(id(page.document, "scrubber-label").textContent, "Move 5 / 6");
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("analysing a game never scrolls the page", async () => {
	const page = await bootAnalyzerPage();
	try {
		// `scrollIntoView` scrolls every scrollable ancestor including the
		// document, so rendering must never reach for it: during a whole-game
		// scan the page walked itself down on every ply.
		let scrollIntoViewCalls = 0;
		page.window.Element.prototype.scrollIntoView = function scrollIntoViewSpy() {
			scrollIntoViewCalls += 1;
		};

		id(page.document, "pgn-input").value = SHORT_PGN;
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle(600);

		// Walk around the game the way a user would while analysis is running.
		seek(page, 4);
		await page.settle(200);
		page.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
		await page.settle(200);

		assert.equal(scrollIntoViewCalls, 0, "rendering must scroll its own panels, not the page");
		assert.equal(page.window.scrollY, 0, "the page must stay where the user left it");
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});

test("an invalid PGN reports an error instead of wiping the board", async () => {
	const page = await bootAnalyzerPage();
	try {
		id(page.document, "pgn-input").value = "1. Qz9 this is not a game";
		id(page.document, "load-pgn-btn").dispatchEvent(new page.window.Event("click"));
		await page.settle();

		assert.equal(page.document.querySelectorAll("#board .square").length, 64);
		assert.equal(page.errors.length, 0, `page errors: ${page.errors.join(", ")}`);
	} finally {
		page.restore();
	}
});
