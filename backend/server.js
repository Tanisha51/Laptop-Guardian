const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 8787;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("ERROR: Set JWT_SECRET to a random secret of at least 32 characters in .env");
  process.exit(1);
}

const { cloudEnabled, readCollection, replaceCollection } = require("./storage");
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const readUsers = () => readCollection("users");
const saveUsers = (value) => replaceCollection("users", value);
const readDevices = () => readCollection("devices");
const saveDevices = (value) => replaceCollection("devices", value);
const readEvents = () => readCollection("events");
const saveEvents = (value) => replaceCollection("events", value.slice(-500));
const readCommands = () => readCollection("commands");
const saveCommands = (value) => replaceCollection("commands", value.slice(-500));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const validEmail = (email) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const pairCodes = new Map();

const dummyHash = bcrypt.hashSync("not-a-real-account-password", 10);

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:8787" }));
app.use(express.json({ limit: "30kb" }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });
app.use("/api", apiLimiter);

async function addEvent(type, message, deviceId = null) {
  const events = await readEvents();
  events.push({ id: crypto.randomUUID(), type, message, deviceId, createdAt: new Date().toISOString() });
  await saveEvents(events);
}
function createToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role || "owner" }, JWT_SECRET, { expiresIn: "2h", issuer: "laptop-guardian", audience: "laptop-guardian-dashboard" });
}
function requireAuth(req, res, next) {
  const [scheme, token] = String(req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) return res.status(401).json({ error: "Please log in to continue." });
  try {
    req.auth = jwt.verify(token, JWT_SECRET, { issuer: "laptop-guardian", audience: "laptop-guardian-dashboard" });
    next();
  } catch {
    return res.status(401).json({ error: "Your session expired. Please log in again." });
  }
}
function requireOwner(req, res, next) {
  if (req.auth?.role !== "owner") return res.status(403).json({ error: "This action is available in Owner Mode only. Guest Mode is read-only." });
  next();
}
async function requireAgent(req, res, next) {
  const [scheme, token] = String(req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) return res.status(401).json({ error: "Agent token required." });
  const tokenHash = hash(token);
  let devices;
  try { devices = await readDevices(); } catch (error) { return res.status(503).json({ error: "Database is temporarily unavailable." }); }
  const device = devices.find((item) => item.tokenHash === tokenHash);
  if (!device) return res.status(401).json({ error: "Agent token is invalid or revoked." });
  req.device = device;
  req.devices = devices;
  next();
}
function safeDevice(device) {
  const { tokenHash, ...safe } = device;
  const last = Date.parse(safe.lastSeen || "");
  safe.status = Number.isFinite(last) && Date.now() - last < 35000 ? "online" : "offline";
  return safe;
}

// Guests receive only a minimal status view; no hostnames, telemetry, internal IDs, or pairing data.
function guestSafeDevice(device, index = 0) {
  const safe = safeDevice(device);
  return {
    id: `guest-device-${index + 1}`,
    name: `Device ${index + 1}`,
    hostname: "Hidden in Guest Mode",
    platform: "Hidden",
    release: "",
    cpuCount: null,
    memoryTotal: 0,
    memoryFree: 0,
    uptimeSeconds: 0,
    lastSeen: safe.lastSeen || null,
    status: safe.status,
    createdAt: null
  };
}

