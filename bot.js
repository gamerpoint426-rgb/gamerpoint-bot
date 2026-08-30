const mineflayer = require("mineflayer");
const fs = require("fs");
const path = require("path");

const HOST = process.env.BOT_HOST || process.env.VELOCITY_HOST || "play.gamerpointmc.qzz.io";
const PORT = Number(process.env.BOT_PORT || process.env.VELOCITY_PORT || 25565);
const USERNAME = process.env.BOT_NAME || "Lobby";
const PASSWORD = process.env.BOT_PASSWORD || "Notgpbot1";
const TARGET = (process.env.BOT_TARGET || "lobby").toLowerCase();
const DIRECT_CONNECT = String(process.env.DIRECT_CONNECT || "false").toLowerCase() === "true";
const MC_VERSION = process.env.MC_VERSION || "1.21.11";
const LOGIN_DELAY = Math.max(0, Number(process.env.LOGIN_DELAY_MS || 1500));
const LOGIN_RETRY_INTERVAL = Math.max(5000, Number(process.env.LOGIN_RETRY_INTERVAL_MS || 7000));
const MAX_LOGIN_RETRIES = Math.max(1, Number(process.env.MAX_LOGIN_RETRIES || 3));
const ROUTE_DELAY = Math.max(0, Number(process.env.ROUTE_DELAY_MS || 4000));
const ROUTE_RETRY_INTERVAL = Math.max(5000, Number(process.env.ROUTE_RETRY_INTERVAL_MS || 7000));
const MAX_ROUTE_RETRIES = Math.max(1, Number(process.env.MAX_ROUTE_RETRIES || 8));
const DISCONNECT_INTERVAL = Math.max(0, Number(process.env.DISCONNECT_INTERVAL_MS || 600000));
const RECONNECT_DELAY = Math.max(3000, Number(process.env.RECONNECT_DELAY_MS || 5000));
const DEBUG_CHAT = String(process.env.DEBUG_CHAT || "true").toLowerCase() !== "false";
const DOWNLOAD_RESOURCE_PACK = String(process.env.DOWNLOAD_RESOURCE_PACK || "true").toLowerCase() !== "false";
const RESOURCE_PACK_DIR = process.env.RESOURCE_PACK_DIR || path.join(__dirname, "resource-packs");


let bot = null;
let authenticated = false;
let loginSent = false;
let routeSent = TARGET === "lobby";
let routeTimer = null;
let reconnectTimer = null;
let periodicDisconnectTimer = null;
let loginTimer = null;
let loginAttempts = 0;
let routeAttempts = 0;
let stopping = false;

