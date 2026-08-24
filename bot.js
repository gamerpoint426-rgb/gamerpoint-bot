const mineflayer = require("mineflayer");

const HOST = process.env.VELOCITY_HOST || "play.gamerpointmc.qzz.io";
const PORT = Number(process.env.VELOCITY_PORT || 25565);
const USERNAME = process.env.BOT_NAME || "Lobby";
const PASSWORD = process.env.BOT_PASSWORD || "Notgpbot1";
const TARGET = (process.env.BOT_TARGET || "lobby").toLowerCase();
const MC_VERSION = process.env.MC_VERSION || "1.21.11";
// Standard Minecraft client-brand value. Mineflayer sends this through the
// protocol at the appropriate state for the negotiated Minecraft version.
const CLIENT_BRAND = process.env.CLIENT_BRAND || "vanilla";
const LOGIN_DELAY = Math.max(0, Number(process.env.LOGIN_DELAY_MS || 1500));
const LOGIN_RETRY_INTERVAL = Math.max(5000, Number(process.env.LOGIN_RETRY_INTERVAL_MS || 7000));
const MAX_LOGIN_RETRIES = Math.max(1, Number(process.env.MAX_LOGIN_RETRIES || 3));
const ROUTE_DELAY = Math.max(0, Number(process.env.ROUTE_DELAY_MS || 5000));
const ROUTE_RETRY_INTERVAL = Math.max(5000, Number(process.env.ROUTE_RETRY_INTERVAL_MS || 7000));
const MAX_ROUTE_RETRIES = Math.max(1, Number(process.env.MAX_ROUTE_RETRIES || 3));
const DISCONNECT_INTERVAL = Math.max(0, Number(process.env.DISCONNECT_INTERVAL_MS || 0));
const RECONNECT_DELAY = Math.max(3000, Number(process.env.RECONNECT_DELAY_MS || 5000));
const DEBUG_CHAT = String(process.env.DEBUG_CHAT || "true").toLowerCase() !== "false";

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
    if (TARGET !== "lobby") {
      if (routeTimer) clearTimeout(routeTimer);
      routeTimer = setTimeout(() => { routeTimer = null; sendRoute(); }, ROUTE_DELAY);
      log(`Target ${TARGET}: server switch scheduled after login delay.`);
    }
  } catch (err) { loginSent = false; log(`Login command error: ${err.message}`); }
}

function sendRoute() {
  if (!bot || stopping || routeSent) return;
  if (!TARGET || TARGET === "lobby") { routeSent = true; log("Target is lobby; no server switch required."); schedulePeriodicDisconnect(); return; }
  if (!authenticated && !loginSent) return;
  if (routeAttempts >= MAX_ROUTE_RETRIES) { log(`Server switch retry limit reached (${MAX_ROUTE_RETRIES}) for ${TARGET}.`); return schedulePeriodicDisconnect(); }
  routeAttempts++;
  log(`Switching to server ${TARGET} (attempt ${routeAttempts}/${MAX_ROUTE_RETRIES})`);
  try { bot.chat(`/server ${TARGET}`); }
  catch (err) { log(`Server switch command error: ${err.message}`); }
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
  if (TARGET === "lobby") { routeSent = true; schedulePeriodicDisconnect(); return; }
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
    bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username: USERNAME,
      version: MC_VERSION,
      auth: "offline",
      brand: CLIENT_BRAND,
      hideErrors: false
    });
  } catch (err) { log(`Create bot error: ${err.message}`); return scheduleReconnect(); }

  // Protocol diagnostics: useful when a proxy/anti-bot plugin reports a missing
  // client brand. Mineflayer handles the actual brand packet; these logs expose
  // the negotiated protocol and disconnect reason without spoofing the check.
  if (bot._client) {
    log(`Protocol client initialized: version=${MC_VERSION}, brand=${CLIENT_BRAND}`);
    bot._client.on("error", err => log(`Protocol error: ${err && err.stack ? err.stack : err.message || err}`));
  }

  bot.once("spawn", () => {
    log("Connected to proxy; waiting for authentication.");
    loginTimer = setTimeout(() => { loginTimer = null; if (!authenticated && !loginSent) sendLogin(); }, LOGIN_DELAY);
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
    if (isRegisterPrompt(raw)) { loginSent = false; sendRegister(); return; }
    if (isLoginPrompt(raw)) { loginSent = false; sendLogin(); return; }
  });

  bot.on("kicked", reason => {
    log(`KICKED reason: ${readableReason(reason)}`);
    log(`Connection diagnostics: MC=${MC_VERSION}, clientBrand=${CLIENT_BRAND}, auth=offline`);
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
