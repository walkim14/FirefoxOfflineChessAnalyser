function isTimeoutError(error) {
  const message = String(error?.message || error || "");
  return message.toLowerCase().includes("timed out");
}

function isWorkerCrashError(error) {
  const message = String(error?.message || error || "");
  return message.toLowerCase().includes("worker crashed") || message.toLowerCase().includes("unreachable");
}

function isCancellation(error) {
  return /^Canceled\b/.test(String(error?.message || error || ""));
}

export async function analyzeWithFallback({ engine, fen, depth, multiPV, phase = "unknown", logger = () => {} }) {
  // Each fallback must be strictly cheaper than the attempt before it, so the
  // clamps can never push a retry above the requested depth.
  const step = (floor, drop) => Math.min(depth, Math.max(floor, depth - drop));
  const profiles = [
    { depth, multiPV },
    { depth: step(16, 2), multiPV: Math.min(multiPV, 2) },
    { depth: step(14, 4), multiPV: 1 },
    { depth: Math.min(depth, 12), multiPV: 1 },
  ].filter((profile, index, all) =>
    index === 0 || profile.depth < all[index - 1].depth || profile.multiPV < all[index - 1].multiPV,
  );

  let lastError = null;

  for (let i = 0; i < profiles.length; i += 1) {
    const profile = profiles[i];
    const timeoutMs = 16000 + profile.depth * 1000 + profile.multiPV * 3000;

    try {
      logger("Engine analyze attempt", { phase, attempt: i + 1, ...profile, timeoutMs });
      const result = await engine.analyze(fen, {
        depth: profile.depth,
        multiPV: profile.multiPV,
        timeoutMs,
      });

      if (i > 0) {
        logger("Engine recovered via fallback", { phase, attempt: i + 1, used: profile });
      }

      return { result, usedProfile: profile, attempt: i + 1 };
    } catch (error) {
      // A cancellation means someone newer wants the engine; retrying at a
      // lower profile would just fight them for it.
      if (isCancellation(error)) {
        throw error;
      }

      lastError = error;
      const timeout = isTimeoutError(error);
      const workerCrash = isWorkerCrashError(error);

      logger("Engine analyze attempt failed", {
        phase,
        attempt: i + 1,
        ...profile,
        timeout,
        workerCrash,
        error: String(error?.message || error),
      });

      if (!timeout && !workerCrash) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Analysis failed after retries.");
}