function log(msg) { console.log(`[${USERNAME}] ${msg}`); }
function clearTimers() {
  if (routeTimer) clearTimeout(routeTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (periodicDisconnectTimer) clearTimeout(periodicDisconnectTimer);
  if (loginTimer) clearTimeout(loginTimer);
  routeTimer = reconnectTimer = periodicDisconnectTimer = loginTimer = null;
}

function readableReason(reason) {
  if (reason == null) return "unknown";
  if (typeof reason === "string") return reason;
  try { if (typeof reason.toString === "function") { const s = reason.toString(); if (s && s !== "[object Object]") return s; } } catch {}
  try { return JSON.stringify(reason); } catch { return String(reason); }
}
function messageText(jsonMsg) { try { return jsonMsg.toString(); } catch { return String(jsonMsg); } }

function uuidText(uuid) {
  if (uuid == null) return "unknown";
  if (typeof uuid === "string") return uuid;
  try { if (typeof uuid.toString === "function") return uuid.toString(); } catch {}
  return String(uuid);
}

async function downloadResourcePack(url, uuid) {
  if (!DOWNLOAD_RESOURCE_PACK || !url || !/^https?:\/\//i.test(String(url))) return;
  try {
    fs.mkdirSync(RESOURCE_PACK_DIR, { recursive: true });
    const safe = uuidText(uuid).replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = path.join(RESOURCE_PACK_DIR, `${safe}.zip`);
    log(`[ResourcePack] Downloading ${url}`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(file, buffer);
    log(`[ResourcePack] Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB -> ${file}`);
  } catch (err) {
    log(`[ResourcePack] Download failed: ${err.message}`);
  }
}

function attachResourcePackHandlers() {
  if (!bot || !bot._client) return;
  const client = bot._client;

  // Minecraft 1.21.x: server sends add_resource_pack and expects
  // resource_pack_receive with result 3 (accepted), then 0 (successfully loaded).
  client.on("add_resource_pack", data => {
    const uuid = data && data.uuid;
    const url = data && data.url;
    log(`[ResourcePack] Server requested pack${url ? `: ${url}` : ""}`);
    try {
      client.write("resource_pack_receive", { uuid, result: 3 });
      log("[ResourcePack] Accepted.");
    } catch (err) {
      log(`[ResourcePack] Accept packet failed: ${err.message}`);
      return;
    }
    downloadResourcePack(url, uuid);
    setTimeout(() => {
      try {
        client.write("resource_pack_receive", { uuid, result: 0 });
        log("[ResourcePack] Reported successfully loaded.");
      } catch (err) {
        log(`[ResourcePack] Loaded packet failed: ${err.message}`);
      }
    }, 1000);
  });

  // Older protocol fallback.
  client.on("resource_pack_send", data => {
    const hash = data && data.hash;
    const url = data && data.url;
    log(`[ResourcePack] Legacy pack requested${url ? `: ${url}` : ""}`);
    try {
      client.write("resource_pack_receive", { hash, result: 3 });
      setTimeout(() => {
        try { client.write("resource_pack_receive", { hash, result: 0 }); } catch {}
      }, 1000);
      downloadResourcePack(url, hash);
    } catch (err) {
      log(`[ResourcePack] Legacy response failed: ${err.message}`);
    }
  });


}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_DELAY);
  log(`Reconnecting in ${Math.round(RECONNECT_DELAY / 1000)} seconds...`);
}
function schedulePeriodicDisconnect() {
  if (stopping || !DISCONNECT_INTERVAL || !routeSent) return;
  if (periodicDisconnectTimer) clearTimeout(periodicDisconnectTimer);
  periodicDisconnectTimer = setTimeout(() => {
    periodicDisconnectTimer = null;
    if (!bot || stopping) return schedulePeriodicDisconnect();
    log(`Scheduled disconnect after ${Math.round(DISCONNECT_INTERVAL / 1000)} seconds; reconnect will follow.`);
    try { bot.quit("Scheduled reconnect"); } catch {}
  }, DISCONNECT_INTERVAL);
}

function detectServer(text) {
  const clean = String(text).replace(/§[0-9a-fk-or]/gi, "");
  const patterns = [
    /(?:connected|connecting|switched|moved|sent|transferred)\s+(?:you\s+)?to\s+(?:server\s+)?([a-z0-9_-]+)/i,
    /(?:server|lobby)\s*[:=]\s*([a-z0-9_-]+)/i,
    /(?:currently|now)\s+(?:on|connected to)\s+(?:server\s+)?([a-z0-9_-]+)/i,
    /(?:joined|entered)\s+(?:server\s+)?([a-z0-9_-]+)/i,
    /(?:switching|connecting)\s+to\s+([a-z0-9_-]+)/i
  ];
  for (const re of patterns) { const m = clean.match(re); if (m) return m[1].toLowerCase(); }
  return null;
}
function looksAuthenticated(text) {
  const t = text.toLowerCase();
  return [
    "login successful", "successfully logged", "successfully logged in", "logged in successfully",
    "you are now logged in", "you are logged in", "authentication successful", "authenticated",
    "welcome back", "login complete", "logged-in", "logged in", "password accepted", "login accepted", "authentication complete", "registration successful",
    "successfully registered", "registered successfully", "you have been registered", "registration complete",
    "account registered"
  ].some(x => t.includes(x));
}
function isRegisterPrompt(text) {
  const t = text.toLowerCase();
  return t.includes("please, register") || t.includes("please register") || t.includes("use /register") || t.includes("using /register") || t.includes("register using") || (t.includes("registration") && t.includes("/register"));
}
function isLoginPrompt(text) {
  const t = text.toLowerCase();
  return t.includes("please, login") || t.includes("please login") || t.includes("use /login") || t.includes("using /login") || t.includes("login using") || t.includes("enter your password") || (t.includes("authentication") && t.includes("/login"));
}

function cancelLoginTimer() { if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; } }

function sendRegister() {
  if (!bot || stopping || authenticated || loginSent) return;
  cancelLoginTimer();
  loginSent = true;
  log("Authentication prompt detected; sending registration command once.");
  try { bot.chat(`/register ${PASSWORD} ${PASSWORD}`); } catch (err) { loginSent = false; log(`Register command error: ${err.message}`); }
}
function sendLogin() {
  if (!bot || stopping || authenticated || loginSent) return;
  if (loginAttempts >= MAX_LOGIN_RETRIES) { log(`Login retry limit reached (${MAX_LOGIN_RETRIES}).`); return; }
  loginAttempts++;
  loginSent = true;
  cancelLoginTimer();
  log(`Sending /login attempt ${loginAttempts}/${MAX_LOGIN_RETRIES}`);
  try {
    bot.chat(`/login ${PASSWORD}`);
    // Do not immediately switch while LimboAuth is still processing /login.
    // markAuthenticated() will schedule the first /server command after the
    // proxy confirms authentication. If the plugin does not send a success
    // message, the login prompt handler below still gives us a fallback route.
    log(`Login command sent; waiting for authentication before routing to ${TARGET}.`);
  } catch (err) { loginSent = false; log(`Login command error: ${err.message}`); }
}

