const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.PANEL_PORT || 3000);
const PANEL_TOKEN = process.env.PANEL_TOKEN || "CHANGE_ME";
const ROOT = path.resolve(__dirname, "..");
const BOT_ENTRY = process.env.BOT_ENTRY || path.join(ROOT, "bot.js");

const configs = {
  "1": { name: "GPMCBot-Lobby", target: "lobby", password: process.env.BOT1_PASSWORD || "" },
  "2": { name: "GPMCBot-Survival", target: "survival", password: process.env.BOT2_PASSWORD || "" }
};

const bots = {};
for (const id of Object.keys(configs)) {
  bots[id] = { proc: null, started: false, log: [] };
}

function addLog(id, line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  bots[id].log.push(msg);
  if (bots[id].log.length > 1000) bots[id].log.shift();
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:"log", id, line:msg }));
  });
}

function startBot(id) {
  const b = bots[id], c = configs[id];
  if (!b || b.proc) return { ok:false, error:"Bot already running" };
  if (!c.password) return { ok:false, error:`BOT${id}_PASSWORD is not configured` };

  // The bot receives only its own configuration through environment variables.
  const env = {
    ...process.env,
    BOT_TARGET: c.target,
    BOT_PASSWORD: c.password,
    BOT_NAME: c.name
  };

  const child = spawn(process.execPath, [BOT_ENTRY], {
    cwd: ROOT,
    env,
    stdio: ["pipe","pipe","pipe"]
  });

  b.proc = child;
  b.started = true;
  addLog(id, `STARTED ${c.name} -> ${c.target}`);

  child.stdout.on("data", d => d.toString().split(/\r?\n/).filter(Boolean).forEach(x => addLog(id, x)));
  child.stderr.on("data", d => d.toString().split(/\r?\n/).filter(Boolean).forEach(x => addLog(id, `[ERR] ${x}`)));
  child.on("exit", (code, signal) => {
    b.proc = null;
    addLog(id, `STOPPED (code=${code}, signal=${signal || "none"})`);
    broadcastState();
  });
  broadcastState();
  return { ok:true };
}

function stopBot(id) {
  const b = bots[id];
  if (!b || !b.proc) return { ok:false, error:"Bot is not running" };
  addLog(id, "STOP requested by panel");
  // SIGTERM stops the Node bot process; it does NOT send Minecraft /stop.
  b.proc.kill("SIGTERM");
  return { ok:true };
}

function state() {
  const s = {};
  for (const id of Object.keys(bots)) {
    s[id] = { running: !!bots[id].proc, name: configs[id].name, target: configs[id].target };
  }
  return s;
}
function broadcastState() {
  const msg = JSON.stringify({type:"state", bots:state()});
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function auth(req,res,next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i,"") || req.query.token;
  if (!token || token !== PANEL_TOKEN) return res.status(401).json({ok:false,error:"Unauthorized"});
  next();
}

app.get("/api/state", auth, (req,res)=>res.json({ok:true,bots:state()}));
app.get("/api/logs/:id", auth, (req,res)=>{
  if (!bots[req.params.id]) return res.status(404).json({ok:false,error:"Unknown bot"});
  res.json({ok:true,log:bots[req.params.id].log});
});
app.post("/api/bots/:id/start", auth, (req,res)=>res.json(startBot(req.params.id)));
app.post("/api/bots/:id/stop", auth, (req,res)=>res.json(stopBot(req.params.id)));

const server = http.createServer(app);
const wss = new WebSocket.Server({server, path:"/ws"});

wss.on("connection", ws => {
  ws.send(JSON.stringify({type:"state",bots:state()}));
});

server.listen(PORT, ()=>console.log(`GamerPointMC panel listening on :${PORT}`));
