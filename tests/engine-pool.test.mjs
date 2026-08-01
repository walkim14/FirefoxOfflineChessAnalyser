import test from "node:test";
import assert from "node:assert/strict";
import { EnginePool, idealPoolSize } from "../app/engine-pool.mjs";

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function createPool(size = 2) {
	return new EnginePool({
		createClient: () => ({
			configure: async () => {},
			analyze: async () => ({ cpWhite: 0 }),
			cancelAll: () => {},
			dispose: () => {},
		}),
		size,
	});
}

test("pool size leaves a core for the page and stops at the useful maximum", () => {
	assert.equal(idealPoolSize(4), 3);
	assert.equal(idealPoolSize(32), 6, "extra engines stop paying for themselves");
	assert.equal(idealPoolSize(1), 1);
	assert.equal(idealPoolSize(undefined), 1);
});

test("every job settles when a run completes normally", async () => {
	const pool = createPool(2);
	await pool.start({ hashMb: 64 });

	const results = await Promise.all(pool.run([1, 2, 3, 4], async (_client, job) => job * 2));
	assert.deepEqual(results, [2, 4, 6, 8]);
});

test("a superseded run rejects its outstanding jobs instead of hanging", async () => {
	const pool = createPool(1);
	await pool.start({ hashMb: 64 });

	let releaseFirst = null;
	const firstStarted = new Promise((resolve) => {
		releaseFirst = resolve;
	});

	// One lane, four jobs: the first blocks, so three never start.
	const abandoned = pool.run([1, 2, 3, 4], async () => {
		releaseFirst();
		await new Promise((resolve) => setTimeout(resolve, 10));
		return "first";
	});
	await firstStarted;

	// A second run takes the pool over, exactly as a review starting during a
	// trap search would.
	const replacement = pool.run([9], async () => "second");

	const settled = await Promise.allSettled(abandoned);
	assert.equal(settled[3].status, "rejected", "an abandoned job must not stay pending forever");
	assert.match(String(settled[3].reason?.message), /Canceled by newer request/);
	assert.deepEqual(await Promise.all(replacement), ["second"]);
});

test("cancel and dispose close out whatever the run never reached", async () => {
	const canceled = createPool(1);
	await canceled.start({ hashMb: 64 });
	const cancelPending = canceled.run([1, 2, 3], async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		return "done";
	});
	canceled.cancel("Trap search canceled.");
	const cancelSettled = await Promise.allSettled(cancelPending);
	assert.match(String(cancelSettled[2].reason?.message), /Trap search canceled/);

	const disposed = createPool(1);
	await disposed.start({ hashMb: 64 });
	const disposePending = disposed.run([1, 2, 3], async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		return "done";
	});
	disposed.dispose();
	const disposeSettled = await Promise.allSettled(disposePending);
	assert.match(String(disposeSettled[2].reason?.message), /disposed/);
});

test("a job that throws fails only itself", async () => {
	const pool = createPool(2);
	await pool.start({ hashMb: 64 });

	const settled = await Promise.allSettled(
		pool.run([1, 2, 3], async (_client, job) => {
			if (job === 2) {
				throw new Error("worker died");
			}
			return job;
		}),
	);

	assert.deepEqual(settled.map((entry) => entry.status), ["fulfilled", "rejected", "fulfilled"]);
	assert.equal(settled[2].value, 3);
});

test("the hash budget is shared between engines rather than handed to each in full", async () => {
	const configured = [];
	const pool = new EnginePool({
		createClient: () => ({
			configure: async (options) => configured.push(options.hashMb),
			analyze: async () => ({}),
			cancelAll: () => {},
			dispose: () => {},
		}),
		size: 4,
	});

	await pool.start({ hashMb: 256 });
	assert.deepEqual(configured, [64, 64, 64, 64]);
});
