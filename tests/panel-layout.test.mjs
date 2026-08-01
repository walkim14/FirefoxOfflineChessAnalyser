// The Game Overview must not scroll, and nothing above a help bubble may clip:
// an overflow context on an ancestor cuts the tooltip off inside the panel.
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

const PGN = `[Event "Test"]
[White "Alice"]
[Black "Bob"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *`;

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
		const seed = this.fen.replace(/[^a-zA-Z]/g, "").length;
		const move = moves[(seed * 5) % moves.length];
		this.emit(`info depth 14 multipv 1 score cp ${(seed % 700) - 350} nodes 10 nps 10 pv ${move.from}${move.to}`);
		return this.emit(`bestmove ${move.from}${move.to}`);
	}

	emit(line) {
		if (this.onmessage) {
			this.onmessage({ data: line });
		}
	}

	terminate() {}
}

async function bootWithStyles() {
	const html = readFileSync(join(appDir, "analyzer.html"), "utf8");
	const dom = new JSDOM(html, { url: "https://example.invalid/analyzer.html", pretendToBeVisual: true });
	const { window } = dom;
	const storage = {};

	window.chrome = {
		runtime: { getURL: (path) => path, lastError: null },
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
	globalThis.Worker = FakeWorker;
	globalThis.HTMLElement = window.HTMLElement;
	Object.defineProperty(globalThis, "location", { value: window.location, configurable: true, writable: true });

	// jsdom does not fetch the linked stylesheet, so inline the real one.
	const style = window.document.createElement("style");
	style.textContent = readFileSync(join(appDir, "styles.css"), "utf8");
	window.document.head.appendChild(style);

	const app = await import(`../app/core/analyzer-app.mjs?layout=${Math.random()}`);
	await app.bootstrapAnalyzerApp();

	const settle = async (ms = 300) => {
		for (let i = 0; i < 20; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(ms / 20))));
		}
	};

	window.document.getElementById("pgn-input").value = PGN;
	window.document.getElementById("load-pgn-btn").dispatchEvent(new window.Event("click"));
	for (let i = 0; i < 200; i += 1) {
		if (!window.document.getElementById("scrubber-label").textContent.startsWith("Loading")) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await settle();

	return {
		window,
		document: window.document,
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

const CLIPPING = new Set(["auto", "scroll", "hidden", "clip"]);

/** Ancestors between `element` and the document that would crop a popup. */
function clippingAncestors(window, element) {
	const found = [];
	for (let node = element.parentElement; node && node !== window.document.body; node = node.parentElement) {
		const style = window.getComputedStyle(node);
		if (CLIPPING.has(style.overflowY) || CLIPPING.has(style.overflowX) || CLIPPING.has(style.overflow)) {
			found.push(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${node.className}`);
		}
	}
	return found;
}

test("the game overview is not a scroll container", async () => {
	const page = await bootWithStyles();
	try {
		const breakdown = page.document.getElementById("overview-breakdown");
		assert.ok(breakdown.querySelector(".overview-row"), "the breakdown should have rendered rows");

		for (const id of ["overview-breakdown", "game-overview-content", "overview-white", "overview-black"]) {
			const style = page.window.getComputedStyle(page.document.getElementById(id));
			for (const prop of ["overflow", "overflowX", "overflowY"]) {
				assert.ok(
					!CLIPPING.has(style[prop]),
					`#${id} sets ${prop}: ${style[prop]} — the summary must not scroll`,
				);
			}
		}
	} finally {
		page.restore();
	}
});

test("the tooltip arrow points at the bubble that opened it", async () => {
	const page = await bootWithStyles();
	try {
		const bubble = page.document.querySelector("#overview-breakdown .overview-row .help-bubble");
		assert.ok(bubble, "the overview should render help bubbles");
		const anchor = bubble.closest(".overview-row");

		// jsdom does no layout, so stand in for it with known geometry.
		anchor.getBoundingClientRect = () => ({ left: 100, top: 0, width: 300, height: 26, bottom: 26, right: 400 });
		bubble.getBoundingClientRect = () => ({ left: 160, top: 5, width: 16, height: 16, bottom: 21, right: 176 });

		bubble.dispatchEvent(new page.window.Event("pointerover", { bubbles: true }));

		// 160 + 16/2 - 100 = 68 from the anchor's left edge.
		assert.equal(anchor.style.getPropertyValue("--help-arrow-x"), "68px");
	} finally {
		page.restore();
	}
});

test("no ancestor of a help bubble clips its tooltip", async () => {
	const page = await bootWithStyles();
	try {
		const bubbles = [...page.document.querySelectorAll(".help-bubble")];
		assert.ok(bubbles.length > 0, "the page should render help bubbles");

		for (const bubble of bubbles) {
			const clippers = clippingAncestors(page.window, bubble);
			assert.deepEqual(clippers, [], `tooltip would be cut off by: ${clippers.join(", ")}`);
		}
	} finally {
		page.restore();
	}
});

test("the tooltip is anchored wide enough to stay inside the panel", async () => {
	const page = await bootWithStyles();
	try {
		const tooltip = page.document.querySelector("#game-overview-content .help-tooltip");
		assert.ok(tooltip, "a tooltip should exist");

		const style = page.window.getComputedStyle(tooltip);
		assert.equal(style.position, "absolute");
		// Stretched between both edges of its anchor rather than centred on the
		// 15px bubble, which used to push it off the side of the sidebar.
		assert.equal(style.left, "0px");
		assert.equal(style.right, "0px");

		// And the anchor must be the row, not the bubble.
		const bubbleStyle = page.window.getComputedStyle(tooltip.parentElement);
		assert.notEqual(bubbleStyle.position, "relative", "the bubble must not be the positioning context");

		const row = tooltip.closest(".overview-row, .overview-heading");
		assert.ok(row, "the tooltip should live inside a row or heading");
		assert.equal(page.window.getComputedStyle(row).position, "relative");
	} finally {
		page.restore();
	}
});

test("both evaluation sidebar modes are styled identically", async () => {
	const page = await bootWithStyles();
	try {
		const bar = page.document.getElementById("eval-bar");
		const white = page.document.getElementById("eval-white");
		const black = page.document.getElementById("eval-black");

		const read = () => ({
			white: page.window.getComputedStyle(white).background || page.window.getComputedStyle(white).backgroundColor,
			black: page.window.getComputedStyle(black).background || page.window.getComputedStyle(black).backgroundColor,
		});

		assert.ok(!bar.classList.contains("ep-mode"), "starts in centipawn mode");
		const cp = read();

		page.document.getElementById("eval-mode-btn").dispatchEvent(new page.window.Event("click"));
		assert.ok(bar.classList.contains("ep-mode"), "switched to expected-points mode");
		const ep = read();

		assert.deepEqual(ep, cp, "the two modes must not differ in colour — only the readout changes");
	} finally {
		page.restore();
	}
});

test("the evaluation readout is horizontal and reads as a plain number", async () => {
	const page = await bootWithStyles();
	try {
		const label = page.document.getElementById("eval-label");
		const style = page.window.getComputedStyle(label);

		assert.ok(
			!/rotate/.test(style.transform || ""),
			`the readout must not be rotated: ${style.transform}`,
		);
		assert.match(label.textContent, /^[+-]?\d/, `unexpected readout: ${label.textContent}`);

		page.document.getElementById("eval-mode-btn").dispatchEvent(new page.window.Event("click"));
		assert.match(label.textContent, /^\d{1,3}%$/, `expected a whole percent, got: ${label.textContent}`);
	} finally {
		page.restore();
	}
});