app.get("/api/health", (req, res) => res.json({ status: "ok", service: "Laptop Guardian", storage: cloudEnabled ? "supabase" : "local-json", timestamp: new Date().toISOString() }));
app.get("/api/config/status", (req, res) => res.json({ emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM), emailProvider: process.env.RESEND_API_KEY && process.env.EMAIL_FROM ? "Resend" : "Not configured" }));
async function sendResendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    const error = new Error("Email delivery is not configured. Add RESEND_API_KEY and EMAIL_FROM to backend/.env first.");
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "Email provider rejected the message.");
    error.statusCode = 502;
    throw error;
  }
  return data;
}
app.post("/api/notifications/test", requireAuth, requireOwner, async (req, res) => {
  try {
    const user = (await readUsers()).find((item) => item.id === req.auth.sub);
    if (!user || !validEmail(user.email)) return res.status(400).json({ error: "The owner account does not contain a valid email address." });
    const result = await sendResendEmail(user.email, "Laptop Guardian — test email", `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Laptop Guardian email test</h2><p>This is a test message requested from your Laptop Guardian dashboard.</p><p>If you received this email, the configured delivery provider can reach your mailbox.</p><p style="color:#667085">Sent at ${new Date().toISOString()}</p></div>`);
    await addEvent("email", `Test email sent to ${user.email}`);
    return res.json({ message: `Test email accepted by the provider for ${user.email}. Check your inbox and spam folder.`, id: result.id || null });
  } catch (error) {
    console.error("Test email failed:", error.message);
    return res.status(error.statusCode || 500).json({ error: error.message || "Could not send test email." });
  }
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 12 || password.length > 72) return res.status(400).json({ error: "Password must be between 12 and 72 characters." });
    const users = await readUsers();
    if (users.length > 0) return res.status(403).json({ error: "Owner account already exists. Registration is closed." });
    const user = { id: crypto.randomUUID(), email, passwordHash: await bcrypt.hash(password, 12), createdAt: new Date().toISOString() };
    await saveUsers([user]);
    await addEvent("account", `Owner account created for ${email}`);
    return res.status(201).json({ message: "Owner account created. Please log in." });
  } catch (error) {
    console.error("Registration failed:", error.message);
    return res.status(500).json({ error: "Could not create the account." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!validEmail(email) || !password || password.length > 72) {
      await bcrypt.compare(password.slice(0, 72) || "x", dummyHash);
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const users = await readUsers();
    const user = users.find((item) => String(item.email || "").trim().toLowerCase() === email);
    const valid = await bcrypt.compare(password, user?.passwordHash || dummyHash);
    if (!user || !valid) return res.status(401).json({ error: "Invalid email or password." });
    await addEvent("login", `Owner signed in: ${user.email}`);
    return res.json({ message: "Login successful.", token: createToken(user), user: { id: user.id, email: user.email } });
  } catch (error) {
    console.error("Login failed:", error.message);
    return res.status(500).json({ error: "Login could not be completed." });
  }
});
app.post("/api/auth/guest", authLimiter, async (req, res) => {
  const guest = { id: "guest-session", email: "Guest (read-only)", role: "guest" };
  await addEvent("guest", "A read-only guest session started");
  return res.json({ message: "Guest Mode started. Mutating actions are disabled.", token: createToken(guest), user: { id: guest.id, email: guest.email, role: guest.role } });
});
app.get("/api/auth/me", requireAuth, async (req, res) => {
  if (req.auth.role === "guest") {
    return res.json({ user: { id: "guest-session", email: "Guest (read-only)", role: "guest" } });
  }
  try {
    const user = (await readUsers()).find((item) => item.id === req.auth.sub);
    if (!user) return res.status(401).json({ error: "Account not found." });
    return res.json({ user: { id: user.id, email: user.email, role: "owner" } });
  } catch (error) {
    console.error("Account lookup failed:", error.message);
    return res.status(500).json({ error: "Could not verify account." });
  }
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const isGuest = req.auth.role === "guest";
    const rawDevices = await readDevices();
    const devices = rawDevices.map((device, index) => isGuest ? guestSafeDevice(device, index) : safeDevice(device));
    const events = isGuest ? [] : (await readEvents()).slice(-12).reverse();
    res.json({
      stats: {
        total: devices.length,
        online: devices.filter((d) => d.status === "online").length,
        offline: devices.filter((d) => d.status === "offline").length,
        alerts: isGuest ? 0 : events.filter((e) => e.type === "alert").length
      },
      devices,
      events,
      user: { email: isGuest ? "Guest" : req.auth.email },
      role: req.auth.role
    });
  } catch (error) {
    console.error("Dashboard read failed:", error.message);
    res.status(500).json({ error: "Could not load dashboard data." });
  }
});
app.get("/api/devices", requireAuth, async (req, res) => {
  const rawDevices = await readDevices();
  const isGuest = req.auth.role === "guest";
  return res.json({ devices: rawDevices.map((device, index) => isGuest ? guestSafeDevice(device, index) : safeDevice(device)), role: req.auth.role });
});
app.get("/api/activity", requireAuth, async (req, res) => {
  if (req.auth.role === "guest") {
    return res.json({ events: [], restricted: true, message: "Activity history is available to the owner only." });
  }
  return res.json({ events: (await readEvents()).slice(-100).reverse() });
});
app.post("/api/devices/pairing", requireAuth, requireOwner, (req, res) => {
  const code = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  pairCodes.set(code, { ownerId: req.auth.sub, expiresAt });
  for (const [oldCode, info] of pairCodes) if (info.expiresAt < Date.now()) pairCodes.delete(oldCode);
  res.json({ code, expiresAt: new Date(expiresAt).toISOString(), expiresInSeconds: 300, apiUrl: `http://localhost:${PORT}` });
});
app.delete("/api/devices/:id", requireAuth, requireOwner, async (req, res) => {
  const devices = await readDevices();
  const found = devices.find((d) => d.id === req.params.id);
  if (!found) return res.status(404).json({ error: "Device not found." });
  await saveDevices(devices.filter((d) => d.id !== req.params.id));
  await addEvent("device", `Device unpaired: ${found.name}`, found.id);
  res.json({ message: "Device unpaired. Its agent token has been revoked." });
});
app.post("/api/devices/:id/commands", requireAuth, requireOwner, async (req, res) => {
  const devices = await readDevices();
  const device = devices.find((d) => d.id === req.params.id);
  if (!device) return res.status(404).json({ error: "Device not found." });
  const action = String(req.body?.action || "");
  if (!['lock', 'refresh'].includes(action)) return res.status(400).json({ error: "Unsupported command." });
  if (safeDevice(device).status !== "online") return res.status(409).json({ error: "Device is offline. Command was not queued." });
  const command = { id: crypto.randomUUID(), deviceId: device.id, action, status: "queued", createdAt: new Date().toISOString(), result: null };
  const storedCommands = await readCommands();
  storedCommands.push(command);
  await saveCommands(storedCommands);
  await addEvent("command", `${action === "lock" ? "Windows lock" : "Status refresh"} requested for ${device.name}`, device.id);
  res.status(202).json({ command: { id: command.id, action: command.action, status: command.status }, message: action === "lock" ? "Lock command queued. The Windows session will lock when the agent receives it." : "Refresh command queued." });
});
app.get("/api/commands", requireAuth, async (req, res) => {
  if (req.auth.role === "guest") return res.json({ commands: [], restricted: true, message: "Command history is available to the owner only." });
  return res.json({ commands: (await readCommands()).slice(-50).reverse().map(({ id, deviceId, action, status, createdAt, result }) => ({ id, deviceId, action, status, createdAt, result })) });
});

