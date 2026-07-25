function isTimeoutError(error) {
  const message = String(error?.message || error || "");
  return message.toLowerCase().includes("timed out");
}

function isWorkerCrashError(error) {
  const message = String(error?.message || error || "");
  return message.toLowerCase().includes("worker crashed") || message.toLowerCase().includes("unreachable");
}

export async function analyzeWithFallback({ engine, fen, depth, multiPV, phase = "unknown", logger = () => {} }) {
  const profiles = [
    { depth, multiPV },
    { depth: Math.max(16, depth - 2), multiPV: Math.min(multiPV, 2) },
    { depth: Math.max(14, depth - 4), multiPV: 1 },
    { depth: 12, multiPV: 1 },
  ];

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
