# Offline Chess Analyzer (Firefox Extension)

A local-first Firefox extension that opens its own analysis page (no chess.com overlay) and runs Stockfish WASM in-browser.

## Features

- Separate offline analysis page in the extension.
- PGN import and optional custom start FEN.
- Move navigation (prev/next), board flip, reset line.
- Interactive what-if play: make alternative moves at any point.
- Real-time engine analysis of current position.
- Move quality classification using an Expected Points model.
- Real opening-book classification (`Book`) using an offline ECO database.
- MultiPV display for best candidate lines.
- Auto-import player Elo from PGN tags (`WhiteElo` / `BlackElo`) when present.

## Architecture

- `manifest.json`: MV3 extension config, CSP for WebAssembly, COOP/COEP for cross-origin isolation.
- `background/background.js`: opens `app/analyzer.html` on toolbar click.
- `app/main.js`: board UI, PGN/FEN handling, move tree line editing, analysis orchestration.
- `app/stockfish-client.js`: UCI protocol wrapper over a Stockfish worker.
- `app/move-classifier.mjs`: expected-score transform and move labels (`Book`, `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, `Blunder`, plus heuristic `Great`/`Brilliant`).
- `app/opening-book.mjs` + `app/opening-book-data.mjs`: offline ECO opening-book lookup by position and move.
- `engine/*`: local Stockfish WASM files.
- `vendor/chess.js`: local chess rules/parser library.

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
2. Navigate moves with **Prev/Next** or click entries in the move list.
3. Click a piece then a target square to make an alternative move.
4. Review live analysis lines and move classification.
5. Tune depth/MultiPV/hash/Elo, then click **Apply Engine Settings**.

## Notes

- Engine defaults target responsiveness (`Depth 22`, `MultiPV 3`).
- Browser-safe hash default is `128 MB` (bounded to `64..512 MB`) to reduce WASM crashes.
- For lower-end devices, reduce depth to 18-20.
- Multi-threading depends on browser cross-origin isolation support.
- This implementation stores settings in `chrome.storage.local`.

## Debugging Runtime Errors

- Open extension page devtools and watch logs prefixed with `[app]` and `[engine:ui]`.
- On engine worker failures, the app now auto-restarts the worker and reports a readable status error.
- Use the **Analyze Current Position** button to trigger manual analysis after changing settings.