app.post("/api/agent/pair", async (req, res) => {
  const code = String(req.body?.code || "").trim();
  const pairing = pairCodes.get(code);
  if (!pairing || pairing.expiresAt < Date.now()) {
    pairCodes.delete(code);
    return res.status(401).json({ error: "Pairing code is invalid or expired. Generate a new code in the dashboard." });
  }
  const hostname = String(req.body?.hostname || "Windows device").slice(0, 120);
  const platform = String(req.body?.platform || "unknown").slice(0, 40);
  const deviceId = crypto.randomUUID();
  const agentToken = crypto.randomBytes(32).toString("hex");
  const device = { id: deviceId, name: hostname, hostname, platform, release: String(req.body?.release || "").slice(0, 80), arch: String(req.body?.arch || "").slice(0, 40), uptimeSeconds: Number(req.body?.uptimeSeconds) || 0, memoryTotal: Number(req.body?.memoryTotal) || 0, memoryFree: Number(req.body?.memoryFree) || 0, cpuCount: Number(req.body?.cpuCount) || 0, tokenHash: hash(agentToken), lastSeen: new Date().toISOString(), alertStatus: "online", createdAt: new Date().toISOString() };
  const devices = await readDevices();
  devices.push(device);
  await saveDevices(devices);
  pairCodes.delete(code);
  await addEvent("device", `Device paired: ${hostname}`, deviceId);
  res.status(201).json({ deviceId, agentToken, message: "Device paired successfully. Keep the agent token private." });
});
app.use("/api/agent", (req, res, next) => {
  if (req.path === "/pair" && req.method === "POST") return next();
  return requireAgent(req, res, next);
});
app.post("/api/agent/heartbeat", async (req, res) => {
  const index = req.devices.findIndex((d) => d.id === req.device.id);
  if (index < 0) return res.status(401).json({ error: "Device was unpaired." });
  const current = req.devices[index];
  for (const key of ["hostname", "platform", "release", "arch"]) {
    if (typeof req.body?.[key] === "string") current[key] = req.body[key].slice(0, 120);
  }
  for (const key of ["uptimeSeconds", "memoryTotal", "memoryFree", "cpuCount"]) {
    if (Number.isFinite(Number(req.body?.[key]))) current[key] = Number(req.body[key]);
  }
  current.name = current.hostname || current.name;
  current.lastSeen = new Date().toISOString();
  await saveDevices(req.devices);
  res.json({ status: "ok", deviceId: current.id, serverTime: new Date().toISOString() });
});
app.get("/api/agent/commands", async (req, res) => {
  const storedCommands = await readCommands();
  const pending = storedCommands.filter((c) => c.deviceId === req.device.id && c.status === "queued");
  for (const command of pending) command.status = "delivered";
  if (pending.length) await saveCommands(storedCommands);
  res.json({ commands: pending.map(({ id, action }) => ({ id, action })) });
});
app.post("/api/agent/commands/:id/result", async (req, res) => {
  const storedCommands = await readCommands();
  const command = storedCommands.find((c) => c.id === req.params.id && c.deviceId === req.device.id);
  if (!command) return res.status(404).json({ error: "Command not found." });
  command.status = req.body?.success ? "completed" : "failed";
  command.result = String(req.body?.message || "").slice(0, 240);
  command.finishedAt = new Date().toISOString();
  await saveCommands(storedCommands);
  await addEvent(command.status === "completed" ? "command" : "alert", `${command.action} ${command.status} on ${req.device.name}: ${command.result}`, req.device.id);
  if (command.action === "lock") {
    const owner = (await readUsers())[0];
    if (owner && validEmail(owner.email)) {
      const succeeded = command.status === "completed";
      const deviceName = String(req.device.name || "Windows device");
      const resultText = command.result || "No details provided.";
      const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
      const subject = succeeded ? `Laptop Guardian - Lock successful: ${deviceName}` : `Laptop Guardian - Lock failed: ${deviceName}`;
      const html = `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>${succeeded ? "Device Lock Successful" : "Device Lock Failed"}</h2><p><strong>Device:</strong> ${escapeHtml(deviceName)}</p><p><strong>Status:</strong> ${succeeded ? "Completed" : "Failed"}</p><p><strong>Details:</strong> ${escapeHtml(resultText)}</p><p><strong>Time:</strong> ${escapeHtml(command.finishedAt)}</p></div>`;
      console.log("Automatic lock email trigger reached:", command.action, command.status);
      sendResendEmail(owner.email, subject, html).catch((error) => console.error("Automatic lock email failed:", error.message));
    }
  }
  res.json({ status: "ok" });
});

