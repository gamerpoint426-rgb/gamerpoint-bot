const mineflayer = require("mineflayer");

const HOST = process.env.VELOCITY_HOST || "play.gamerpointmc.qzz.io";
const PORT = Number(process.env.VELOCITY_PORT || 25565);
const USERNAME = process.env.BOT_NAME || "Lobby";
const PASSWORD = process.env.BOT_PASSWORD || "Notgpbot1";
const TARGET = process.env.BOT_TARGET || "lobby";
const MC_VERSION = process.env.MC_VERSION || "1.21.11";
const LOGIN_DELAY = Math.max(0, Number(process.env.LOGIN_DELAY_MS || 1500));
const LOGIN_RETRY_INTERVAL = Math.max(2000, Number(process.env.LOGIN_RETRY_INTERVAL_MS || 5000));
const MAX_LOGIN_RETRIES = Math.max(1, Number(process.env.MAX_LOGIN_RETRIES || 10));
const ROUTE_DELAY = Math.max(0, Number(process.env.ROUTE_DELAY_MS || 30000));
const DISCONNECT_INTERVAL = Math.max(0, Number(process.env.DISCONNECT_INTERVAL_MS || 0));
const RECONNECT_DELAY = Math.max(1000, Number(process.env.RECONNECT_DELAY_MS || 5000));
const DEBUG_CHAT = String(process.env.DEBUG_CHAT || "true").toLowerCase() !== "false";

let bot = null;
let authenticated = false;
let routeSent = false;
let routeTimer = null;
let reconnectTimer = null;
let periodicDisconnectTimer = null;
let loginTimer = null;
let loginAttempts = 0;
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
  try {
    if (typeof reason.toString === "function") {
      const s = reason.toString();
      if (s && s !== "[object Object]") return s;
    }
  } catch {}
  try { return JSON.stringify(reason); } catch { return String(reason); }
}

function messageText(jsonMsg) {
  try { return jsonMsg.toString(); } catch { return String(jsonMsg); }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_DELAY);
  log(`Reconnecting in ${Math.round(RECONNECT_DELAY / 1000)} seconds...`);
}

function schedulePeriodicDisconnect() {
  if (stopping || !DISCONNECT_INTERVAL) return;
  if (periodicDisconnectTimer) clearTimeout(periodicDisconnectTimer);
  periodicDisconnectTimer = setTimeout(() => {
    periodicDisconnectTimer = null;
    if (!bot || stopping) return schedulePeriodicDisconnect();
    log(`Scheduled disconnect after ${Math.round(DISCONNECT_INTERVAL / 1000)} seconds; reconnect will follow.`);
    try { bot.quit("Scheduled reconnect"); } catch {}
  }, DISCONNECT_INTERVAL);
  log(`Scheduled disconnect/reconnect every ${Math.round(DISCONNECT_INTERVAL / 1000)} seconds.`);
}

function detectServer(text) {
  const clean = String(text).replace(/§[0-9a-fk-or]/gi, "");
  const patterns = [
    /(?:connected|connecting|switched|moved|sent)\s+(?:you\s+)?to\s+(?:server\s+)?([a-z0-9_-]+)/i,
    /(?:server|lobby)\s*[:=]\s*([a-z0-9_-]+)/i,
    /(?:currently|now)\s+(?:on|connected to)\s+(?:server\s+)?([a-z0-9_-]+)/i,
    /(?:joined|entered)\s+(?:server\s+)?([a-z0-9_-]+)/i
  ];
  for (const re of patterns) { const m = clean.match(re); if (m) return m[1].toLowerCase(); }
  return null;
}

function looksAuthenticated(text) {
  const t = text.toLowerCase();
  return [
    "login successful", "successfully logged", "successfully logged in", "logged in successfully",
    "you are now logged in", "you are logged in", "authentication successful", "authenticated",
    "welcome back", "login complete", "logged-in", "logged in"
  ].some(x => t.includes(x));
}

function sendLogin() {
  if (!bot || stopping || authenticated) return;
  if (loginAttempts >= MAX_LOGIN_RETRIES) {
    log(`Login retry limit reached (${MAX_LOGIN_RETRIES}). Waiting for server response/kick.`);
    return;
  }
  loginAttempts++;
  log(`Sending /login attempt ${loginAttempts}/${MAX_LOGIN_RETRIES}`);
  try { bot.chat(`/login ${PASSWORD}`); } catch (err) { log(`Login command error: ${err.message}`); }
  if (!authenticated && loginAttempts < MAX_LOGIN_RETRIES) {
    loginTimer = setTimeout(() => { loginTimer = null; sendLogin(); }, LOGIN_RETRY_INTERVAL);
  }
}

function markAuthenticated(source) {
  if (authenticated) return;
  authenticated = true;
  if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; }
  log(`Authentication detected (${source}); routing in ${Math.round(ROUTE_DELAY / 1000)} seconds`);
  if (routeTimer) clearTimeout(routeTimer);
  routeTimer = setTimeout(() => {
    if (!bot || stopping || routeSent) return;
    routeSent = true;
    log(`Sending /server ${TARGET}`);
    try { bot.chat(`/server ${TARGET}`); } catch (err) { log(`Route command error: ${err.message}`); }
    schedulePeriodicDisconnect();
  }, ROUTE_DELAY);
}

function connect() {
  if (stopping) return;
  clearTimers();
  authenticated = false;
  routeSent = false;
  loginAttempts = 0;

  log(`Connecting to ${HOST}:${PORT} -> ${TARGET} (MC ${MC_VERSION})`);
  try {
    bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username: USERNAME,
      version: MC_VERSION,
      auth: "offline",
      hideErrors: false
    });
  } catch (err) {
    log(`Create bot error: ${err.message}`);
    return scheduleReconnect();
  }

  bot.once("spawn", () => {
    log("Spawned; waiting before login");
    loginTimer = setTimeout(() => { loginTimer = null; sendLogin(); }, LOGIN_DELAY);
  });

  bot.on("message", jsonMsg => {
    const raw = messageText(jsonMsg);
    const detected = detectServer(raw);
    if (DEBUG_CHAT) log(`[CHAT] ${raw}`);
    if (detected) log(`Server detected: ${detected}`);
    if (looksAuthenticated(raw)) markAuthenticated("chat message");
  });

  bot.on("kicked", reason => {
    log(`KICKED reason: ${readableReason(reason)}`);
  });

  bot.on("error", err => {
    log(`Error: ${err && err.stack ? err.stack : err.message || err}`);
  });

  bot.on("end", reason => {
    log(`Disconnected: ${readableReason(reason)}`);
    bot = null;
    if (periodicDisconnectTimer) { clearTimeout(periodicDisconnectTimer); periodicDisconnectTimer = null; }
    if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; }
    scheduleReconnect();
  });
}

process.on("SIGTERM", () => {
  stopping = true;
  clearTimers();
  if (bot) { try { bot.quit("Panel stop"); } catch {} }
  setTimeout(() => process.exit(0), 500);
});
process.on("SIGINT", () => process.emit("SIGTERM"));
connect();
