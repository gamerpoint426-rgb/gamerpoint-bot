const mineflayer = require("mineflayer");

const HOST = process.env.VELOCITY_HOST || "play.gamerpointmc.qzz.io";
const PORT = Number(process.env.VELOCITY_PORT || 25565);
const USERNAME = process.env.BOT_NAME || "GPMCBot";
const PASSWORD = process.env.BOT_PASSWORD || "Notgpbot1";
const TARGET = process.env.BOT_TARGET || "lobby";
const MC_VERSION = process.env.MC_VERSION || false;

let bot = null;
let authenticated = false;
let routeSent = false;
let routeTimer = null;
let reconnectTimer = null;
let stopping = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  console.log(`[${USERNAME}] ${msg}`);
}

function connect() {
  if (stopping) return;

  authenticated = false;
  routeSent = false;
  if (routeTimer) clearTimeout(routeTimer);
  routeTimer = null;

  log(`Connecting to ${HOST}:${PORT} -> ${TARGET}`);

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
    log("Spawned; sending /login shortly");
    setTimeout(() => {
      if (!bot || stopping) return;
      log("Sending /login");
      bot.chat(`/login ${PASSWORD}`);
    }, 1500);
  });

  bot.on("message", jsonMsg => {
    const text = jsonMsg.toString().toLowerCase();
    if (!authenticated &&
      (text.includes("success") ||
       text.includes("logged in") ||
       text.includes("authenticated") ||
       text.includes("login successful") ||
       text.includes("successfully logged"))) {
      authenticated = true;
      log("Authentication detected; routing in 30 seconds");
      routeTimer = setTimeout(() => {
        if (!bot || stopping || routeSent) return;
        routeSent = true;
        log(`Sending /server ${TARGET}`);
        bot.chat(`/server ${TARGET}`);
      }, 30000);
    }
  });

  bot.on("kicked", reason => log(`Kicked: ${reason}`));
  bot.on("error", err => log(`Error: ${err.message}`));
  bot.on("end", reason => {
    log(`Disconnected: ${reason || "unknown"}`);
    bot = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
  log("Reconnecting in 5 seconds...");
}

process.on("SIGTERM", () => {
  stopping = true;
  if (routeTimer) clearTimeout(routeTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (bot) {
    try { bot.quit("Panel stop"); } catch {}
  }
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGINT", () => process.emit("SIGTERM"));

connect();
