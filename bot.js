const mineflayer = require("mineflayer");

const HOST = process.env.VELOCITY_HOST || "play.gamerpointmc.qzz.io";
const PORT = Number(process.env.VELOCITY_PORT || 25565);
const USERNAME = process.env.BOT_NAME || "GPMCBot";
const PASSWORD = process.env.BOT_PASSWORD || "Notgpbot1";
const TARGET = process.env.BOT_TARGET || "lobby";
const MC_VERSION = process.env.MC_VERSION || "1.21.11";
const LOGIN_DELAY = Math.max(0, Number(process.env.LOGIN_DELAY_MS || 1500));
const ROUTE_DELAY = Math.max(0, Number(process.env.ROUTE_DELAY_MS || 30000));
const DISCONNECT_INTERVAL = Math.max(0, Number(process.env.DISCONNECT_INTERVAL_MS || 0));
const RECONNECT_DELAY = Math.max(1000, Number(process.env.RECONNECT_DELAY_MS || 5000));

let bot = null;
let authenticated = false;
let routeSent = false;
let routeTimer = null;
let reconnectTimer = null;
let periodicDisconnectTimer = null;
let stopping = false;

function log(msg) { console.log(`[${USERNAME}] ${msg}`); }
function clearTimers() {
  if (routeTimer) clearTimeout(routeTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (periodicDisconnectTimer) clearTimeout(periodicDisconnectTimer);
  routeTimer = reconnectTimer = periodicDisconnectTimer = null;
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
    /(?:currently|now)\s+(?:on|connected to)\s+(?:server\s+)?([a-z0-9_-]+)/i
  ];
  for (const re of patterns) { const m = clean.match(re); if (m) return m[1].toLowerCase(); }
  return null;
}

function connect() {
  if (stopping) return;
  authenticated = false;
  routeSent = false;
  if (routeTimer) clearTimeout(routeTimer);
  routeTimer = null;

  log(`Connecting to ${HOST}:${PORT} -> ${TARGET} (MC ${MC_VERSION})`);
  try {
    bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: MC_VERSION, auth: "offline", hideErrors: false });
  } catch (err) { log(`Create bot error: ${err.message}`); return scheduleReconnect(); }

  bot.once("spawn", () => {
    log("Spawned; sending /login shortly");
    setTimeout(() => {
      if (!bot || stopping) return;
      log("Sending /login");
      bot.chat(`/login ${PASSWORD}`);
    }, LOGIN_DELAY);
  });

  bot.on("message", jsonMsg => {
    const raw = jsonMsg.toString();
    const text = raw.toLowerCase();
    const detected = detectServer(raw);
    if (detected) log(`Server detected: ${detected}`);
    if (!authenticated && (text.includes("success") || text.includes("logged in") || text.includes("authenticated") || text.includes("login successful") || text.includes("successfully logged"))) {
      authenticated = true;
      log(`Authentication detected; routing in ${Math.round(ROUTE_DELAY / 1000)} seconds`);
      routeTimer = setTimeout(() => {
        if (!bot || stopping || routeSent) return;
        routeSent = true;
        log(`Sending /server ${TARGET}`);
        bot.chat(`/server ${TARGET}`);
        schedulePeriodicDisconnect();
      }, ROUTE_DELAY);
    }
  });

  bot.on("kicked", reason => log(`Kicked: ${reason}`));
  bot.on("error", err => log(`Error: ${err.message}`));
  bot.on("end", reason => {
    log(`Disconnected: ${reason || "unknown"}`);
    bot = null;
    if (periodicDisconnectTimer) { clearTimeout(periodicDisconnectTimer); periodicDisconnectTimer = null; }
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
