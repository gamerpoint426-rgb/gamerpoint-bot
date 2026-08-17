const mineflayer = require("mineflayer");
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";

const MC_HOST = process.env.MC_HOST || "play.gamerpointmc.qzz.io";
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_VERSION = process.env.MC_VERSION || "1.21.11";
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS || 60000);

const botConfigs = {
  1: {
    name: process.env.BOT1_NAME || "Lobby",
    password: process.env.BOT1_PASSWORD || "notgpbot01",
    server: process.env.BOT1_SERVER || "lobby",
    start: process.env.BOT1_START !== "false",
    restart: Number(process.env.BOT1_RESTART_MINUTES || 12),
    reconnect: Number(process.env.BOT1_RECONNECT_SECONDS || 30),
  },
  2: {
    name: process.env.BOT2_NAME || "Survival",
    password: process.env.BOT2_PASSWORD || "notgpbot02",
    server: process.env.BOT2_SERVER || "survival",
    start: process.env.BOT2_START !== "false",
    restart: Number(process.env.BOT2_RESTART_MINUTES || 24),
    reconnect: Number(process.env.BOT2_RECONNECT_SECONDS || 30),
  },
  3: {
    name: process.env.BOT3_NAME || "MiniGamers",
    password: process.env.BOT3_PASSWORD || "notgpbot03",
    server: process.env.BOT3_SERVER || "minigame",
    start: process.env.BOT3_START === "true",
    restart: Number(process.env.BOT3_RESTART_MINUTES || 34),
    reconnect: Number(process.env.BOT3_RECONNECT_SECONDS || 30),
  },
  4: {
    name: process.env.BOT4_NAME || "OneBlock",
    password: process.env.BOT4_PASSWORD || "notgpbot04",
    server: process.env.BOT4_SERVER || "oneblock",
    start: process.env.BOT4_START === "true",
    restart: Number(process.env.BOT4_RESTART_MINUTES || 31),
    reconnect: Number(process.env.BOT4_RECONNECT_SECONDS || 30),
  },
};

const bots = new Map();

function randomPassword(length = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

for (const [id, cfg] of Object.entries(botConfigs)) {
  if (!cfg.password) {
    cfg.password = randomPassword(8);
    console.log(`[Bot ${id}] ${cfg.name}: generated 8-character password.`);
    console.log(`[Bot ${id}] ${cfg.name}: password = ${cfg.password}`);
    console.log("SAVE THIS PASSWORD. It will remain stable only while this process remains alive.");
  }

  bots.set(Number(id), {
    id: Number(id),
    ...cfg,
    bot: null,
    state: "stopped",
    authenticated: false,
    manualStop: false,
    authSent: false,
    authTimer: null,
    restartTimer: null,
    reconnectTimer: null,
    logs: [],
  });
}

function log(config, message) {
  const line = `[${new Date().toISOString()}] [Bot ${config.id}] ${config.name}: ${message}`;
  console.log(line);

  config.logs.push(line);
  if (config.logs.length > 500) config.logs.shift();

  broadcast({
    type: "log",
    botId: config.id,
    line,
  });
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.res.write(payload);
  }
}

const sseClients = new Set();

function clean(text) {
  return String(text).replace(/§[0-9a-fk-or]/gi, "");
}

function clearTimers(c) {
  clearTimeout(c.authTimer);
  clearTimeout(c.restartTimer);
  clearTimeout(c.reconnectTimer);
  c.authTimer = c.restartTimer = c.reconnectTimer = null;
}

function status(c) {
  return {
    id: c.id,
    name: c.name,
    server: c.server,
    state: c.state,
    authenticated: c.authenticated,
    restartMinutes: c.restart,
    reconnectSeconds: c.reconnect,
  };
}

function scheduleRestart(c) {
  clearTimeout(c.restartTimer);

  if (!c.restart || c.restart <= 0) return;

  c.restartTimer = setTimeout(() => {
    if (c.bot && !c.manualStop) {
      log(c, `scheduled disconnect after ${c.restart} minutes`);
      try { c.bot.quit("Scheduled reconnect"); } catch {}
    }
  }, c.restart * 60 * 1000);
}

function scheduleReconnect(c) {
  if (c.manualStop) return;

  clearTimeout(c.reconnectTimer);

  log(c, `reconnecting in ${c.reconnect} seconds`);

  c.reconnectTimer = setTimeout(() => {
    if (!c.manualStop) connectBot(c);
  }, c.reconnect * 1000);
}