// Context-aware local Guardian Assistant. It uses current device/activity data and does not send data to an external AI service.
app.post("/api/assistant", requireAuth, async (req, res) => {
  const question = String(req.body?.question || "").trim().slice(0, 500).toLowerCase();
  if (!question) return res.status(400).json({ error: "Type a question first." });
  if (req.auth.role === "guest") {
    const devices = (await readDevices()).map(safeDevice);
    const online = devices.filter((d) => d.status === "online").length;
    const offline = devices.length - online;
    let answer = `Read-only summary: ${devices.length} device(s), ${online} online, ${offline} offline. Detailed device information and security events are owner-only.`;
    if (/(lock|command|pair|unpair|setting|email|alert|activity|history)/.test(question)) {
      answer = "That information or action is restricted to Owner Mode. Guest Mode cannot send commands, pair or remove devices, view private logs, or inspect email settings.";
    } else if (/(offline|disconnected|not online|heartbeat)/.test(question)) {
      answer = `${offline} device(s) appear offline and ${online} online. Guest Mode does not expose device names or detailed telemetry. Ask the owner to inspect any offline device.`;
    }
    return res.json({ answer, source: "guest-safe-assistant", deviceCounts: { total: devices.length, online, offline } });
  }
  const devices = (await readDevices()).map(safeDevice);
  const offline = devices.filter((d) => d.status === "offline");
  const online = devices.filter((d) => d.status === "online");
  const recent = (await readEvents()).slice(-8).reverse();
  let answer;
  if (/(offline|disconnected|not online|heartbeat)/.test(question)) {
    answer = offline.length
      ? `${offline.length} device(s) are offline: ${offline.map((d) => `${d.name} (last seen ${d.lastSeen || "unknown"})`).join(", ")}. Check that the Windows Agent terminal is still running, the laptop has network access, and the backend URL in the agent config is correct. Offline alerts are triggered after the last heartbeat exceeds 35 seconds.`
      : `All ${online.length} paired device(s) currently appear online. The agent sends a heartbeat every 10 seconds; status changes to offline after 35 seconds without a heartbeat.`;
  } else if (/(lock|locked|command)/.test(question)) {
    const item = recent.find((e) => /lock|command/i.test(e.message || ""));
    answer = item ? `Latest related activity: ${item.message} (${item.createdAt}). A completed command means the agent reported its result; check the Windows session itself to verify the visible effect.` : "I could not find a recent lock-command event. Confirm the paired device is online, then issue Lock Windows from Owner Mode.";
  } else if (/(email|alert|notification)/.test(question)) {
    answer = process.env.RESEND_API_KEY && process.env.EMAIL_FROM ? "Resend appears configured. Device offline/reconnect and lock alerts are sent on status/command transitions; check the backend terminal for any 'Automatic ... email failed' messages and check Spam/Junk." : "Email delivery is not configured. Add RESEND_API_KEY and EMAIL_FROM to backend/.env, then restart the backend. Never paste the key into chat.";
  } else if (/(security|status|summary|device)/.test(question)) {
    answer = `Current device summary: ${devices.length} paired, ${online.length} online, ${offline.length} offline. Recent activity: ${recent.slice(0, 3).map((e) => e.message).join(" | ") || "no recent events"}. ${offline.length ? "Investigate offline devices first." : "No paired device is currently marked offline."}`;
  } else {
    answer = "I can help with device offline/heartbeat issues, lock-command status, email alerts, and a current security summary. Try asking: 'Why is my device offline?', 'Did the lock command work?', or 'Are email alerts configured?'";
  }
  res.json({ answer, source: "local-context-assistant", deviceCounts: { total: devices.length, online: online.length, offline: offline.length } });
});

