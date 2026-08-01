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
- **Trap finder**: moves that are sound for you and that opponents at your rating tend to answer
  badly, found by crossing the Lichess opening explorer with the local engine. See *Trap Finder*.
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
- `app/engine-pool.mjs`: runs several single-threaded engines at once for a whole-game review.
- `tools/bench*.mjs`: review speed, pool scaling, and the accuracy cost of a shallower review — all
  against the real engine.
- `tools/probe/run-probe.mjs`: loads the extension in the real Firefox and reports what the page can
  actually do (threading, `SharedArrayBuffer`). It swaps the manifest while it runs and restores it.
- `app/core/browser-storage.mjs`: async wrappers for `chrome.storage.local`.
- `app/ui/*`: DOM refs and rendering helpers (board, tree, classification, overlays).
- `app/ui/tree-renderer.mjs`: move tree markup — mainline rows, nested variations, expand state.
- `app/state/tree-state.mjs`: move tree state transitions and line synchronization.
- `app/stockfish-client.mjs`: UCI protocol wrapper over a Stockfish worker, including search serialization.
- `app/terminal-position.mjs`: rule-based evaluation for finished positions.
- `app/analysis-fallback.mjs`: progressively lighter retry profiles when a search times out or the worker crashes.
- `app/move-classifier.mjs`: expected-score transform and move labels (`Book`, `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, `Blunder`, plus heuristic `Great`/`Brilliant`).
- `app/opening-book.mjs` + `app/opening-book-data.mjs`: offline ECO opening-book lookup by position and move.
- `app/traps/trap-finder.mjs`: the trap search itself — no DOM, no network, no engine; the explorer
  and the evaluator are injected, which is what lets the tests drive it deterministically.
- `app/traps/explorer-client.mjs`: rate-limited, authenticated client for the Lichess opening explorer.
- `app/traps/explorer-cache.mjs`: memory + `chrome.storage.local` cache, so repeat searches send nothing.
- `app/core/controllers/trap-controller.mjs`: panel wiring, engine-pool hand-off, cancellation.
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
| Old — review at board settings (depth 22, 3 lines), one engine | 104.4 s | 4.35 s |
| New — review at depth 16, 2 lines, one engine | 12.0 s | 0.50 s |

Running that review across the engine pool cuts it by a further ~3.4x; see *Parallelism* below.

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

### Parallelism

Stockfish can search on several threads, but that build needs `SharedArrayBuffer`, which requires the
page to be cross-origin isolated. `tools/probe/run-probe.mjs` loads the real extension in the real
Firefox and reports what the page can actually do. The answer is unambiguous:

```
crossOriginIsolated  false
SharedArrayBuffer    undefined
threaded build       WORKER ERROR ReferenceError: SharedArrayBuffer is not defined
```

Adding Chrome's `cross_origin_embedder_policy` / `cross_origin_opener_policy` manifest keys changes
nothing in Firefox, and neither does flipping the related browser prefs. Extension pages cannot set
COOP/COEP response headers, so internal engine threads are simply unavailable.

The parallelism comes from the other direction instead. A review is a pile of positions that do not
depend on one another, so rather than one engine with many threads it runs **many single-threaded
engines, one position each** (`app/engine-pool.mjs`). Measured inside Firefox on a 16-core machine,
25 positions at the review profile:

| engines | time |
| --- | --- |
| 1 | 9.95 s |
| 6 | 2.91 s |

That is a **3.4x** speedup, the same order internal threading would have given, with no
`SharedArrayBuffer` involved. The pool takes `cores - 1`, capped at six — beyond that the extra
engines stop paying for themselves — and shares the configured memory budget between them rather
than giving each one the full amount. It starts when a review starts and is disposed when the review
ends, so idle memory is unchanged.

Combined with the cheaper review profile, a whole-game review went from roughly 4.3 s per move to
well under half a second.

### Trap Finder

A trap has two halves, and neither is visible from one source alone. The engine knows which replies
are objectively losing but has no idea which of them anyone would ever play. The opening explorer
knows exactly which replies humans at a given rating choose but has no idea which of them are bad.
Intersect the two and what is left is the thing worth learning: **a reply that is both popular and
losing**.

That is the whole design, and it is why no scraping is involved. One explorer request returns the
aggregated move distribution over millions of games at a chosen rating band and time control, so a
search costs a handful of requests rather than a download of anybody's game archive.

For the position on the board, the finder:

1. asks the explorer which moves are actually played here, and takes the most common as candidates;
2. asks the explorer, once per candidate, how the opponent pool replies to it;
3. evaluates the whole tree in one batch across the engine pool;
4. keeps candidates that are sound for you and that a meaningful share of opponents answer badly.

Expected points are zero-sum, so what the opponent gives up on a reply is exactly what you pick up;
the two are the same number and are only computed once. Each candidate is scored by
**expected gain = Σ (share of opponents playing the reply × expected score that reply throws away)**,
shrunk toward zero for thin samples so a 20-game line cannot outrank a 20,000-game one on a fluke.
The panel also reports how the side setting the trap has *actually* scored after each losing reply,
which is independent corroboration that the engine's verdict shows up on the scoreboard.

Clicking a move plays it on the board, so the line can be explored — or searched again one move
deeper.

#### The token

The explorer required no login until it was hit by request floods in early 2026; it now answers
`401` without one. So the panel needs a free **Lichess personal access token**, created at
`lichess.org/account/oauth/token` with **no scopes ticked**. It is stored in `chrome.storage.local`
alongside the other settings and sent only to `explorer.lichess.org`.

#### Not getting banned

Lichess pays for the aggregation this feature reads, and the explorer has already been taken down
once by request floods. The client is therefore built to be a good citizen first and fast second:

- **One request in flight, ever.** Every call joins a single promise chain.
- **A floor of 1.2 s between requests** (`EXPLORER_MIN_INTERVAL_MS`).
- **A 429 stops the search.** Lichess asks for a full minute of silence afterwards, so the client
  records the cooldown, refuses to send anything until it expires, and does *not* retry. Partial
  results are kept and shown.
- **A hard request budget per search**, default 14 and visible in the panel.
- **The smallest useful response**: `topGames` and `recentGames` are pinned to `0`, because game
  references are the expensive half of the payload and the search never reads them.
- **Everything is cached**, in memory and on disk, keyed by position with the move counters stripped
  so transpositions hit the same entry. Entries live 30 days. A second search over the same opening
  sends nothing at all.

A fresh search from a common position costs about **11 requests and 15 seconds**; the same search
again costs **none**.

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
7. To hunt traps, open **Trap finder**, paste a Lichess token once, navigate to the position you
   want to prepare, and click **Find traps**. See *Trap Finder* above.

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
- `tests/trap-finder.test.mjs` drives the trap search over a scripted explorer and engine, covering
  ranking, the soundness filter, sample-size shrinkage, the request budget and the rate-limit path.
- `tests/explorer-client.test.mjs` covers the request floor, the 429 cooldown, the token handling and
  the cache, all against a fake clock so nothing waits on real time.
- `tests/trap-panel.test.mjs` drives the panel through the real page with only the network replaced.
- `tests/engine-pool.test.mjs` covers job settlement, including a run superseded mid-flight.
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