function finishAuth(c) {
  if (c.authenticated) return;

  c.authenticated = true;
  c.authSent = false;
  clearTimeout(c.authTimer);

  log(c, "authentication successful");

  setTimeout(() => {
    if (!c.bot || c.manualStop) return;

    if (c.server && c.server !== "lobby") {
      log(c, `sending /server ${c.server}`);
      c.bot.chat(`/server ${c.server}`);
    }

    scheduleRestart(c);
  }, 1500);
}

function authMessage(c, message) {
  if (c.authenticated) return;

  const text = clean(message);
  const lower = text.toLowerCase();

  log(c, `SERVER: ${text}`);

  // LimboAuth can authenticate and immediately transfer the player to the
  // backend without sending a literal "login successful" message.
  // Backend welcome text is therefore also treated as successful auth.
  if (
    lower.includes("successfully logged") ||
    lower.includes("successfully login") ||
    lower.includes("logged in successfully") ||
    lower.includes("login successful") ||
    lower.includes("authentication successful") ||
    lower.includes("successfully authenticated") ||
    lower.includes("authenticated") ||
    /welcome,\s*.+\s+to\s+the\s+server/i.test(text) ||
    lower.includes("powered by gamerpoint")
  ) {
    finishAuth(c);
    return;
  }

  // Do not mark a failed password attempt as authenticated.
  if (
    lower.includes("wrong password") ||
    lower.includes("incorrect password") ||
    lower.includes("invalid password") ||
    lower.includes("not registered") ||
    lower.includes("please wait before next usage") ||
    lower.includes("too many attempts")
  ) {
    log(c, "authentication failed; waiting for reconnect");
    return;
  }

  if (!c.authSent && (
    lower.includes("register") ||
    lower.includes("registration") ||
    lower.includes("create an account")
  )) {
    c.authSent = true;
    log(c, "sending /register");
    c.bot.chat(`/register ${c.password} ${c.password}`);
    setTimeout(() => c.authSent = false, 5000);
    return;
  }

  if (!c.authSent && (
    lower.includes("login") ||
    lower.includes("log in") ||
    lower.includes("authenticate")
  )) {
    c.authSent = true;
    log(c, "sending /login");
    c.bot.chat(`/login ${c.password}`);
    setTimeout(() => c.authSent = false, 5000);
  }
}

function connectBot(c) {
  if (c.bot || c.state === "connecting") return;

  c.manualStop = false;
  c.authenticated = false;
  c.authSent = false;
  c.state = "connecting";
  clearTimers(c);

  log(c, `connecting to ${MC_HOST}:${MC_PORT} (Minecraft ${MC_VERSION})`);

  let bot;
  try {
    bot = mineflayer.createBot({
      host: MC_HOST,
      port: MC_PORT,
      username: c.name,
      version: MC_VERSION,
      auth: "offline",
    });
  } catch (err) {
    c.state = "stopped";
    log(c, `create error: ${err.message}`);
    scheduleReconnect(c);
    return;
  }

  c.bot = bot;

  bot.on("login", () => {
    c.state = "connected";
    log(c, "connected to Velocity");
  });

  bot.on("spawn", () => {
    log(c, "spawned; waiting for LimboAuth prompt");

    c.authTimer = setTimeout(() => {
      if (!c.authenticated && c.bot === bot && !c.manualStop) {
        log(c, "AUTHORIZATION TIMEOUT");
        try { bot.quit("Authorization timeout"); } catch {}
      }
    }, AUTH_TIMEOUT_MS);
  });

  bot.on("message", msg => authMessage(c, msg.toString()));
  bot.on("messagestr", msg => {
    if (msg) log(c, `MESSAGE: ${msg}`);
  });

  bot.on("kicked", reason => log(c, `KICKED: ${reason}`));
  bot.on("error", err => log(c, `ERROR: ${err.message}`));

  bot.on("end", () => {
    log(c, "disconnected");

    clearTimers(c);
    c.bot = null;
    c.authenticated = false;
    c.state = c.manualStop ? "stopped" : "reconnecting";

    if (!c.manualStop) scheduleReconnect(c);
  });

  const afk = setInterval(() => {
    if (c.bot !== bot) {
      clearInterval(afk);
      return;
    }

    if (!c.authenticated) return;

    try {
      bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3, true);
      bot.setControlState("forward", true);

      setTimeout(() => {
        if (c.bot === bot) {
          try { bot.setControlState("forward", false); } catch {}
        }
      }, 700);
    } catch {}
  }, Number(process.env.AFK_INTERVAL_MS || 45000));
}

