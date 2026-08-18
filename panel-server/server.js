const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || process.env.PANEL_PORT || 3000);
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "NotgpPanel1";
const ROOT = path.resolve(__dirname, "..");
const BOT_ENTRY = process.env.BOT_ENTRY || path.join(ROOT, "bot.js");

const HOST = process.env.VELOCITY_HOST || "play.gamerpointmc.qzz.io";
const VELOCITY_PORT = Number(process.env.VELOCITY_PORT || 25565);

const configs = {
  "1": { name: "GPMCBot-Lobby", target: "lobby", password: process.env.BOT1_PASSWORD || "Notgpbot1" },
  "2": { name: "GPMCBot-Survival", target: "survival", password: process.env.BOT2_PASSWORD || "Notgpbot2" },
  "3": { name: "GPMCBot-MiniGame", target: "minigame", password: process.env.BOT3_PASSWORD || "Notgpbot3" },
  "4": { name: "GPMCBot-OneBlock", target: "oneblock", password: process.env.BOT4_PASSWORD || "Notgpbot4" }
};

const bots = {};
for (const id of Object.keys(configs)) bots[id] = { proc: null, log: [] };
const sessions = new Set();

function cookieToken() {
  return crypto.randomBytes(32).toString("hex");
}
function isAuthed(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)gpmc_session=([^;]+)/);
  return !!match && sessions.has(match[1]);
}
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

function addLog(id, line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  bots[id].log.push(msg);
  if (bots[id].log.length > 1000) bots[id].log.shift();
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.authed) {
      ws.send(JSON.stringify({ type: "log", id, line: msg }));
    }
  });
}

function state() {
  const out = {};
  for (const id of Object.keys(bots)) {
    out[id] = { running: !!bots[id].proc, name: configs[id].name, target: configs[id].target };
  }
  return out;
}
function broadcastState() {
  const msg = JSON.stringify({ type: "state", bots: state() });
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.authed) ws.send(msg);
  });
}

function startBot(id) {
  const b = bots[id], c = configs[id];
  if (!b) return { ok: false, error: "Unknown bot" };
  if (b.proc) return { ok: false, error: "Bot already running" };

  const env = {
    ...process.env,
    VELOCITY_HOST: HOST,
    VELOCITY_PORT: String(VELOCITY_PORT),
    BOT_TARGET: c.target,
    BOT_PASSWORD: c.password,
    BOT_NAME: c.name
  };

  const child = spawn(process.execPath, [BOT_ENTRY], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  b.proc = child;
  addLog(id, `STARTED ${c.name} -> ${c.target} @ ${HOST}:${VELOCITY_PORT}`);

  child.stdout.on("data", d => d.toString().split(/\r?\n/).filter(Boolean).forEach(x => addLog(id, x)));
  child.stderr.on("data", d => d.toString().split(/\r?\n/).filter(Boolean).forEach(x => addLog(id, `[ERR] ${x}`)));
  child.on("error", err => addLog(id, `[PROCESS ERROR] ${err.message}`));
  child.on("exit", (code, signal) => {
    b.proc = null;
    addLog(id, `STOPPED (code=${code}, signal=${signal || "none"})`);
    broadcastState();
  });
  broadcastState();
  return { ok: true };
}

function stopBot(id) {
  const b = bots[id];
  if (!b) return { ok: false, error: "Unknown bot" };
  if (!b.proc) return { ok: false, error: "Bot is not running" };
  addLog(id, "STOP requested by panel");
  b.proc.kill("SIGTERM");
  return { ok: true };
}

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  if (!isAuthed(req)) return res.sendFile(path.join(__dirname, "public", "login.html"));
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.static(path.join(__dirname, "public")));

app.post("/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (password !== PANEL_PASSWORD) return res.status(401).json({ ok: false, error: "Wrong panel password" });
  const token = cookieToken();
  sessions.add(token);
  res.setHeader("Set-Cookie", `gpmc_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  res.json({ ok: true });
});
app.post("/logout", (req, res) => {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)gpmc_session=([^;]+)/);
  if (match) sessions.delete(match[1]);
  res.setHeader("Set-Cookie", "gpmc_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});
app.get("/health", (_req, res) => res.status(200).send("GamerPointMC Bot Panel OK"));

app.get("/api/config", requireAuth, (_req, res) => res.json({
  ok: true, host: HOST, port: VELOCITY_PORT,
  bots: Object.fromEntries(Object.entries(configs).map(([id, c]) => [id, { name: c.name, target: c.target }]))
}));
app.get("/api/state", requireAuth, (_req, res) => res.json({ ok: true, bots: state() }));
app.get("/api/logs/:id", requireAuth, (req, res) => {
  if (!bots[req.params.id]) return res.status(404).json({ ok: false, error: "Unknown bot" });
  res.json({ ok: true, log: bots[req.params.id].log });
});
app.post("/api/bots/:id/start", requireAuth, (req, res) => res.json(startBot(req.params.id)));
app.post("/api/bots/:id/stop", requireAuth, (req, res) => res.json(stopBot(req.params.id)));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  ws.authed = isAuthed(req);
  if (!ws.authed) return ws.close(1008, "Unauthorized");
  ws.send(JSON.stringify({ type: "state", bots: state() }));
  for (const id of Object.keys(bots)) for (const line of bots[id].log.slice(-100)) ws.send(JSON.stringify({ type: "log", id, line }));
});

server.listen(PORT, "0.0.0.0", () => console.log(`GamerPointMC panel listening on 0.0.0.0:${PORT}`));

if (process.env.AUTO_START !== "0") {
  setTimeout(() => {
    for (const id of Object.keys(configs)) startBot(id);
  }, 1000);
}
