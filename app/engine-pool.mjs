/**
 * A pool of independent single-threaded engines.
 *
 * Stockfish can use several threads internally, but that build needs
 * `SharedArrayBuffer`, which requires the page to be cross-origin isolated.
 * Extension pages cannot set COOP/COEP response headers, and Firefox therefore
 * does not define `SharedArrayBuffer` on a `moz-extension://` page at all —
 * `tools/probe/run-probe.mjs` demonstrates this against the real browser.
 *
 * A whole-game review, though, is a pile of positions that do not depend on one
 * another. So the parallelism comes from running several single-threaded
 * engines side by side instead of one engine with several threads. Measured
 * with `tools/bench-pool.mjs`, six engines finish a game about 3.4x faster than
 * one, which is the same order as internal threading would have given.
 */

/** Engines beyond this stop paying for themselves and just cost memory. */
const MAX_ENGINES = 6;

export function idealPoolSize(hardwareConcurrency) {
	const cores = Number(hardwareConcurrency) || 1;
	// Leave a core for the page itself so the board keeps animating smoothly.
	return Math.max(1, Math.min(MAX_ENGINES, cores - 1));
}

export class EnginePool {
	/**
	 * @param {() => object} createClient makes one engine client
	 * @param {number} size how many to run at once
	 */
	constructor({ createClient, size, logger = () => {} }) {
		this.createClient = createClient;
		this.size = Math.max(1, size);
		this.logger = logger;
		this.clients = [];
		this.runToken = 0;
		/** The in-flight run's settlers, so a superseded run can be closed out. */
		this.pending = null;
	}

	get started() {
		return this.clients.length > 0;
	}

	async start({ hashMb, threads = 1 } = {}) {
		if (this.started) {
			return;
		}

		this.clients = Array.from({ length: this.size }, () => this.createClient());
		// The hash budget is shared out, not handed to each engine in full.
		const perEngineHash = Math.max(16, Math.floor((hashMb || 128) / this.clients.length));
		this.logger("Engine pool starting", { engines: this.clients.length, perEngineHash });

		const ready = await Promise.allSettled(
			this.clients.map((client) => client.configure({ hashMb: perEngineHash, threads, multiPV: 1 })),
		);

		// Drop any engine that failed to come up rather than failing the review.
		this.clients = this.clients.filter((client, index) => {
			if (ready[index].status === "fulfilled") {
				return true;
			}
			this.logger("Engine pool member failed to start", String(ready[index].reason?.message || ready[index].reason));
			client.dispose();
			return false;
		});

		if (!this.clients.length) {
			throw new Error("No analysis engines could be started.");
		}
	}

	/**
	 * Runs every job across the pool and returns one promise per job, in the
	 * order given. Callers can await them in sequence while later jobs are still
	 * being worked on.
	 *
	 * @param {Array<{fen: string, depth: number, multiPV: number}>} jobs
	 * @param {(job, result, index) => Promise<object>|object} analyze runs one job on one client
	 */
	run(jobs, analyze) {
		const settlers = jobs.map(() => ({ settled: false, resolve: null, reject: null }));
		const promises = jobs.map(
			(_, index) =>
				new Promise((resolve, reject) => {
					settlers[index].resolve = (value) => {
						settlers[index].settled = true;
						resolve(value);
					};
					settlers[index].reject = (error) => {
						settlers[index].settled = true;
						reject(error);
					};
				}),
		);
		// A cancelled run leaves promises nobody is waiting on; mark them handled
		// so they cannot surface as unhandled rejections.
		for (const promise of promises) {
			promise.catch(() => {});
		}

		// Superseding a run must not leave its caller awaiting promises that can
		// never settle: the lanes of the old run stop the moment the token moves.
		this.abandonPending("Canceled by newer request.");

		const token = ++this.runToken;
		this.pending = { settlers };
		let next = 0;

		const lane = async (client) => {
			for (;;) {
				if (token !== this.runToken) {
					return;
				}
				const index = next;
				next += 1;
				if (index >= jobs.length) {
					return;
				}

				try {
					settlers[index].resolve(await analyze(client, jobs[index], index));
				} catch (error) {
					settlers[index].reject(error);
				}
			}
		};

		Promise.all(this.clients.map((client) => lane(client))).catch(() => {});
		return promises;
	}

	/** Rejects whatever the current run never got to, so no caller waits forever. */
	abandonPending(message) {
		const pending = this.pending;
		this.pending = null;
		if (!pending) {
			return;
		}
		for (const settler of pending.settlers) {
			if (!settler.settled) {
				settler.reject(new Error(message));
			}
		}
	}

	/** Abandons the current run; queued jobs never start. */
	cancel(message = "Canceled by newer request.") {
		this.runToken += 1;
		this.abandonPending(message);
		for (const client of this.clients) {
			client.cancelAll(message);
		}
	}

	dispose() {
		this.runToken += 1;
		this.abandonPending("Engine pool disposed.");
		for (const client of this.clients) {
			client.dispose();
		}
		this.clients = [];
	}
}
