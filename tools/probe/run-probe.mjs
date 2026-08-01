// Answers, empirically, whether this browser lets the extension page run the
// multi-threaded Stockfish build.
//
//   node tools/probe/run-probe.mjs
//
// Boots the real extension in the real Firefox with a temporary manifest whose
// background page opens a probe, and collects the probe's findings over a local
// HTTP channel (extension console output is not relayed by web-ext).
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(root, "manifest.json");
const backupPath = join(root, "manifest.probe-backup.json");
const PORT = 8347;
const FIREFOX = process.env.FIREFOX_BIN || "C:/Program Files/Mozilla Firefox/firefox.exe";

const findings = new Map();
let resolveDone;
const done = new Promise((resolve) => {
	resolveDone = resolve;
});

const server = createServer((request, response) => {
	response.setHeader("Access-Control-Allow-Origin", "*");
	response.setHeader("Access-Control-Allow-Headers", "*");
	if (request.method === "OPTIONS") {
		response.writeHead(204).end();
		return;
	}

	let body = "";
	request.on("data", (chunk) => {
		body += chunk;
	});
	request.on("end", () => {
		try {
			const { key, value } = JSON.parse(body || "{}");
			if (key) {
				findings.set(key, value);
				console.log(`  ${key.padEnd(24)} ${value}`);
				if (key === "done") {
					resolveDone();
				}
			}
		} catch {
			// Ignore malformed reports.
		}
		response.writeHead(200).end("ok");
	});
});

server.listen(PORT, "127.0.0.1");

// Swap in a manifest that launches the probe instead of the analyzer.
copyFileSync(manifestPath, backupPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.background = { scripts: ["tools/probe/background.js"], type: "module" };
manifest.host_permissions = [...(manifest.host_permissions || []), "http://127.0.0.1/*"];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const restore = () => {
	if (existsSync(backupPath)) {
		copyFileSync(backupPath, manifestPath);
		unlinkSync(backupPath);
	}
};

console.log("launching Firefox with the extension…\n");
const webExt = spawn(
	process.execPath,
	[join(root, "node_modules", "web-ext", "bin", "web-ext.js"), "run",
		"--source-dir", root, "--firefox", FIREFOX, "--no-reload",
		// Pass any `--pref name=value` straight through, for testing what a
		// browser setting would change.
		...process.argv.slice(2).flatMap((entry) => (entry.startsWith("pref:") ? ["--pref", entry.slice(5)] : []))],
	{ cwd: root, stdio: "ignore" },
);

const timeout = setTimeout(() => {
	console.log("\n  probe timed out");
	resolveDone();
}, 90000);

await done;
clearTimeout(timeout);
webExt.kill();
server.close();
restore();

console.log("\n--- verdict ---");
const isolated = findings.get("crossOriginIsolated");
const sab = findings.get("sabAllocate") || "";
const threaded = findings.get("threadedWorker") || "(no answer)";
console.log(`crossOriginIsolated : ${isolated}`);
console.log(`SharedArrayBuffer   : ${findings.get("SharedArrayBuffer")} (${sab})`);
console.log(`single-thread build : ${findings.get("singleWorker") || "(no answer)"}`);
console.log(`threaded build      : ${threaded}`);
console.log(
	threaded === "uciok"
		? "\n=> the multi-threaded engine RUNS on an extension page here."
		: "\n=> the multi-threaded engine does NOT run; stay on the single-threaded build.",
);

process.exit(0);
