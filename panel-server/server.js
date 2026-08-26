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
const DEFAULT_RECONNECT = Number(process.env.RECONNECT_DELAY_MS || 300000);
const DEFAULT_DISCONNECT = Number(process.env.DISCONNECT_INTERVAL_MS || 0);
const DEFAULT_ROUTE = Number(process.env.ROUTE_DELAY_MS || 2000);
const DEFAULT_LOGIN = Number(process.env.LOGIN_DELAY_MS || 1500);
const SERVER_OPTIONS = ["lobby", "survival", "minigame", "oneblock"];

const configs = {
  "1": { name: "Lobby", target: "lobby", host: process.env.BOT1_HOST || "lobby.gamerpoint.net", port: Number(process.env.BOT1_PORT || 25565), password: process.env.BOT1_PASSWORD || "Notgpbot1", disconnectInterval: DEFAULT_DISCONNECT, reconnectDelay: DEFAULT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "2": { name: "Survival", target: "survival", host: process.env.BOT2_HOST || "survival.gamerpoint.net", port: Number(process.env.BOT2_PORT || 25565), password: process.env.BOT2_PASSWORD || "Notgpbot2", disconnectInterval: DEFAULT_DISCONNECT, reconnectDelay: DEFAULT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "3": { name: "MiniGame", target: "minigame", host: process.env.BOT3_HOST || "minigame.gamerpoint.net", port: Number(process.env.BOT3_PORT || 25565), password: process.env.BOT3_PASSWORD || "Notgpbot3", disconnectInterval: DEFAULT_DISCONNECT, reconnectDelay: DEFAULT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "4": { name: "OneBlock", target: "oneblock", host: process.env.BOT4_HOST || "oneblock.gamerpoint.net", port: Number(process.env.BOT4_PORT || 25565), password: process.env.BOT4_PASSWORD || "Notgpbot4", disconnectInterval: DEFAULT_DISCONNECT, reconnectDelay: DEFAULT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "5": { name: "Bot5", target: "lobby", host: process.env.BOT5_HOST || "lobby.gamerpoint.net", port: Number(process.env.BOT5_PORT || 25565), password: process.env.BOT5_PASSWORD || "Notgpbot5", disconnectInterval: DEFAULT_DISCONNECT, reconnectDelay: DEFAULT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "6": { name: "Bot6", target: "survival", host: process.env.BOT6_HOST || "survival.gamerpoint.net", port: Number(process.env.BOT6_PORT || 25565), password: process.env.BOT6_PASSWORD || "Notgpbot6", disconnectInterval: DEFAULT_DISCONNECT, reconnectDelay: DEFAULT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "7": { name: "Bot7", target: "minigame", host: process.env.BOT7_HOST || "minigame.gamerpoint.net", port: Number(process.env.BOT7_PORT || 25565), password: process.env.BOT7_PASSWORD || "Notgpbot7", disconnectInterval: DEFAULT_DISCONNECT, reconnectDelay: DEFAULT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "8": { name: "Bot8", target: "oneblock", host: process.env.BOT8_HOST || "oneblock.gamerpoint.net", port: Number(process.env.BOT8_PORT || 25565), password: process.env.BOT8_PASSWORD || "Notgpbot8", disconnectInterval: DEFAULT_DISCONNECT, reconnectDelay: DEFAULT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN }
};

const bots = {};
for (const id of Object.keys(configs)) bots[id] = { proc: null, log: [], actualServer: "unknown", lastStart: null };
const sessions = new Set();
let wss;

function cookieToken() { return crypto.randomBytes(32).toString("hex"); }
function isAuthed(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)gpmc_session=([^;]+)/);
  return !!match && sessions.has(match[1]);
}
function requireAuth(req, res, next) { if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Unauthorized" }); next(); }
function addLog(id, line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  bots[id].log.push(msg); if (bots[id].log.length > 1500) bots[id].log.shift();
  if (wss) wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN && ws.authed) ws.send(JSON.stringify({ type: "log", id, line: msg })); });
}
function detectServer(line) {
  const clean = String(line).replace(/^\[[^\]]+\]\s*/, "");
  const m = clean.match(/Server detected:\s*([a-z0-9_-]+)/i);
  return m ? m[1].toLowerCase() : null;
}
function state() {
  const out = {};
  for (const id of Object.keys(bots)) {
    const c = configs[id];
    out[id] = { running: !!bots[id].proc, name: c.name, target: c.target, host: c.host, port: c.port, actualServer: bots[id].actualServer, password: c.password, disconnectInterval: c.disconnectInterval, reconnectDelay: c.reconnectDelay, routeDelay: c.routeDelay, loginDelay: c.loginDelay };
  }
  return out;
}
function broadcastState() {
  const msg = JSON.stringify({ type: "state", bots: state() });
  if (wss) wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN && ws.authed) ws.send(msg); });
}
function startBot(id) {
  const b = bots[id], c = configs[id];
  if (!b) return { ok: false, error: "Unknown bot" };
  if (b.proc) return { ok: false, error: "Bot already running" };
  const env = { ...process.env, VELOCITY_HOST: HOST, VELOCITY_PORT: String(VELOCITY_PORT), BOT_HOST: c.host, BOT_PORT: String(c.port), DIRECT_CONNECT: "true", BOT_TARGET: c.target, BOT_PASSWORD: c.password, BOT_NAME: c.name, DISCONNECT_INTERVAL_MS: String(c.disconnectInterval), RECONNECT_DELAY_MS: String(c.reconnectDelay), ROUTE_DELAY_MS: String(c.routeDelay), LOGIN_DELAY_MS: String(c.loginDelay), MC_VERSION: process.env.MC_VERSION || "1.21.11" };
  const child = spawn(process.execPath, [BOT_ENTRY], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  b.proc = child; b.actualServer = "connecting"; b.lastStart = Date.now();
  addLog(id, `STARTED ${c.name} -> ${c.target} @ ${c.host}:${c.port} (direct)`);
  child.stdout.on("data", d => d.toString().split(/\r?\n/).filter(Boolean).forEach(x => { const detected = detectServer(x); if (detected) b.actualServer = detected; addLog(id, x); broadcastState(); }));
  child.stderr.on("data", d => d.toString().split(/\r?\n/).filter(Boolean).forEach(x => { if (/Chunk size is 63 but only 29 was read/i.test(x)) return; addLog(id, `[ERR] ${x}`); }));
  child.on("error", err => addLog(id, `[PROCESS ERROR] ${err.message}`));
  child.on("exit", (code, signal) => { b.proc = null; b.actualServer = "disconnected"; addLog(id, `STOPPED (code=${code}, signal=${signal || "none"})`); broadcastState(); });
  broadcastState(); return { ok: true };
}
function stopBot(id) {
  const b = bots[id]; if (!b) return { ok: false, error: "Unknown bot" }; if (!b.proc) return { ok: false, error: "Bot is not running" };
  addLog(id, "STOP requested by panel"); try { b.proc.kill("SIGTERM"); } catch {} return { ok: true };
}
function updateConfig(id, body) {
  const c = configs[id]; if (!c) return { ok: false, error: "Unknown bot" };
  if (body.name !== undefined) { const name = String(body.name).trim(); if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return { ok: false, error: "Invalid bot name (1-16 letters, numbers, underscore)" }; c.name = name; }
  if (body.target !== undefined) { const t = String(body.target).trim().toLowerCase(); if (!/^[a-z0-9_-]{1,32}$/.test(t)) return { ok: false, error: "Invalid target server" }; c.target = t; }
  if (body.password !== undefined) { const p = String(body.password); if (!p || p.length > 100) return { ok: false, error: "Invalid password" }; c.password = p; }
  if (body.host !== undefined) { const h = String(body.host).trim().toLowerCase(); if (!/^[a-z0-9.-]{1,253}$/.test(h)) return { ok: false, error: "Invalid host" }; c.host = h; }
  if (body.port !== undefined) { const n = Number(body.port); if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: "Invalid port" }; c.port = n; }
  for (const [key, min, max] of [["disconnectInterval",0,86400000],["reconnectDelay",1000,3600000],["routeDelay",0,600000],["loginDelay",0,60000]]) {
    if (body[key] !== undefined) { const n = Number(body[key]); if (!Number.isFinite(n) || n < min || n > max) return { ok:false, error:`Invalid ${key}` }; c[key] = Math.round(n); }
  }
  return { ok: true };
}