// Device alert-state initialization is performed during startup after database connectivity is checked.
async function seedDeviceAlertState() {
  const seeded = await readDevices();
  let changed = false;
  for (const device of seeded) {
    if (!device.alertStatus) { device.alertStatus = safeDevice(device).status; changed = true; }
  }
  if (changed) await saveDevices(seeded);
}

async function notifyDeviceTransition(device, status) {
  const isOffline = status === "offline";
  const title = isOffline ? "Device offline" : "Device reconnected";
  const message = isOffline
    ? `${device.name || "Windows device"} has not sent a heartbeat for more than 35 seconds.`
    : `${device.name || "Windows device"} is sending heartbeats again.`;
  await addEvent(isOffline ? "alert" : "device", message, device.id);
  const owner = (await readUsers())[0];
  if (!owner || !validEmail(owner.email)) return;
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const subject = `Laptop Guardian - ${title}: ${device.name || "Windows device"}`;
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p><strong>Device:</strong> ${escapeHtml(device.name || device.hostname || "Windows device")}</p><p><strong>Last heartbeat:</strong> ${escapeHtml(device.lastSeen || "unknown")}</p><p><strong>Time detected:</strong> ${escapeHtml(new Date().toISOString())}</p></div>`;
  try {
    await sendResendEmail(owner.email, subject, html);
    console.log(`${title} email accepted for ${device.name || device.id}`);
  } catch (error) {
    console.error(`${title} email failed:`, error.message);
  }
}
setInterval(async () => {
  try {
    const devices = await readDevices();
    let changed = false;
    for (const device of devices) {
      const status = safeDevice(device).status;
      if (device.alertStatus !== status) {
        device.alertStatus = status;
        changed = true;
        void notifyDeviceTransition(device, status);
      }
    }
    if (changed) await saveDevices(devices);
  } catch (error) {
    console.error("Device status monitor failed:", error.message);
  }
}, 5000).unref();

app.use(express.static(FRONTEND_DIR));
app.get("/", (req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));
app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "Invalid JSON request." });
  console.error("Server error:", err.message);
  return res.status(500).json({ error: "Internal server error." });
});

async function startServer() {
  try {
    if (cloudEnabled) {
      // Fail fast rather than silently running against local data if Supabase is configured but unreachable.
      await readUsers();
      await readDevices();
      await readEvents();
      await readCommands();
      console.log("Storage mode: Supabase cloud database (local JSON files are backup mirrors).");
    } else {
      console.log("Storage mode: local JSON files. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to use Supabase.");
    }
    await seedDeviceAlertState();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Laptop Guardian API: http://localhost:${PORT}`);
      console.log("Local development mode; remote access is not enabled.");
    });
  } catch (error) {
    console.error("Startup failed while connecting to storage:", error.message);
    process.exit(1);
  }
}
startServer();
