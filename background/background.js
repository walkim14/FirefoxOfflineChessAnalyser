const ANALYZER_PAGE = "app/analyzer.html";
const IMPORT_KEY = "pendingPgnImport";
const IMPORT_BY_TAB_KEY = "pendingPgnImportByTab";

function debugLog(message, payload) {
  if (payload === undefined) {
    console.debug(`[offline-analyzer/bg] ${message}`);
    return;
  }
  console.debug(`[offline-analyzer/bg] ${message}`, payload);
}

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(ANALYZER_PAGE);
  const tabs = await chrome.tabs.query({ url });

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return;
  }

  await chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "OPEN_ANALYZER_WITH_PGN") {
    (async () => {
      try {
        const payload = {
          pgn: String(message.pgn || ""),
          gameId: String(message.gameId || ""),
          source: String(message.source || ""),
          timestamp: Date.now(),
        };

        await chrome.storage.local.set({ [IMPORT_KEY]: payload });

        const url = chrome.runtime.getURL(ANALYZER_PAGE);
        const tabs = await chrome.tabs.query({ url });
        if (tabs.length > 0 && tabs[0].id) {
          await chrome.tabs.update(tabs[0].id, { active: true });
        } else {
          await chrome.tabs.create({ url });
        }

        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();

    return true;
  }

  if (message.type === "START_ARCHIVE_CAPTURE_FLOW") {
    (async () => {
      try {
        const gameId = String(message.gameId || "");
        if (!gameId) {
          sendResponse({ ok: false, error: "Missing game id." });
          return;
        }

        const captureUrl = `https://www.chess.com/game/live/${gameId}?offlineAnalyzerCapture=1`;
        debugLog("Starting archive capture flow", { gameId, captureUrl, source: message.source });
        const createdTab = await chrome.tabs.create({ url: captureUrl, active: false });
        debugLog("Capture tab created", { tabId: createdTab?.id, url: createdTab?.url });
        sendResponse({ ok: true, tabId: createdTab?.id || null });
      } catch (error) {
        console.error("[offline-analyzer/bg] START_ARCHIVE_CAPTURE_FLOW failed", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();

    return true;
  }

  if (message.type === "CAPTURE_PGN_FROM_GAME_TAB") {
    (async () => {
      try {
        const tabId = _sender?.tab?.id;
        if (!tabId) {
          sendResponse({ ok: false, error: "No sender tab id." });
          return;
        }

        debugLog("Received PGN capture message", { tabId, gameId: message.gameId, source: message.source });

        const pgn = String(message.pgn || "").trim();
        if (!pgn) {
          console.warn("[offline-analyzer/bg] PGN was empty for capture tab", { tabId, gameId: message.gameId });
          sendResponse({ ok: false, error: "PGN not found on game page." });
          return;
        }

        const payload = {
          pgn,
          gameId: String(message.gameId || ""),
          source: String(message.source || ""),
          timestamp: Date.now(),
        };

        const store = await chrome.storage.local.get(IMPORT_BY_TAB_KEY);
        const byTab = { ...(store?.[IMPORT_BY_TAB_KEY] || {}) };
        byTab[String(tabId)] = payload;
        await chrome.storage.local.set({ [IMPORT_BY_TAB_KEY]: byTab });

        const analyzerUrl = chrome.runtime.getURL(`${ANALYZER_PAGE}?importTab=${tabId}`);
        debugLog("Replacing capture tab with analyzer", { tabId, analyzerUrl, pgnLength: pgn.length });
        await chrome.tabs.update(tabId, { url: analyzerUrl, active: false });
        sendResponse({ ok: true });
      } catch (error) {
        console.error("[offline-analyzer/bg] CAPTURE_PGN_FROM_GAME_TAB failed", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();

    return true;
  }

  return false;
});
