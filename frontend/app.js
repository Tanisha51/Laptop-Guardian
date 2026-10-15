const $ = (id) => document.getElementById(id);
let sessionToken = null;
let ownerEmail = "";
let sessionRole = "owner";
let toastTimer;
let confirmAction = null;

async function api(path, body, method, token = sessionToken) {
  const verb = method || (body === undefined ? "GET" : "POST");
  const response = await fetch(path, {
    method: verb,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function showNotice(element, message, type = "") {
  element.textContent = message;
  element.className = `notice show ${type}`.trim();
}
function showToast(message, type = "") {
  const el = $("toast"); el.textContent = message; el.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3600);
}
function setServerStatus(online) {
  $("serverStatus").textContent = online ? "Server connected" : "Server unavailable";
  $("serverDot").style.background = online ? "var(--green)" : "var(--red)";
  $("serverDot").style.boxShadow = online ? "0 0 0 4px #4dd6a11a" : "0 0 0 4px #ff737e18";
  $("footerApi").textContent = online ? "API connected" : "API unavailable";
  $("serverStatus").parentElement.classList.toggle("offline", !online);
}
function timeAgo(value) {
  const t = Date.parse(value || ""); if (!Number.isFinite(t)) return "Unknown time";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(t).toLocaleString();
}
function dateTime(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
function switchView(name) {
  document.querySelectorAll(".view").forEach((el) => el.classList.remove("active-view"));
  const target = $(`view-${name}`); if (target) target.classList.add("active-view");
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.view === name));
  const labels = { overview: "Overview", devices: "My devices", activity: "Activity log", assistant: "Guardian AI", security: "Security center" };
  $("pageTitle").textContent = labels[name] || "Overview"; $("breadcrumbName").textContent = labels[name] || "Overview";
  $("sidebar").classList.remove("open");
  if (name === "devices") loadDevices(); if (name === "activity") loadActivity(); if (name === "assistant") $("assistantQuestion").focus(); if (name === "security") { if (sessionRole === "owner") loadEmailStatus(); else { $("emailStatusText").textContent = "Email provider details are available in Owner Mode only."; $("emailState").textContent = "OWNER ONLY"; $("emailState").className = "state-label warn"; } }
}
function renderActivityItem(event) {
  const symbol = event.type === "login" ? "↗" : event.type === "alert" ? "!" : event.type === "device" ? "▣" : event.type === "command" ? "⌘" : "◷";
  return `<div class="activity-item"><div class="activity-symbol">${symbol}</div><div class="activity-detail"><strong>${escapeHtml(event.message || event.type)}</strong><small>${escapeHtml(timeAgo(event.createdAt))}</small></div></div>`;
}
function renderDeviceRow(device, compact = false) {
  const online = device.status === "online";
  const details = `${escapeHtml(device.platform || "Unknown OS")}${device.release ? " · " + escapeHtml(device.release) : ""}`;
  const actions = sessionRole === "owner" ? `<div class="device-actions" data-owner-only><button class="mini-button" data-refresh-device="${escapeHtml(device.id)}">Refresh</button><button class="mini-button lock" data-lock-device="${escapeHtml(device.id)}" ${online ? "" : "disabled"}>Lock Windows</button></div>` : "";
  return `<div class="device-row"><div class="device-icon">▣</div><div class="device-main"><strong>${escapeHtml(device.name || device.hostname || "Windows device")}</strong><small>${details} · Seen ${escapeHtml(timeAgo(device.lastSeen))}</small></div><span class="status-tag ${online ? "" : "offline"}">${online ? "ONLINE" : "OFFLINE"}</span>${actions}</div>`;
}
function renderDeviceCard(device) {
  const online = device.status === "online";
  if (sessionRole === "guest") {
    return `<article class="device-card guest-device-card"><div class="device-card-head"><div class="device-icon">▣</div><div><strong>${escapeHtml(device.name || "Device")}</strong><small>Details hidden in Guest Mode</small></div><span class="status-tag ${online ? "" : "offline"}">${online ? "ONLINE" : "OFFLINE"}</span></div><div class="device-meta"><div><span class="meta-label">LAST STATUS UPDATE</span><span class="meta-value">${escapeHtml(timeAgo(device.lastSeen))}</span></div></div><p class="guest-readonly-note">Read-only view · device controls are available to the owner only.</p></article>`;
  }
  const mem = device.memoryTotal > 0 ? `${(device.memoryFree / 1024 / 1024 / 1024).toFixed(1)} GB free / ${(device.memoryTotal / 1024 / 1024 / 1024).toFixed(1)} GB` : "Not reported";
  const uptime = device.uptimeSeconds > 0 ? `${Math.floor(device.uptimeSeconds / 3600)}h ${Math.floor((device.uptimeSeconds % 3600) / 60)}m` : "Not reported";
  const actions = sessionRole === "owner" ? `<div class="device-card-actions" data-owner-only><button class="mini-button" data-refresh-device="${escapeHtml(device.id)}">↻ Refresh status</button><button class="mini-button lock" data-lock-device="${escapeHtml(device.id)}" ${online ? "" : "disabled"}>▣ Lock Windows</button><button class="mini-button" data-unpair-device="${escapeHtml(device.id)}">Unpair</button></div>` : `<p class="guest-readonly-note">Read-only view · device controls are available to the owner only.</p>`;
  return `<article class="device-card"><div class="device-card-head"><div class="device-icon">▣</div><div><strong>${escapeHtml(device.name || "Windows device")}</strong><small>${escapeHtml(device.hostname || "Unknown hostname")}</small></div><span class="status-tag ${online ? "" : "offline"}">${online ? "ONLINE" : "OFFLINE"}</span></div><div class="device-meta"><div><span class="meta-label">OPERATING SYSTEM</span><span class="meta-value">${escapeHtml(device.platform || "Unknown")} ${escapeHtml(device.release || "")}</span></div><div><span class="meta-label">CPU CORES</span><span class="meta-value">${Number(device.cpuCount) || "—"}</span></div><div><span class="meta-label">MEMORY</span><span class="meta-value">${escapeHtml(mem)}</span></div><div><span class="meta-label">UPTIME</span><span class="meta-value">${escapeHtml(uptime)}</span></div><div><span class="meta-label">LAST HEARTBEAT</span><span class="meta-value">${escapeHtml(timeAgo(device.lastSeen))}</span></div><div><span class="meta-label">PAIRED</span><span class="meta-value">${escapeHtml(dateTime(device.createdAt))}</span></div></div>${actions}</article>`;
}
async function loadDashboard() {
  try {
    const data = await api("/api/dashboard"); setServerStatus(true);
    $("statTotal").textContent = data.stats.total; $("statOnline").textContent = data.stats.online; $("statOffline").textContent = data.stats.offline; $("statAlerts").textContent = data.stats.alerts;
    $("navDeviceCount").textContent = data.stats.total;
    $("overviewDevices").innerHTML = data.devices.length ? data.devices.slice(0, 4).map((d) => renderDeviceRow(d, true)).join("") : `<div class="empty-state"><div class="empty-icon">▣</div><strong>No devices paired yet</strong><p>Pair the Windows Agent to start receiving real device status.</p><button class="btn primary" data-pair>Pair your first device</button></div>`;
    $("overviewActivity").innerHTML = data.events.length ? data.events.slice(0, 6).map(renderActivityItem).join("") : `<div class="empty-small">No activity recorded yet.</div>`;
  } catch (error) { setServerStatus(false); if (error.message.toLowerCase().includes("session") || error.message.toLowerCase().includes("log in")) logout(false); else showToast(error.message, "error"); }
}
async function loadDevices() {
  try { const data = await api("/api/devices"); $("navDeviceCount").textContent = data.devices.length; $("allDevices").innerHTML = data.devices.length ? data.devices.map(renderDeviceCard).join("") : `<div class="empty-state"><div class="empty-icon">▣</div><strong>No devices paired</strong><p>Generate a pairing code, then run the Windows Agent on the device.</p><button class="btn primary" data-pair>Pair your first device</button></div>`; }
  catch (error) { showToast(error.message, "error"); }
}
async function loadActivity() {
  try { const data = await api("/api/activity"); $("activityTable").innerHTML = data.restricted ? `<tr><td colspan="4" class="empty-cell">Activity history is available in Owner Mode only.</td></tr>` : data.events.length ? data.events.map((e) => `<tr><td><span class="event-type ${escapeHtml(e.type)}">${escapeHtml(e.type)}</span></td><td>${escapeHtml(e.message)}</td><td>${escapeHtml(e.deviceId || "Owner / system")}</td><td>${escapeHtml(dateTime(e.createdAt))}</td></tr>`).join("") : `<tr><td colspan="4" class="empty-cell">No activity yet.</td></tr>`; }
  catch (error) { showToast(error.message, "error"); }
}
async function loadEmailStatus() {
  try { const data = await api("/api/config/status"); $("emailStatusText").textContent = data.emailConfigured ? "Resend is configured. Device offline/reconnect and lock-result email alerts are enabled." : "Not configured. Add RESEND_API_KEY and EMAIL_FROM to backend/.env to enable real email delivery."; $("emailState").textContent = data.emailConfigured ? "PROVIDER CONFIGURED" : "NEEDS SETUP"; $("emailState").className = `state-label ${data.emailConfigured ? "good" : "warn"}`; }
  catch { $("emailStatusText").textContent = "Could not read provider configuration."; $("emailState").textContent = "UNAVAILABLE"; }
}
async function openPairDialog() {
  $("pairCodeWrap").classList.add("hidden"); $("pairMessage").className = "notice"; $("pairMessage").textContent = ""; $("generatePairCode").disabled = false; $("generatePairCode").textContent = "Generate pairing code";
  if (!$("pairDialog").open) $("pairDialog").showModal();
}
async function generatePairCode() {
  const button = $("generatePairCode"); button.disabled = true; button.textContent = "Generating…";
  try { const data = await api("/api/devices/pairing", {}); $("pairCode").textContent = data.code; $("pairExpiry").textContent = `Expires at ${new Date(data.expiresAt).toLocaleTimeString()} · one-time use`; $("pairCodeWrap").classList.remove("hidden"); showNotice($("pairMessage"), "Pairing code generated. Run the agent command on the Windows laptop now.", "success"); button.textContent = "Generate new code"; button.disabled = false; }
  catch (error) { showNotice($("pairMessage"), error.message, "error"); button.disabled = false; button.textContent = "Try again"; }
}
function askConfirm(title, text, action, buttonText = "Confirm") {
  $("confirmTitle").textContent = title; $("confirmText").textContent = text; $("confirmProceed").textContent = buttonText; confirmAction = action; $("confirmDialog").showModal();
}
async function runDeviceAction(id, action) {
  try { const data = await api(`/api/devices/${encodeURIComponent(id)}/commands`, { action }); showToast(data.message); await loadDashboard(); if ($("view-devices").classList.contains("active-view")) await loadDevices(); }
  catch (error) { showToast(error.message, "error"); }
}
async function unpairDevice(id) {
  try { const data = await api(`/api/devices/${encodeURIComponent(id)}`, undefined, "DELETE"); showToast(data.message); await loadDashboard(); await loadDevices(); await loadActivity(); }
  catch (error) { showToast(error.message, "error"); }
}
function logout(showMessage = true) {
  sessionToken = null; ownerEmail = ""; sessionRole = "owner"; $("appShell").classList.remove("guest-mode"); $("appShell").classList.add("hidden"); $("authScreen").classList.remove("hidden"); $("password").value = ""; if (showMessage) showNotice($("authMessage"), "You have been signed out.", "success");
}
function enterWorkspace(data, role) {
  sessionToken = data.token;
  sessionRole = role;
  ownerEmail = role === "guest" ? "Read-only session" : data.user.email;
  $("ownerEmail").textContent = ownerEmail;
  $("accessRole").textContent = role === "guest" ? "Guest Mode" : "Owner";
  $("avatarInitials").textContent = role === "guest" ? "GU" : ownerEmail.slice(0, 2).toUpperCase();
  $("appShell").classList.toggle("guest-mode", role === "guest");
  $("authScreen").classList.add("hidden"); $("appShell").classList.remove("hidden"); $("password").value = ""; $("authMessage").className = "notice";
  switchView("overview");
  loadDashboard();
  if (role === "owner") loadEmailStatus();
  else {
    $("emailStatusText").textContent = "Email provider details are available in Owner Mode only.";
    $("emailState").textContent = "OWNER ONLY";
    $("emailState").className = "state-label warn";
  }
}
async function signIn(event) {
  event.preventDefault(); const email = $("email").value.trim().toLowerCase(); const password = $("password").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showNotice($("authMessage"), "Enter a valid email address.", "error"); return; }
  if (!password || password.length > 72) { showNotice($("authMessage"), "Enter your owner password (maximum 72 characters).", "error"); return; }
  const button = $("loginButton"); button.disabled = true; button.innerHTML = "<span>Verifying…</span><span>◌</span>";
  try { const data = await api("/api/auth/login", { email, password }, "POST", null); enterWorkspace(data, "owner"); }
  catch (error) { showNotice($("authMessage"), error.message, "error"); }
  finally { button.disabled = false; button.innerHTML = "<span>Sign in securely</span><span aria-hidden=\"true\">↗</span>"; }
}
async function startGuestMode() {
  const button = $("guestModeButton"); button.disabled = true; button.textContent = "Starting guest session…";
  try { const data = await api("/api/auth/guest", {}, "POST", null); enterWorkspace(data, "guest"); showToast("Guest Mode enabled — read-only access"); }
  catch (error) { showNotice($("authMessage"), error.message, "error"); }
  finally { button.disabled = false; button.textContent = "Continue in Guest Mode (read-only)"; }
}
async function askGuardianAssistant(question) {
  const q = String(question ?? $("assistantQuestion").value).trim();
  if (!q) return showToast("Type a question first.", "error");
  $("assistantQuestion").value = q; $("assistantAsk").disabled = true; $("assistantAsk").textContent = "Checking…"; $("assistantAnswer").textContent = "Reviewing current device and activity data…";
  try { const data = await api("/api/assistant", { question: q }); $("assistantAnswer").textContent = data.answer; }
  catch (error) { $("assistantAnswer").textContent = error.message; showToast(error.message, "error"); }
  finally { $("assistantAsk").disabled = false; $("assistantAsk").textContent = "Ask Guardian"; }
}
async function registerOwner() {
  const email = $("email").value.trim().toLowerCase(); const password = $("password").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showNotice($("authMessage"), "Enter a valid email address first.", "error"); return; }
  if (password.length < 12 || password.length > 72) { showNotice($("authMessage"), "Choose a password between 12 and 72 characters.", "error"); return; }
  try { const data = await api("/api/auth/register", { email, password }, "POST", null); showNotice($("authMessage"), data.message, "success"); $("password").value = ""; }
  catch (error) { showNotice($("authMessage"), error.message, "error"); }
}