const app = express(); app.use(express.json());
app.get("/", (req,res) => { if (!isAuthed(req)) return res.sendFile(path.join(__dirname,"public","login.html")); res.sendFile(path.join(__dirname,"public","index.html")); });
app.use(express.static(path.join(__dirname,"public")));
app.post("/login", (req,res) => { if (String(req.body?.password||"") !== PANEL_PASSWORD) return res.status(401).json({ok:false,error:"Wrong panel password"}); const token=cookieToken(); sessions.add(token); res.setHeader("Set-Cookie",`gpmc_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${process.env.NODE_ENV === "production" ? "; Secure" : ""}`); res.json({ok:true}); });
app.post("/logout", (req,res) => { const m=(req.headers.cookie||"").match(/(?:^|;\s*)gpmc_session=([^;]+)/); if(m)sessions.delete(m[1]); res.setHeader("Set-Cookie","gpmc_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"); res.json({ok:true}); });
app.get("/health",(_req,res)=>res.status(200).send("GamerPointMC Bot Panel OK"));
app.get("/api/config",requireAuth,(_req,res)=>res.json({ok:true,host:HOST,port:VELOCITY_PORT,serverOptions:SERVER_OPTIONS,bots:state()}));
app.get("/api/state",requireAuth,(_req,res)=>res.json({ok:true,bots:state()}));
app.get("/api/logs/:id",requireAuth,(req,res)=>{if(!bots[req.params.id])return res.status(404).json({ok:false,error:"Unknown bot"});res.json({ok:true,log:bots[req.params.id].log});});
app.post("/api/bots/:id/start",requireAuth,(req,res)=>res.json(startBot(req.params.id)));
app.post("/api/bots/:id/stop",requireAuth,(req,res)=>res.json(stopBot(req.params.id)));
app.post("/api/bots/:id/config",requireAuth,(req,res)=>{const r=updateConfig(req.params.id,req.body||{});if(!r.ok)return res.status(400).json(r);addLog(req.params.id,"[panel] Settings updated");broadcastState();if(bots[req.params.id].proc){stopBot(req.params.id);setTimeout(()=>startBot(req.params.id),1000);}res.json(r);});

const server=http.createServer(app); wss=new WebSocket.Server({server,path:"/ws"});
wss.on("connection",(ws,req)=>{ws.authed=isAuthed(req);if(!ws.authed)return ws.close(1008,"Unauthorized");ws.send(JSON.stringify({type:"state",bots:state()}));for(const id of Object.keys(bots))for(const line of bots[id].log.slice(-100))ws.send(JSON.stringify({type:"log",id,line}));});
server.listen(PORT,"0.0.0.0",()=>console.log(`GamerPointMC panel listening on 0.0.0.0:${PORT}`));
if(process.env.AUTO_START!=="0")setTimeout(()=>Object.keys(configs).forEach(startBot),1000);
