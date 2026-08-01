# Offline Chess Analyzer (Firefox Extension)

A local-first Firefox extension that opens its own analysis page (no chess.com overlay) and runs Stockfish WASM in-browser.

## Features

- Separate offline analysis page in the extension.
- PGN import and optional custom start FEN.
- Move navigation (prev/next), board flip, reset line.
- Interactive what-if play: make alternative moves at any point, including underpromotion.
- Real-time engine analysis of current position.
- Move quality classification using an Expected Points model.
- Real opening-book classification (`Book`) using an offline ECO database.
- MultiPV display for best candidate lines.
- Auto-import player Elo from PGN tags (`WhiteElo` / `BlackElo`) when present.
- Finished positions (checkmate, stalemate, draws) are scored from the rules instead of being sent to the engine.

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Previous / next move |
| `Home` / `End` | Jump to the start / end of the line |
| `F` | Flip the board |
| `Esc` | Clear the selected piece, or close the open dialog |
| `Q` `R` `B` `N` | Pick a piece in the promotion dialog |

## Architecture

- `manifest.json`: MV3 extension config, CSP for WebAssembly, COOP/COEP for cross-origin isolation.
- `background/background.js`: opens `app/analyzer.html` on toolbar click.
- `app/main.js`: thin browser entrypoint/orchestrator that bootstraps the analyzer app.
- `app/core/analyzer-app.mjs`: application composition root and orchestration flow.
- `app/core/controllers/analysis-controller.mjs`: analysis scheduling, caching, move classification, and mainline scan pipeline.
- `app/core/controllers/gameplay-controller.mjs`: playback/navigation, keyboard control, and board interaction moves.
- `app/core/constants.mjs`: defaults and shared constants.
- `tools/snapshot.mjs`: renders the real page to a PNG for looking at UI changes.
- `tools/bench.mjs`, `tools/bench-scan.mjs`, `tools/bench-accuracy.mjs`: review speed and the
  accuracy cost of running it shallower, both against the real engine.
