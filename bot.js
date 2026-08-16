const express = require("express");
const mineflayer = require("mineflayer");

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.get("/", (_req, res) => {
  res.status(200).send("GamerPoint bots are running.");
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    bots: bots.map(b => ({
      name: b.name,
      server: b.server,
      connected: !!b.bot
    }))
  });
});

app.listen(PORT, () => {
  console.log(`Health server listening on ${PORT}`);
});

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);

if (!MC_HOST) {
  console.error("ERROR: MC_HOST is not configured.");
  process.exit(1);
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const bots = [
  {
    name: process.env.BOT1_NAME,
    password: process.env.BOT1_PASSWORD,
    server: process.env.BOT1_SERVER || "lobby",
    restartMinutes: numberEnv("BOT1_RESTART_MINUTES", 7),
    reconnectSeconds: numberEnv("BOT1_RECONNECT_SECONDS", 30),
    bot: null,
    reconnectTimer: null,
    restartTimer: null
  },
  {
    name: process.env.BOT2_NAME,
    password: process.env.BOT2_PASSWORD,
    server: process.env.BOT2_SERVER || "survival",
    restartMinutes: numberEnv("BOT2_RESTART_MINUTES", 6),
    reconnectSeconds: numberEnv("BOT2_RECONNECT_SECONDS", 30),
    bot: null,
    reconnectTimer: null,
    restartTimer: null
  },
  {
    name: process.env.BOT3_NAME,
    password: process.env.BOT3_PASSWORD,
    server: process.env.BOT3_SERVER || "lobby",
    restartMinutes: numberEnv("BOT3_RESTART_MINUTES", 9),
    reconnectSeconds: numberEnv("BOT3_RECONNECT_SECONDS", 30),
    bot: null,
    reconnectTimer: null,
    restartTimer: null
  }
].filter(bot => bot.name && bot.password);

function scheduleRestart(info) {
  clearTimeout(info.restartTimer);

  const restartMs = info.restartMinutes * 60 * 1000;

  info.restartTimer = setTimeout(() => {
    if (!info.bot) {
      createBot(info);
      return;
    }

    console.log(
      `[${info.name}] Scheduled restart after ${info.restartMinutes} minutes.`
    );

    try {
      info.bot.quit("Scheduled reconnect");
    } catch {
      scheduleReconnect(info);
    }
  }, restartMs);
}

function scheduleReconnect(info) {
  clearTimeout(info.reconnectTimer);

  const delay = info.reconnectSeconds * 1000;

  console.log(
    `[${info.name}] Reconnecting in ${info.reconnectSeconds} seconds...`
  );

  info.reconnectTimer = setTimeout(() => {
    createBot(info);
  }, delay);
}

function createBot(info) {
  if (info.bot) return;

  console.log(
    `[${info.name}] Connecting → ${MC_HOST}:${MC_PORT} → ${info.server}`
  );

  let bot;

  try {
    bot = mineflayer.createBot({
      host: MC_HOST,
      port: MC_PORT,
      username: info.name,
      auth: "offline",
      version: "26.2"
    });
  } catch (error) {
    console.error(`[${info.name}] Failed to create bot:`, error.message);
    scheduleReconnect(info);
    return;
  }

  info.bot = bot;

  let spawned = false;
  let authenticationStarted = false;

  bot.on("login", () => {
    console.log(`[${info.name}] Connected to Velocity.`);
  });

  bot.on("spawn", async () => {
    if (spawned) return;
    spawned = true;

    console.log(`[${info.name}] Spawned.`);
    await sleep(3000);

    if (!info.bot || info.bot !== bot) return;

    if (!authenticationStarted) {
      authenticationStarted = true;

      bot.chat(`/register ${info.password} ${info.password}`);
      await sleep(2500);

      if (!info.bot || info.bot !== bot) return;

      bot.chat(`/login ${info.password}`);
      console.log(`[${info.name}] Authentication commands sent.`);
    }

    await sleep(4000);

    if (!info.bot || info.bot !== bot) return;

    if (info.server && info.server !== "lobby") {
      console.log(
        `[${info.name}] Switching to Velocity server: ${info.server}`
      );
      bot.chat(`/server ${info.server}`);
    }

    scheduleRestart(info);
  });

  const antiAfkTimer = setInterval(() => {
    if (!bot.entity) return;

    try {
      const directions = ["left", "right", "forward"];
      const direction =
        directions[Math.floor(Math.random() * directions.length)];

      bot.setControlState(direction, true);

      setTimeout(() => {
        try {
          bot.setControlState(direction, false);
        } catch {}
      }, 500 + Math.random() * 1000);

      if (Math.random() < 0.7) {
        const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.5;
        const pitch = Math.max(
          -1.2,
          Math.min(1.2, bot.entity.pitch + (Math.random() - 0.5) * 0.5)
        );

        bot.look(yaw, pitch, true).catch(() => {});
      }
    } catch {}
  }, 15000);

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    console.log(`[${info.name}] ${username}: ${message}`);
  });

  bot.on("kicked", reason => {
    console.log(`[${info.name}] Kicked:`, reason);
  });

  bot.on("error", error => {
    console.error(`[${info.name}] Error: ${error.message}`);
  });

  bot.on("end", () => {
    clearInterval(antiAfkTimer);

    if (info.bot === bot) {
      info.bot = null;
    }

    console.log(`[${info.name}] Disconnected.`);
    clearTimeout(info.restartTimer);
    scheduleReconnect(info);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

for (const info of bots) {
  createBot(info);
}
