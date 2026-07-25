import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parsePgnToLine } from "../app/pgn-loader.mjs";

const require = createRequire(import.meta.url);
const { Chess } = require("chess.js");

const CHESS_COM_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.07.22"]
[Round "-"]
[White "JRed1020"]
[Black "NoobieHoobie"]
[Result "1-0"]
[CurrentPosition "8/8/2p2k2/pp2p2p/4P2P/1PP2K2/P7/5B2 b - - 1 43"]
[Timezone "UTC"]
[ECO "C40"]
[ECOUrl "https://www.chess.com/openings/Kings-Pawn-Opening-Kings-Knight-Busch-Gass-Gambit"]
[UTCDate "2026.07.22"]
[UTCTime "16:32:18"]
[WhiteElo "1578"]
[BlackElo "1560"]
[TimeControl "60"]
[Termination "JRed1020 won on time"]
[StartTime "16:32:18"]
[EndDate "2026.07.22"]
[EndTime "16:34:24"]
[Link "https://www.chess.com/analysis/game/live/171927589420/games"]
[WhiteUrl "https://images.chesscomfiles.com/uploads/v1/user/268199711.e5343e7b.50x50o.53d290cd43ff.jpg"]
[WhiteCountry "133"]
[WhiteTitle ""]
[BlackUrl "https://www.chess.com/bundles/web/images/noavatar_l.84a92436.gif"]
[BlackCountry "18"]
[BlackTitle ""]

1. e4 e5 2. Nf3 Bc5 3. d4 exd4 4. Nxd4 d6 5. Nc3 Be6 6. Be3 Qf6 7. Nxe6 fxe6 8.
Bxc5 dxc5 9. Qd2 Nc6 10. O-O-O Rd8 11. Qe2 Nge7 12. g4 O-O 13. h4 Qf4+ 14. Kb1
Nd4 15. Qe3 Qxe3 16. fxe3 Nf3 17. Bg2 Nd2+ 18. Kc1 Nc4 19. b3 Nxe3 20. Rxd8 Rxd8
21. Bf3 Nc6 22. Re1 Nxg4 23. Bxg4 Nd4 24. Re3 Rf8 25. Ne2 Rf1+ 26. Kb2 Rf2 27.
Nxd4 cxd4 28. Rd3 e5 29. Rf3 Rxf3 30. Bxf3 g6 31. Bg4 h5 32. Be6+ Kg7 33. c3 Kf6
34. Bd5 d3 35. Kc1 g5 36. Kd2 g4 37. Kxd3 g3 38. Ke2 c6 39. Bc4 b6 40. Kf3 b5
41. Bf1 a6 42. Kxg3 a5 43. Kf3 1-0`;

test("parses chess.com PGN export and returns full move line", () => {
  const parsed = parsePgnToLine(CHESS_COM_PGN, Chess);

  assert.equal(parsed.startFen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.equal(parsed.lineMoves.length, 85);
  assert.equal(parsed.lineMoves[0], "e2e4");
  assert.equal(parsed.lineMoves.at(-1), "g3f3");
  assert.ok(parsed.finalFen.includes(" b "));
});
