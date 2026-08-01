export const DEFAULT_SETTINGS = {
	depth: 22,
	// The whole-game review runs shallower than the interactive board. Measured
	// against a depth-22 review of the same games (tools/bench-accuracy.mjs),
	// depth 16 is ~9x faster and never changed which moves were flagged as
	// inaccuracies, mistakes or blunders; the drift is confined to the fine
	// gradation between Best, Excellent and Good, plus some Great labels that
	// a shallow search cannot establish. Raise it for a slower, stricter pass.
	reviewDepth: 16,
	multiPV: 3,
	hashMb: 128,
	playerElo: 1600,
	boardStyle: "brown",
	pieceStyle: "neo",
	evalSidebarMode: "cp",
	sidebarCollapsed: false,
	reviewMode: false,
};

export const CLASS_ICONS = {
	book: "Bk",
	best: "★",
	excellent: "✓",
	good: "+",
	inaccuracy: "?!",
	mistake: "?",
	blunder: "??",
	great: "!",
	brilliant: "‼",
	miss: "⨯",
};

export const SCAN_PLAYBACK_DELAY_MS = 120;
export const REVIEW_PLAYBACK_DELAY_MS = 170;

export const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