$("loginForm").addEventListener("submit", signIn);
$("registerButton").addEventListener("click", registerOwner);
$("guestModeButton").addEventListener("click", startGuestMode);
$("assistantAsk").addEventListener("click", () => askGuardianAssistant());
$("assistantQuestion").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) askGuardianAssistant(); });
document.querySelectorAll("[data-assistant-prompt]").forEach((button) => button.addEventListener("click", () => askGuardianAssistant(button.dataset.assistantPrompt)));
$("logoutButton").addEventListener("click", () => logout());
$("sidebarLogout").addEventListener("click", () => logout());
$("menuButton").addEventListener("click", () => $("sidebar").classList.toggle("open"));
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.go)));
["pairDeviceButton", "pairDeviceButton2", "pairBannerButton"].forEach((id) => $(id).addEventListener("click", openPairDialog));
document.addEventListener("click", (event) => {
  if (sessionRole === "guest" && event.target.closest("[data-pair], [data-refresh-device], [data-lock-device], [data-unpair-device]")) {
    event.preventDefault(); showToast("Guest Mode is read-only. Sign in as Owner to manage devices.", "error"); return;
  }
  if (event.target.closest("[data-pair]")) openPairDialog();
  const refresh = event.target.closest("[data-refresh-device]"); if (refresh) runDeviceAction(refresh.dataset.refreshDevice, "refresh");
  const lock = event.target.closest("[data-lock-device]"); if (lock) askConfirm("Lock this Windows session?", "This sends a command to the paired Windows Agent. The active Windows session will lock; you must sign in on the device to unlock it.", () => runDeviceAction(lock.dataset.lockDevice, "lock"), "Lock Windows");
  const unpair = event.target.closest("[data-unpair-device]"); if (unpair) askConfirm("Unpair this device?", "The device will be removed from your dashboard and its agent token will stop working.", () => unpairDevice(unpair.dataset.unpairDevice), "Unpair device");
});
$("generatePairCode").addEventListener("click", generatePairCode);
$("closePairDialog").addEventListener("click", () => $("pairDialog").close());
$("confirmCancel").addEventListener("click", () => { confirmAction = null; $("confirmDialog").close(); });
$("confirmProceed").addEventListener("click", async () => { const action = confirmAction; confirmAction = null; $("confirmDialog").close(); if (action) await action(); });
$("refreshActivity").addEventListener("click", loadActivity);
$("testEmailButton").addEventListener("click", async () => {
  const button = $("testEmailButton"); button.disabled = true; button.textContent = "Sending…";
  try { const data = await api("/api/notifications/test", {}); showToast(data.message); await loadActivity(); }
  catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "Send test email"; }
});

// Keep status current while the authenticated dashboard is open.
setInterval(() => { if (sessionToken && !$("appShell").classList.contains("hidden")) loadDashboard(); }, 10000);
api("/api/health", undefined, "GET", null).then(() => setServerStatus(true)).catch(() => setServerStatus(false));