function stopBot(c) {
  c.manualStop = true;
  clearTimers(c);

  if (!c.bot) {
    c.state = "stopped";
    log(c, "already stopped");
    return;
  }

  log(c, "stopping");
  try { c.bot.quit("Stopped from GamerPoint panel"); } catch {}
}

/* ---------- Authentication for the web control API ---------- */

function authorized(req, res, next) {
  if (!CONTROL_TOKEN) {
    return res.status(503).json({
      error: "CONTROL_TOKEN is not configured. Control API is disabled.",
    });
  }

  const supplied =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.query.token ||
    req.body?.token;

  if (supplied !== CONTROL_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

/* ---------- API ---------- */

app.get("/api/status", authorized, (req, res) => {
  res.json({
    host: MC_HOST,
    port: MC_PORT,
    version: MC_VERSION,
    bots: Array.from(bots.values()).map(status),
  });
});

app.get("/api/logs/:id", authorized, (req, res) => {
  const c = bots.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Bot not found" });
  res.json({ bot: c.id, logs: c.logs });
});

app.post("/api/bot/:id/start", authorized, (req, res) => {
  const c = bots.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Bot not found" });

  c.manualStop = false;

  if (!c.bot) connectBot(c);

  res.json({ ok: true, bot: status(c) });
});

app.post("/api/bot/:id/stop", authorized, (req, res) => {
  const c = bots.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Bot not found" });

  stopBot(c);
  res.json({ ok: true, bot: status(c) });
});

app.post("/api/bot/:id/restart", authorized, (req, res) => {
  const c = bots.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Bot not found" });

  c.manualStop = true;
  stopBot(c);

  setTimeout(() => {
    c.manualStop = false;
    connectBot(c);
  }, 1000);

  res.json({ ok: true });
});

app.post("/api/bot/:id/command", authorized, (req, res) => {
  const c = bots.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Bot not found" });

  const command = String(req.body?.command || "").trim();

  if (!command) {
    return res.status(400).json({ error: "command is required" });
  }

  if (!c.bot) {
    return res.status(409).json({ error: "Bot is not online" });
  }

  const message = command.startsWith("/") ? command : `/${command}`;

  log(c, `YOU -> ${message}`);
  c.bot.chat(message);

  res.json({ ok: true, sent: message });
});

app.post("/api/bot/:id/chat", authorized, (req, res) => {
  const c = bots.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: "Bot not found" });

  const message = String(req.body?.message || "").trim();

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  if (!c.bot) {
    return res.status(409).json({ error: "Bot is not online" });
  }

  log(c, `YOU CHAT -> ${message}`);
  c.bot.chat(message);

  res.json({ ok: true });
});

/* ---------- Live SSE ---------- */

app.get("/api/events", authorized, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const client = { res };
  sseClients.add(client);

  res.write(`data: ${JSON.stringify({
    type: "status",
    bots: Array.from(bots.values()).map(status)
  })}\n\n`);

  req.on("close", () => {
    sseClients.delete(client);
  });
});