- `app/core/browser-storage.mjs`: async wrappers for `chrome.storage.local`.
- `app/ui/*`: DOM refs and rendering helpers (board, tree, classification, overlays).
- `app/ui/tree-renderer.mjs`: move tree markup — mainline rows, nested variations, expand state.
- `app/state/tree-state.mjs`: move tree state transitions and line synchronization.
- `app/stockfish-client.mjs`: UCI protocol wrapper over a Stockfish worker, including search serialization.
- `app/terminal-position.mjs`: rule-based evaluation for finished positions.
- `app/analysis-fallback.mjs`: progressively lighter retry profiles when a search times out or the worker crashes.
- `app/move-classifier.mjs`: expected-score transform and move labels (`Book`, `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, `Blunder`, plus heuristic `Great`/`Brilliant`).
- `app/opening-book.mjs` + `app/opening-book-data.mjs`: offline ECO opening-book lookup by position and move.
- `engine/*`: local Stockfish WASM files.
- `vendor/chess.js`: local chess rules/parser library (ES module).

Everything in this repository is ES modules; `package.json` declares `"type": "module"` so Node reads the
`.js` sources the same way the browser does.

### Engine Concurrency

Only one search may run in the worker at a time. `StockfishClient` therefore keeps a single active
request plus at most one queued request: a newer `analyze()` call stops the running search, rejects it
with `Canceled by newer request.`, and waits for the engine's terminating `bestmove` before starting the
next search. Without that wait, the stopped search's `bestmove` would resolve the *next* request with an
empty result — a flat `0.00` evaluation and a best-move arrow belonging to the previous position.

Above that, the app never runs two analysis pipelines at once: the whole-game scan and the move
classifier own the engine while they run, and both re-schedule a position analysis when they finish.
Any user navigation (arrow keys, move list, scrubber, tree jump, or playing a move) cancels a running
scan so it cannot move the board out from under the click.

### Best-Move Arrow

The arrow answers *"what was the best move at this ply?"* — the strongest alternative to the move you
are looking at — so it is computed from the position that move was played from, exactly like the
`Best move:` line in the Move Classification panel. The two can never disagree.

- At the root there is no played move, so the arrow shows the best move from the position on the board.
- When the played move already was the best one, no arrow is drawn; the board tag already says so.
- A candidate that is not legal in the position it is measured against is discarded rather than drawn,
  so an arrow belonging to another ply can never reach the screen.

Note that this is review framing, not exploration framing: the arrow tells you what should have been
played, not what to play next. It therefore can start from a square the played move has since vacated.

### Review Performance

A whole-game review used to run every position at the depth and line count chosen for the
interactive board. Nothing needs depth 22 with three lines to sort a move into one of seven
expected-point buckets, and on the single-threaded engine this extension ships that profile costs
about 4.3 s per move.

The review now has its own, cheaper profile:

| | 24-ply game | per move |
| --- | --- | --- |
| Old — review at board settings (depth 22, 3 lines) | 104.4 s | 4.35 s |
| New — review at depth 16, 2 lines | 12.0 s | 0.50 s |

Measured with `tools/bench-scan.mjs` against the same `stockfish-18-lite-single` build the
extension loads. Three changes get there:

- **A separate review depth.** `tools/bench-accuracy.mjs` scores a shallow review against a deep
  one move by move. Across a quiet grandmaster game and a sharp game full of real blunders, depth
  16 never changed which moves were flagged as inaccuracies, mistakes or blunders. The drift is
  confined to the fine gradation between Best, Excellent and Good, plus some `Great` labels a
  shallow search cannot establish. Raise **Review depth** for a slower, stricter pass.
- **Two lines instead of three.** The third line only decides `Great` and `Brilliant`, so it is
  fetched on demand for the handful of moves that claim one, rather than paid for on every move.
- **The playback beat overlaps the search.** The board animation used to run to completion before
  the engine was asked anything, adding its delay to every ply.

The review already costs one search per ply rather than two: each ply's resulting position is the
next ply's starting position, so the result is carried forward.

The single biggest remaining lever is **threads**. Stockfish is 3-4x faster multi-threaded, and the
threaded build ships in `engine/`, but `SharedArrayBuffer` requires the page to be cross-origin
isolated. Extension pages cannot set COOP/COEP response headers, so the analyzer runs
single-threaded and `threadCountForEngine()` reports 1. If a future Firefox grants isolation to
extension pages, the faster worker is picked up automatically with no code change.

### Move Tree

The tree renders a reference spine — the loaded PGN mainline, or the first line played when starting
from a FEN — with every alternative shown as an indented variation beneath the move it branches from.

Two rules keep it honest as variations accumulate:

- A move's variations are *every child except the one that continues the line currently being rendered*.
  At the end of a line there is no such continuation, so all children are variations. Deriving this from
  the rendered path (rather than guessing a "main child") is what keeps a move played from the final
  position visible.
- A variation is expanded when the user opened it **or** when it contains the current move. Since
  navigating to a node promotes the whole path to it, the move you just played is always on screen
  without hiding behind a collapsed toggle; step back onto the mainline and it folds away again, with
  the toggle reporting how many lines it holds.

Nesting is unbounded — indentation comes from the containing block, not from per-depth CSS classes.
Chips are labelled in SAN (`Nf3`, not `g1f3`) and carry their classification icon once scored.

## Expected Points Model

The implementation maps centipawn scores to white winning chances using:

`p_white = 50 + 50 * ((2 / (1 + exp(-0.00368208 * cp_white))) - 1)`

Move classification compares expected score for the mover:

- `Best`: top engine move (near-zero EP loss)
- `Excellent`: EP loss <= 2%
- `Good`: EP loss <= 5%
- `Inaccuracy`: EP loss <= 10%
- `Mistake`: EP loss <= 20%
- `Blunder`: EP loss > 20%

## Install / Run (Firefox)

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox**.
3. Click **Load Temporary Add-on...**.
4. Select `manifest.json` from this folder.
5. Click the extension toolbar icon to open the analyzer page.

## Usage

1. Paste PGN and click **Load PGN**, or input a FEN and click **Load FEN**.
2. Loading a PGN starts a whole-game scan that classifies every move; any navigation stops it.
3. Navigate moves with **Prev/Next**, the arrow keys, the timeline scrubber, or the move list.
4. Click a piece then a target square to make an alternative move; pawn promotions open a piece picker.
5. Review live analysis lines and move classification.
6. Tune depth/MultiPV/hash/Elo, then click **Apply Engine Settings**.

## Testing

```bash
npm install
npm test
```

The suite runs on Node's built-in test runner and needs no browser:

- `tests/app-boot.test.mjs` boots the real `analyzer.html` and `analyzer-app.mjs` in jsdom against a fake
  Stockfish worker, then drives the page the way a user does (load PGN, click squares, flip, reset, keys).
- `tests/live-moves.test.mjs` wires the real controllers headlessly to cover branching, classification and
  scan takeover.
- `tests/stockfish-client.test.mjs` drives the UCI client through a mock worker, including search cancellation.
- The remaining files cover PGN parsing, the opening book, classification and the fallback profiles.

## Notes

- Engine defaults target responsiveness (`Depth 22`, `Lines 3`, `Review depth 16`).
- **Depth** and **Lines** apply to the position on the board; **Review depth** applies to the
  whole-game pass. See *Review Performance* above for the trade.
- Browser-safe hash default is `128 MB` (bounded to `64..512 MB`) to reduce WASM crashes.
- **Apply Engine Settings** pushes Hash/Threads/MultiPV to the worker via `setoption` and clears the
  analysis cache, so changed settings take effect immediately.
- For lower-end devices, reduce depth to 18-20.
- Multi-threading depends on browser cross-origin isolation support; without it the single-threaded
  worker is used and Threads stays at 1.
- This implementation stores settings in `chrome.storage.local`.

## Debugging Runtime Errors

- Open extension page devtools and watch logs prefixed with `[app]` and `[engine:ui]`.
- On engine worker failures, the app now auto-restarts the worker and reports a readable status error.
- Use the **Analyze Current Position** button to trigger manual analysis after changing settings.
