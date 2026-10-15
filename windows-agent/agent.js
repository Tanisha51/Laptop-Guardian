const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

let API_URL = (process.env.LG_API_URL || "http://localhost:8787").replace(/\/$/, "");
const CONFIG_FILE = path.join(__dirname, ".agent-config.json");
const POLL_MS = 5000;
const HEARTBEAT_MS = 10000;
let config = null;
let busy = false;

function systemInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  return { hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(), uptimeSeconds: Math.floor(os.uptime()), memoryTotal: total, memoryFree: free, cpuCount: os.cpus().length };
}
async function request(route, options = {}) {
  const response = await fetch(`${API_URL}${route}`, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(config?.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function saveConfig(value) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  config = value;
}
async function pair(code) {
  if (!/^\d{6}$/.test(code || "")) throw new Error("Usage: node agent.js pair 123456");
  const response = await fetch(`${API_URL}/api/agent/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, ...systemInfo() }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Pairing failed (${response.status})`);
  saveConfig({ apiUrl: API_URL, deviceId: data.deviceId, agentToken: data.agentToken, pairedAt: new Date().toISOString() });
  console.log(`Paired successfully: ${os.hostname()} (${data.deviceId})`);
  console.log(`Agent token saved to ${CONFIG_FILE}. Keep this file private.`);
  console.log("Starting heartbeat service. Press Ctrl+C to stop.");
  await runAgent();
}
async function sendHeartbeat() {
  await request("/api/agent/heartbeat", { method: "POST", body: JSON.stringify(systemInfo()) });
}
function lockWindows() {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") return reject(new Error("Lock command is supported on Windows only."));
    execFile("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true }, (error) => error ? reject(error) : resolve("Windows session lock requested."));
  });
}
async function handleCommands() {
  const data = await request("/api/agent/commands");
  for (const command of data.commands || []) {
    let success = false; let message = "";
    try {
      if (command.action === "lock") message = await lockWindows(), success = true;
      else if (command.action === "refresh") message = "Device status refreshed.", success = true;
      else message = "Unsupported command.";
    } catch (error) { message = error.message; }
    await request(`/api/agent/commands/${encodeURIComponent(command.id)}/result`, { method: "POST", body: JSON.stringify({ success, message }) });
    console.log(`[${new Date().toLocaleTimeString()}] ${command.action}: ${success ? "completed" : "failed"} — ${message}`);
  }
}
async function runAgent() {
  let lastHeartbeat = 0;
  console.log(`Agent connected to ${API_URL}`);
  while (true) {
    try {
      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) { await sendHeartbeat(); lastHeartbeat = Date.now(); }
      await handleCommands();
    } catch (error) {
      console.error(`[${new Date().toLocaleTimeString()}] Connection/agent error: ${error.message}`);
      if (/token is invalid|unpaired/i.test(error.message)) { console.error("This agent was unpaired or its token was revoked. Stop the agent and pair again."); process.exitCode = 1; return; }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
async function main() {
  const [command, code] = process.argv.slice(2);
  if (command === "pair") return pair(code);
  if (!fs.existsSync(CONFIG_FILE)) {
    console.log("This Windows Agent is not paired yet.");
    console.log("1. Start the backend and sign in to the dashboard.");
    console.log("2. Generate a pairing code, then run: node agent.js pair 123456");
    process.exitCode = 1; return;
  }
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  API_URL = String(config.apiUrl || API_URL).replace(/\/$/, "");
  if (!config.agentToken || !config.deviceId) throw new Error("Agent config is incomplete. Pair the device again.");
  return runAgent();
}
main().catch((error) => { console.error(`Agent stopped: ${error.message}`); process.exitCode = 1; });