function sendRoute() {
  if (!bot || stopping || routeSent) return;
  if (DIRECT_CONNECT || !TARGET || TARGET === "lobby") { routeSent = true; log(DIRECT_CONNECT ? `Direct connection to ${HOST}:${PORT}; no /server switch required.` : "Target is lobby; no server switch required."); schedulePeriodicDisconnect(); return; }
  // Never send /server while we are still waiting for LimboAuth.
  if (!authenticated) {
    log(`Waiting for authentication confirmation before switching to ${TARGET}.`);
    return;
  }
  if (routeAttempts >= MAX_ROUTE_RETRIES) { log(`Server switch retry limit reached (${MAX_ROUTE_RETRIES}) for ${TARGET}.`); return schedulePeriodicDisconnect(); }
  routeAttempts++;
  log(`Switching to server ${TARGET} (attempt ${routeAttempts}/${MAX_ROUTE_RETRIES})`);
  try {
    bot.chat(`/server ${TARGET}`);
    log(`Sent /server ${TARGET}.`);
  } catch (err) { log(`Server switch command error: ${err.message}`); }
  if (routeAttempts < MAX_ROUTE_RETRIES && !routeSent) {
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = setTimeout(() => { routeTimer = null; sendRoute(); }, ROUTE_RETRY_INTERVAL);
  }
}

function markAuthenticated(source) {
  if (authenticated) return;
  authenticated = true;
  cancelLoginTimer();
  loginSent = true;
  routeAttempts = 0;
  log(`Authentication detected (${source}).`);
  if (DIRECT_CONNECT || TARGET === "lobby") { routeSent = true; schedulePeriodicDisconnect(); return; }
  if (routeTimer) clearTimeout(routeTimer);
  routeTimer = setTimeout(() => { routeTimer = null; sendRoute(); }, ROUTE_DELAY);
  log(`Target ${TARGET}: server switch scheduled in ${Math.round(ROUTE_DELAY / 1000)} seconds.`);
}

function connect() {
  if (stopping) return;
  clearTimers();
  authenticated = false;
  loginSent = false;
  routeSent = TARGET === "lobby";
  routeAttempts = 0;
  loginAttempts = 0;

  log(`Connecting to ${HOST}:${PORT} -> ${TARGET} (MC ${MC_VERSION})`);
  try {
    bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: MC_VERSION, auth: "offline", hideErrors: false, checkTimeoutInterval: 30000 });
    attachResourcePackHandlers();
  } catch (err) { log(`Create bot error: ${err.message}`); return scheduleReconnect(); }

  bot.once("spawn", () => {
    log(DIRECT_CONNECT ? `Connected directly to ${HOST}:${PORT}; waiting for authentication.` : "Connected to proxy; waiting for authentication.");
    loginTimer = setTimeout(() => {
      loginTimer = null;
      if (!authenticated && !loginSent) sendLogin();
      // Fallback for auth plugins that do not emit a recognizable success
      // message: after the login command has had time to complete, try the
      // requested Velocity server. This is still guarded by routeSent and
      // the retry limit.
      if (!DIRECT_CONNECT && TARGET !== "lobby" && !authenticated) {
        setTimeout(() => {
          if (bot && !stopping && !routeSent && loginSent) {
            authenticated = true;
            log("No explicit authentication-success message detected; using delayed routing fallback.");
            sendRoute();
          }
        }, Math.max(ROUTE_DELAY, 4000));
      }
    }, LOGIN_DELAY);
  });

  bot.on("message", jsonMsg => {
    const raw = messageText(jsonMsg);
    const detected = detectServer(raw);
    if (DEBUG_CHAT) log(`[CHAT] ${raw}`);
    if (detected) {
      log(`Server detected: ${detected}`);
      if (TARGET === detected) {
        routeSent = true;
        if (routeTimer) { clearTimeout(routeTimer); routeTimer = null; }
        log(`Target server ${TARGET} confirmed.`);
        schedulePeriodicDisconnect();
      }
    }
    if (looksAuthenticated(raw)) { markAuthenticated("LimboAuth success message"); return; }
    const lower = raw.toLowerCase();
    if (TARGET !== "lobby" && !DIRECT_CONNECT && (
      lower.includes("server not found") || lower.includes("unknown server") ||
      lower.includes("no such server") || lower.includes("could not connect to") ||
      lower.includes("you don't have permission") || lower.includes("no permission")
    )) {
      log(`[ROUTE] Proxy rejected /server ${TARGET}: ${raw}`);
    }
    if (isRegisterPrompt(raw)) { loginSent = false; sendRegister(); return; }
    if (isLoginPrompt(raw)) { loginSent = false; sendLogin(); return; }
  });

  bot.on("kicked", reason => {
    log(`KICKED reason: ${readableReason(reason)}`);
    // Mineflayer normally follows kicked with end; this guard also ensures a 5-minute reconnect if it does not.
    scheduleReconnect();
  });
  bot.on("error", err => log(`Error: ${err && err.stack ? err.stack : err.message || err}`));
  bot.on("end", reason => {
    log(`Disconnected: ${readableReason(reason)}`);
    bot = null;
    clearTimers();
    scheduleReconnect();
  });
}

process.on("SIGTERM", () => { stopping = true; clearTimers(); if (bot) { try { bot.quit("Panel stop"); } catch {} } setTimeout(() => process.exit(0), 500); });
process.on("SIGINT", () => process.emit("SIGTERM"));
connect();
