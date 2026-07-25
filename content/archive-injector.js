const BUTTON_CLASS = "offline-analyzer-archive-btn";
const ROW_SELECTOR = ".game-history-games-row";
const ACTION_CELL_SELECTOR = ".game-history-games-accuracy-cell";

function debugLog(message, payload) {
  if (payload === undefined) {
    console.debug(`[offline-analyzer/archive] ${message}`);
    return;
  }
  console.debug(`[offline-analyzer/archive] ${message}`, payload);
}

function extractGameIdFromRow(row) {
  if (!row) {
    return null;
  }

  const candidates = row.querySelectorAll(
    'a[href*="/analysis/game/live/"], a[href*="/game/live/"]',
  );
  for (const anchor of candidates) {
    const href = anchor.getAttribute("href") || "";
    const match = href.match(/\/game\/live\/(\d+)|\/analysis\/game\/live\/(\d+)/);
    if (match) {
      return match[1] || match[2] || null;
    }
  }

  return null;
}

function decodeJsonEscapedValue(value) {
  try {
    return JSON.parse(`"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"')}"`);
  } catch {
    return value;
  }
}

function parseArchiveYearMonth() {
  const pathMatch = location.pathname.match(/\/games\/archive\/[^/]+\/(\d{4})\/(\d{1,2})/i);
  if (pathMatch) {
    return {
      year: Number(pathMatch[1]),
      month: Number(pathMatch[2]),
    };
  }

  const query = new URLSearchParams(location.search);
  const y = Number(query.get("year"));
  const m = Number(query.get("month"));
  if (Number.isFinite(y) && Number.isFinite(m) && y > 1900 && m >= 1 && m <= 12) {
    return { year: y, month: m };
  }

  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function monthCandidates(baseYear, baseMonth) {
  const toDate = (year, month) => new Date(Date.UTC(year, month - 1, 1));
  const format = (date) => ({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  });

  const base = toDate(baseYear, baseMonth);
  const prev = new Date(base);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const next = new Date(base);
  next.setUTCMonth(next.getUTCMonth() + 1);

  const ordered = [format(base), format(prev), format(next)];
  const seen = new Set();
  return ordered.filter((entry) => {
    const key = `${entry.year}-${entry.month}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function usernamesFromRow(row) {
  const names = new Set();
  const nodes = row.querySelectorAll('[data-test-element="user-tagline-username"]');
  for (const node of nodes) {
    const text = String(node.textContent || "").trim().toLowerCase();
    if (text) {
      names.add(text);
    }
  }
  return [...names];
}

async function fetchJson(url) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function gameMatchesId(game, gameId) {
  if (!game || !game.url) {
    return false;
  }

  return String(game.url).endsWith(`/game/live/${gameId}`) || String(game.url).includes(`/game/live/${gameId}`);
}

async function fetchPgnFromPublicApi(gameId, row) {
  const usernames = usernamesFromRow(row);
  if (!usernames.length) {
    throw new Error("No usernames found in archive row.");
  }

  const { year, month } = parseArchiveYearMonth();
  const monthList = monthCandidates(year, month);
  debugLog("Public API lookup parameters", { gameId, usernames, monthList });

  for (const username of usernames) {
    for (const ym of monthList) {
      const mm = String(ym.month).padStart(2, "0");
      const url = `https://api.chess.com/pub/player/${username}/games/${ym.year}/${mm}`;

      try {
        debugLog("Fetching monthly API", { url });
        const payload = await fetchJson(url);
        const games = Array.isArray(payload?.games) ? payload.games : [];
        const match = games.find((game) => gameMatchesId(game, gameId));
        if (match?.pgn && /\[Event\s+"/i.test(match.pgn)) {
          debugLog("PGN found from public API", { username, url, pgnLength: match.pgn.length });
          return match.pgn;
        }
      } catch (error) {
        debugLog("Monthly API request failed", { url, error: String(error?.message || error) });
      }
    }
  }

  return null;
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

async function fetchText(path) {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) {
    return null;
  }
  return response.text();
}

async function fetchPgnForGame(gameId) {
  const urls = [
    `/callback/live/game/${gameId}`,
    `/callback/live/game/${gameId}/pgn`,
    `/analysis/game/live/${gameId}`,
    `/game/live/${gameId}`,
  ];

  for (const url of urls) {
    try {
      const text = await fetchText(url);
      const pgn = extractPgnFromText(text);
      if (pgn) {
        return pgn;
      }
    } catch {
      // Try next endpoint.
    }
  }

  return null;
}

function setButtonBusy(button, isBusy, label) {
  button.disabled = isBusy;
  button.textContent = label;
}

function isOfflineButtonEvent(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(target.closest(`.${BUTTON_CLASS}`));
}

function buttonAtPoint(x, y) {
  const buttons = document.querySelectorAll(`.${BUTTON_CLASS}`);
  for (const button of buttons) {
    const rect = button.getBoundingClientRect();
    if (
      x >= rect.left
      && x <= rect.right
      && y >= rect.top
      && y <= rect.bottom
    ) {
      return button;
    }
  }

  return null;
}

function eventPoint(event) {
  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = event.touches?.[0] || event.changedTouches?.[0];
  if (touch) {
    return { x: touch.clientX, y: touch.clientY };
  }

  return null;
}

function consumeEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }
}

