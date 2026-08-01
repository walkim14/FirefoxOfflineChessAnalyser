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
	// Trap finder. The token is a free, scopeless Lichess personal access token;
	// the explorer has required one since Lichess put it behind authentication.
	lichessToken: "",
	trapRatingBand: "auto",
	trapSpeeds: "blitz,rapid",
	trapBlunderEpLoss: 0.15,
	trapRequestBudget: 14,
};

/**
 * Floor on the gap between two explorer requests. Lichess asks for one request
 * at a time; this is the polite reading of that, and the cache means a slower
 * first run costs nothing on the runs after it.
 */
export const EXPLORER_MIN_INTERVAL_MS = 1200;

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
