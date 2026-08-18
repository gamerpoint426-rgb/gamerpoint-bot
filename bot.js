const mineflayer = require("mineflayer");

const HOST = process.env.VELOCITY_HOST || "127.0.0.1";
const PORT = Number(process.env.VELOCITY_PORT || 25565);
const USERNAME = process.env.BOT_NAME || "GPMCBot";
const PASSWORD = process.env.BOT_PASSWORD || "";
const TARGET = process.env.BOT_TARGET || "lobby";

let bot;
let authenticated = false;
let destinationSent = false;

function connect() {
  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: process.env.MC_VERSION || false,
    auth: "offline"
  });

  console.log(`Connecting as ${USERNAME} to ${HOST}:${PORT}`);

  bot.once("spawn", () => {
    console.log("Spawned");
    // LimboAuth normally asks for authentication shortly after connection.
    // Give the plugin a moment, then authenticate. This avoids waiting for a
    // particular translated chat string.
    setTimeout(() => {
      if (!PASSWORD) return console.error("BOT_PASSWORD missing");
      console.log("Sending /login");
      bot.chat(`/login ${PASSWORD}`);
    }, 1200);
  });

  bot.on("message", jsonMsg => {
    const text = jsonMsg.toString().toLowerCase();
    if (!authenticated &&
        (text.includes("success") || text.includes("logged in") ||
         text.includes("authenticated") || text.includes("successfully"))) {
      authenticated = true;
      console.log("LimboAuth authentication detected");
      setTimeout(() => {
        if (!bot || !bot.chat || destinationSent) return;
        destinationSent = true;
        console.log(`Sending /server ${TARGET} after 30 seconds`);
        bot.chat(`/server ${TARGET}`);
      }, 30000);
    }
  });

  bot.on("kicked", reason => console.log("Kicked:", reason));
  bot.on("error", err => console.error("Error:", err.message));
  bot.on("end", reason => {
    console.log("Disconnected:", reason || "unknown");
    process.exit(2);
  });

  // Small harmless movement keeps the connection active without issuing
  // server management commands.
  setInterval(() => {
    if (!bot || !bot.entity) return;
    bot.setControlState("jump", false);
  }, 15000);
}

connect();