async function onAnalyzeButtonClick(button, gameId) {
  const idleText = "Offline Review";
  debugLog("Analyze button clicked", { gameId, href: location.href });
  setButtonBusy(button, true, "Loading...");

  try {
    setButtonBusy(button, true, "Fetching PGN...");
    const row = button.closest(ROW_SELECTOR);
    const pgn = await fetchPgnFromPublicApi(gameId, row || document.body);
    if (!pgn) {
      setButtonBusy(button, false, "No PGN");
      setTimeout(() => setButtonBusy(button, false, idleText), 1600);
      return;
    }

    setButtonBusy(button, true, "Opening...");
    const response = await chrome.runtime.sendMessage({
      type: "OPEN_ANALYZER_WITH_PGN",
      gameId,
      pgn,
      source: location.href,
    });

    debugLog("OPEN_ANALYZER_WITH_PGN response", response);

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to open analyzer");
    }

    setButtonBusy(button, false, "Queued");
    setTimeout(() => setButtonBusy(button, false, idleText), 1200);
  } catch (error) {
    console.error("[offline-analyzer/archive] Could not import PGN from public API:", error);
    setButtonBusy(button, false, "Failed");
    setTimeout(() => setButtonBusy(button, false, idleText), 1500);
  }
}

function createAnalyzeButton(gameId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cc-button-component cc-button-secondary cc-button-small cc-bg-secondary ${BUTTON_CLASS}`;
  button.textContent = "Offline Review";
  button.dataset.gameId = String(gameId);
  button.dataset.offlineAnalyzerControl = "1";
  button.style.marginLeft = "0.35rem";
  button.style.whiteSpace = "nowrap";
  button.addEventListener("click", (event) => {
    consumeEvent(event);
  }, true);
  button.addEventListener("mousedown", consumeEvent, true);
  button.addEventListener("pointerdown", consumeEvent, true);
  button.addEventListener("mouseup", consumeEvent, true);
  button.addEventListener("pointerup", consumeEvent, true);
  button.addEventListener("touchstart", consumeEvent, { capture: true, passive: false });
  button.addEventListener("touchend", consumeEvent, { capture: true, passive: false });
  return button;
}

function injectButtons() {
  const rows = document.querySelectorAll(ROW_SELECTOR);
  for (const row of rows) {
    const actions = row.querySelector(ACTION_CELL_SELECTOR);
    if (!actions) {
      continue;
    }

    if (actions.querySelector(`.${BUTTON_CLASS}`)) {
      continue;
    }

    const gameId = extractGameIdFromRow(row);
    if (!gameId) {
      continue;
    }

    actions.style.position = "relative";
    actions.style.zIndex = "20";

    actions.appendChild(createAnalyzeButton(gameId));
  }
}

function observeArchive() {
  const observer = new MutationObserver(() => {
    injectButtons();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click", "touchstart", "touchend"]) {
  document.addEventListener(
    type,
    (event) => {
      const point = eventPoint(event);
      const pointButton = point ? buttonAtPoint(point.x, point.y) : null;

      if (isOfflineButtonEvent(event) || pointButton) {
        consumeEvent(event);

        if (type === "click" || type === "touchend" || type === "pointerup") {
          const actionButton = pointButton || (event.target instanceof Element ? event.target.closest(`.${BUTTON_CLASS}`) : null);
          if (actionButton && actionButton.dataset.gameId && !actionButton.disabled) {
            debugLog("Global hitbox trigger", { type, gameId: actionButton.dataset.gameId });
            onAnalyzeButtonClick(actionButton, actionButton.dataset.gameId);
          }
        }

        return;
      }
    },
    { capture: true, passive: false },
  );
}

injectButtons();
observeArchive();
debugLog("Archive injector initialized");
