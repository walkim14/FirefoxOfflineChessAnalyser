function decodeJsonEscapedValue(value) {
  try {
    return JSON.parse(`"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"')}"`);
  } catch {
    return value;
  }
}

function debugLog(message, payload) {
  if (payload === undefined) {
    console.debug(`[offline-analyzer/capture] ${message}`);
    return;
  }
  console.debug(`[offline-analyzer/capture] ${message}`, payload);
}

function extractPgnFromText(text) {
  if (!text) {
    return null;
  }

  if (/\[Event\s+"/i.test(text)) {
    return text;
  }

  const pgnFieldMatch = text.match(/"pgn"\s*:\s*"((?:\\.|[^"\\])+)"/i);
  if (pgnFieldMatch) {
    const decoded = decodeJsonEscapedValue(pgnFieldMatch[1]);
    if (/\[Event\s+"/i.test(decoded)) {
      return decoded;
    }
  }

  const escapedTagMatch = text.match(/\\\[Event\\\s+\\"/i);
  if (escapedTagMatch) {
    const normalized = text
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    if (/\[Event\s+"/i.test(normalized)) {
      return normalized;
    }
  }

  return null;
}

function normalizeSanToken(token) {
  if (!token) {
    return "";
  }

  let value = token.replace(/\s+/g, "").trim();
  value = value.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O");
  return value;
}

function moveSanFromNode(node) {
  if (!node) {
    return "";
  }

  const label = node.querySelector(".node-highlight-content");
  if (!label) {
    return "";
  }

  const figurine = label.querySelector("[data-figurine]")?.getAttribute("data-figurine") || "";
  const rawText = label.textContent || "";
  const sanSuffix = normalizeSanToken(rawText);

  if (!sanSuffix) {
    return "";
  }

  if (figurine && !/^[KQRBN]/.test(sanSuffix)) {
    return `${figurine}${sanSuffix}`;
  }

  return sanSuffix;
}

function extractPgnFromMoveListDom() {
  const rows = document.querySelectorAll(".main-line-row.move-list-row");
  if (!rows.length) {
    return null;
  }

  const plies = [];
  for (const row of rows) {
    const whiteNode = row.querySelector(".node.white-move.main-line-ply");
    const blackNode = row.querySelector(".node.black-move.main-line-ply");
    const whiteSan = moveSanFromNode(whiteNode);
    const blackSan = moveSanFromNode(blackNode);

    if (whiteSan) {
      plies.push(whiteSan);
    }
    if (blackSan) {
      plies.push(blackSan);
    }
  }

  if (!plies.length) {
    return null;
  }

  const chunks = [];
  for (let i = 0; i < plies.length; i += 2) {
    const moveNo = Math.floor(i / 2) + 1;
    const whiteMove = plies[i] || "";
    const blackMove = plies[i + 1] || "";
    chunks.push(blackMove ? `${moveNo}. ${whiteMove} ${blackMove}` : `${moveNo}. ${whiteMove}`);
  }

  return `${chunks.join(" ")} *`;
}

async function waitForDomPgn(maxAttempts = 12) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const domPgn = extractPgnFromMoveListDom();
    if (domPgn) {
      debugLog("PGN reconstructed from move list DOM", { attempt, length: domPgn.length });
      return domPgn;
    }

    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  return null;
}

async function fetchText(path) {
  debugLog("Fetching capture endpoint", { path });
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) {
    debugLog("Endpoint not ok", { path, status: response.status });
    return null;
  }
  return response.text();
}

async function capturePgn(gameId) {
  const urls = [
    `/callback/live/game/${gameId}`,
    `/callback/live/game/${gameId}/pgn`,
    `/callback/game/live/${gameId}`,
    `/callback/game/live/${gameId}/pgn`,
    `/analysis/game/live/${gameId}?tab=review`,
    `/game/live/${gameId}`,
  ];

  debugLog("Capture endpoint candidates", { gameId, count: urls.length, urls });

  const fromDocument = extractPgnFromText(document.documentElement?.outerHTML || "");
  if (fromDocument) {
    debugLog("PGN found directly in game page DOM", { gameId, length: fromDocument.length });
    return fromDocument;
  }

	const fromMoveList = await waitForDomPgn();
	if (fromMoveList) {
		return fromMoveList;
	}

  for (const url of urls) {
    try {
      const text = await fetchText(url);
      const pgn = extractPgnFromText(text);
      if (pgn) {
        debugLog("PGN found from endpoint", { gameId, url, length: pgn.length });
        return pgn;
      }
    } catch {
      // Try next endpoint.
    }
  }

  return null;
}

async function runCaptureFlow() {
  const url = new URL(location.href);
  if (url.searchParams.get("offlineAnalyzerCapture") !== "1") {
    return;
  }

  debugLog("Capture flow triggered", { href: location.href });

  const match = location.pathname.match(/\/game\/live\/(\d+)|\/analysis\/game\/live\/(\d+)/);
  const gameId = match?.[1] || match?.[2] || null;
  if (!gameId) {
    debugLog("No game id matched from URL", { pathname: location.pathname });
    return;
  }

  const pgn = await capturePgn(gameId);
  debugLog("Sending PGN capture result", { gameId, found: Boolean(pgn), length: pgn?.length || 0 });
  await chrome.runtime.sendMessage({
    type: "CAPTURE_PGN_FROM_GAME_TAB",
    gameId,
    pgn: pgn || "",
    source: location.href,
  });
}

runCaptureFlow();
