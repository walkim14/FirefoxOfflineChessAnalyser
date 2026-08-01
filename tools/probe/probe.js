// End-to-end timing of the real review pipeline, inside the real browser.
const report = (key, value) => {
  console.log(`PROBE ${key}=${value}`);
  return fetch("http://127.0.0.1:8347/report", {
    method: "POST",
    body: JSON.stringify({ key, value: String(value) }),
  }).catch(() => {});
};

const PGN = `[Event "Probe"]
[White "Kasparov"]
[Black "Topalov"]

1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Be3 Bg7 5. Qd2 c6 6. f3 b5 7. Nge2 Nbd7
8. Bh6 Bxh6 9. Qxh6 Bb7 10. a3 e5 11. O-O-O Qe7 12. Kb1 a6 *`;

(async () => {
  await report("cores", navigator.hardwareConcurrency);
  await report("sharedArrayBuffer", typeof SharedArrayBuffer);

  const { EnginePool, idealPoolSize } = await import(chrome.runtime.getURL("app/engine-pool.mjs"));
  const { StockfishClient } = await import(chrome.runtime.getURL("app/stockfish-client.mjs"));
  const { Chess } = await import(chrome.runtime.getURL("vendor/chess.js"));

  const game = new Chess();
  const fens = [game.fen()];
  for (const san of PGN.split("\n").slice(4).join(" ").replace(/\d+\.\s*/g, "").replace("*", "").split(/\s+/).filter(Boolean)) {
    try { game.move(san); } catch { break; }
    fens.push(game.fen());
  }
  await report("positions", fens.length);

  async function timePool(size) {
    const pool = new EnginePool({
      createClient: () => new StockfishClient({ debug: false }),
      size,
    });
    await pool.start({ hashMb: 128 });
    const started = performance.now();
    const jobs = fens.map((fen) => ({ fen }));
    const promises = pool.run(jobs, (client, job) => client.analyze(job.fen, { depth: 16, multiPV: 2 }));
    await Promise.all(promises);
    const ms = performance.now() - started;
    pool.dispose();
    return ms;
  }

  const one = await timePool(1);
  await report("engines1_ms", Math.round(one));
  const ideal = idealPoolSize(navigator.hardwareConcurrency);
  await report("idealPoolSize", ideal);
  const many = await timePool(ideal);
  await report(`engines${ideal}_ms`, Math.round(many));
  await report("speedup", (one / many).toFixed(2));
  await report("done", "1");
})().catch((error) => report("done", `ERROR ${error.message}`));
