const { execSync } = require("node:child_process");

const DEV_PORTS = [5173, 8787];
const killed = [];
const blockers = [];

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function getListeningPidsForPort(port) {
  try {
    const output = run(`netstat -ano -p tcp | findstr :${port}`);
    const pids = new Set();

    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;

      const localAddress = parts[1];
      const state = parts[3];
      const pid = Number(parts[4]);

      if (!Number.isFinite(pid)) continue;
      if (!localAddress.endsWith(`:${port}`)) continue;
      if (state !== "LISTENING") continue;
      if (pid === process.pid) continue;

      pids.add(pid);
    }

    return [...pids];
  } catch {
    return [];
  }
}

function getProcessImageName(pid) {
  try {
    const output = run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).trim();
    if (!output || output.startsWith("INFO:")) return "";

    return output.split(",")[0]?.replace(/"/g, "").toLowerCase() || "";
  } catch {
    return "";
  }
}

function killPid(pid, port) {
  try {
    run(`taskkill /PID ${pid} /F`);
    killed.push({ pid, port });
  } catch {
    // Ignore races where the process exits before taskkill runs.
  }
}

for (const port of DEV_PORTS) {
  const pids = getListeningPidsForPort(port);
  for (const pid of pids) {
    const image = getProcessImageName(pid);
    if (image === "node.exe" || image === "node") {
      killPid(pid, port);
    } else if (image) {
      blockers.push({ pid, port, image });
    }
  }
}

if (killed.length === 0) {
  console.log("[predev] No stale node listeners on dev ports.");
} else {
  const summary = killed.map((item) => `${item.pid}@${item.port}`).join(", ");
  console.log(`[predev] Killed stale node listeners: ${summary}`);
}

if (blockers.length > 0) {
  const summary = blockers.map((item) => `${item.image}:${item.pid}@${item.port}`).join(", ");
  console.log(`[predev] Ports still occupied by non-node processes: ${summary}`);
}