/* ---------- Mobile control page ---------- */

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GamerPoint Bot Panel</title>
<style>
body{font-family:system-ui,sans-serif;background:#10131a;color:#fff;margin:0;padding:16px}
h1{font-size:24px;margin-top:0}
.card{background:#191e28;border:1px solid #303746;border-radius:14px;padding:14px;margin:10px 0}
button,input{font-size:16px;border-radius:9px;padding:10px;border:1px solid #3b4353}
button{background:#252c39;color:white;margin:4px 3px}
input{background:#0e1117;color:white;width:calc(100% - 24px);margin:4px 0}
.online{color:#65e68a}.offline{color:#ff7272}.connecting{color:#ffd166}
#logs{height:320px;overflow:auto;background:#080a0e;border-radius:10px;padding:10px;font-family:monospace;font-size:12px;white-space:pre-wrap}
.small{color:#aab2c0;font-size:13px}
</style>
</head>
<body>
<h1>🎮 GamerPoint Bot Panel</h1>

<div id="login">
  <input id="token" type="password" placeholder="Control token">
  <button onclick="saveToken()">Connect</button>
</div>

<div id="panel" style="display:none">
  <div id="bots"></div>

  <div class="card">
    <b>Live Console</b>
    <select id="botSelect" style="padding:9px;margin:8px 0"></select>
    <div id="logs"></div>
    <input id="command" placeholder="Minecraft command, e.g. server survival">
    <button onclick="sendCommand()">Send Command</button>
    <input id="chat" placeholder="Chat message">
    <button onclick="sendChat()">Send Chat</button>
  </div>
</div>

<script>
let token = localStorage.getItem("gp_token") || "";
let selected = 1;

function saveToken(){
  token=document.getElementById("token").value;
  localStorage.setItem("gp_token",token);
  document.getElementById("login").style.display="none";
  document.getElementById("panel").style.display="block";
  load();
}

if(token){
  document.getElementById("login").style.display="none";
  document.getElementById("panel").style.display="block";
}

async function api(url, options={}){
  options.headers=Object.assign({
    "Authorization":"Bearer "+token,
    "Content-Type":"application/json"
  },options.headers||{});
  const r=await fetch(url,options);
  if(r.status===401){
    localStorage.removeItem("gp_token");
    alert("Invalid control token");
    location.reload();
  }
  return r.json();
}

async function load(){
  const data=await api("/api/status");
  if(!data.bots)return;

  document.getElementById("bots").innerHTML=data.bots.map(b=>{
    const cls=b.state==="connected"?"online":(b.state==="connecting"||b.state==="reconnecting"?"connecting":"offline");
    return \`
      <div class="card">
        <b>Bot \${b.id}: \${b.name}</b>
        <div class="\${cls}">● \${b.state}</div>
        <div class="small">Server: \${b.server} | Auth: \${b.authenticated?"yes":"no"}</div>
        <button onclick="startBot(\${b.id})">▶ Start</button>
        <button onclick="stopBot(\${b.id})">■ Stop</button>
        <button onclick="restartBot(\${b.id})">↻ Restart</button>
        <button onclick="selectBot(\${b.id})">Console</button>
      </div>\`;
  });

  const select=document.getElementById("botSelect");
  select.innerHTML=data.bots.map(b=>\`<option value="\${b.id}">Bot \${b.id} - \${b.name}</option>\`).join("");
  select.value=selected;
  loadLogs();
}

async function startBot(id){await api("/api/bot/"+id+"/start",{method:"POST"});load()}
async function stopBot(id){await api("/api/bot/"+id+"/stop",{method:"POST"});load()}
async function restartBot(id){await api("/api/bot/"+id+"/restart",{method:"POST"});load()}
function selectBot(id){selected=id;document.getElementById("botSelect").value=id;loadLogs()}

async function loadLogs(){
  const id=Number(document.getElementById("botSelect").value||selected);
  selected=id;
  const data=await api("/api/logs/"+id);
  document.getElementById("logs").textContent=(data.logs||[]).join("\\n");
  const box=document.getElementById("logs");
  box.scrollTop=box.scrollHeight;
}

async function sendCommand(){
  const command=document.getElementById("command").value.trim();
  if(!command)return;
  await api("/api/bot/"+selected+"/command",{method:"POST",body:JSON.stringify({command})});
  document.getElementById("command").value="";
  setTimeout(loadLogs,300);
}

async function sendChat(){
  const message=document.getElementById("chat").value.trim();
  if(!message)return;
  await api("/api/bot/"+selected+"/chat",{method:"POST",body:JSON.stringify({message})});
  document.getElementById("chat").value="";
  setTimeout(loadLogs,300);
}

document.getElementById("botSelect").addEventListener("change",e=>{
  selected=Number(e.target.value);
  loadLogs();
});

setInterval(load,5000);
setInterval(loadLogs,1500);

if(token) load();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`GamerPoint bot panel listening on port ${PORT}`);
  console.log(`Minecraft: ${MC_HOST}:${MC_PORT}`);
  console.log(`Mineflayer version: ${MC_VERSION}`);

  for (const c of bots.values()) {
    console.log(
      `[Bot ${c.id}] ${c.name} -> ${c.server} | auto-start=${c.start}`
    );
    if (c.start) connectBot(c);
  }
});
