const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const PORT = Number(process.env.PORT || process.env.PANEL_PORT || 3000);
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "NotgpPanel1";
const ROOT = path.resolve(__dirname, "..");
const BOT_ENTRY = process.env.BOT_ENTRY || path.join(ROOT, "bot.js");
const HOST = process.env.VELOCITY_HOST || "play.gamerpointmc.qzz.io";
const VELOCITY_PORT = Number(process.env.VELOCITY_PORT || 25565);
const DEFAULT_PROXY_RECONNECT = 60000;
const DEFAULT_DIRECT_RECONNECT = 300000;
const DEFAULT_DISCONNECT = Number(process.env.DISCONNECT_INTERVAL_MS || 0);
const DEFAULT_ROUTE = Number(process.env.ROUTE_DELAY_MS || 10000);
const DEFAULT_LOGIN = Number(process.env.LOGIN_DELAY_MS || 1500);
const REQUESTED_DATA_DIR = process.env.DATA_DIR || "/data";
function ensureWritableDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; }
  catch (e) { console.warn(`[STORAGE] ${dir} is not writable; using local server storage instead.`); const fallback = path.join(ROOT, ".panel-data"); fs.mkdirSync(fallback, { recursive: true }); return fallback; }
}
const DATA_DIR = ensureWritableDir(REQUESTED_DATA_DIR);
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(DATA_DIR, "bot-config.json");
const SERVER_OPTIONS = ["lobby", "survival", "minigame"];

function loadSavedConfigs() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) {
    console.error(`[CONFIG] Could not load ${CONFIG_FILE}: ${e.message}`);
    return {};
  }
}
function saveConfigs() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(configs, null, 2), "utf8");
    fs.renameSync(tmp, CONFIG_FILE);
    return true;
  } catch (e) {
    console.error(`[CONFIG] Could not save ${CONFIG_FILE}: ${e.message}`);
    return false;
  }
}

const configs = {
  "1": { name: "Lobby", target: "lobby", mode: "direct", host: process.env.BOT1_HOST || "play.gamerpointmc.qzz.io", proxyHost: HOST, port: Number(process.env.BOT1_PORT || 25565), password: process.env.BOT1_PASSWORD || "Notgpbot1", disconnectInterval: 20, reconnectDelay: 10, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "2": { name: "Survival", target: "survival", mode: "proxy", host: process.env.BOT2_HOST || "play.gamerpointmc.qzz.io", proxyHost: HOST, port: Number(process.env.BOT2_PORT || 25565), password: process.env.BOT2_PASSWORD || "Notgpbot2", disconnectInterval: 20, reconnectDelay: 10, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "3": { name: "MiniGame", target: "minigame", mode: "proxy", host: process.env.BOT3_HOST || "play.gamerpointmc.qzz.io", proxyHost: HOST, port: Number(process.env.BOT3_PORT || 25565), password: process.env.BOT3_PASSWORD || "Notgpbot3", disconnectInterval: 20, reconnectDelay: 10, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "4": { name: "OneBlock", target: "oneblock", mode: "direct", host: process.env.BOT4_HOST || "gamerpoint.mcsh.io", proxyHost: HOST, port: Number(process.env.BOT4_PORT || 25565), password: process.env.BOT4_PASSWORD || "Notgpbot4", disconnectInterval: 2, reconnectDelay: DEFAULT_DIRECT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "5": { name: "Wammu", target: "lobby", mode: "direct", host: process.env.BOT5_HOST || "gpmcsurvival.mcsh.io", proxyHost: HOST, port: Number(process.env.BOT5_PORT || 25565), password: process.env.BOT5_PASSWORD || "Notgpbot5", disconnectInterval: 2, reconnectDelay: DEFAULT_DIRECT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "6": { name: "cat", target: "lobby", mode: "direct", host: process.env.BOT6_HOST || "gpmcminigame.mcsh.io", proxyHost: HOST, port: Number(process.env.BOT6_PORT || 25565), password: process.env.BOT6_PASSWORD || "Notgpbot6", disconnectInterval: 2, reconnectDelay: DEFAULT_DIRECT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "7": { name: "Wammmu", target: "lobby", mode: "direct", host: process.env.BOT7_HOST || "gamerpointmc904.mcsh.io", proxyHost: HOST, port: Number(process.env.BOT7_PORT || 25565), password: process.env.BOT7_PASSWORD || "Notgpbot7", disconnectInterval: 2, reconnectDelay: DEFAULT_DIRECT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN },
  "8": { name: "meamea", target: "lobby", mode: "direct", host: process.env.BOT8_HOST || "gpmcbot8.mcsh.io", proxyHost: HOST, port: Number(process.env.BOT8_PORT || 25565), password: process.env.BOT8_PASSWORD || "Notgpbot8", disconnectInterval: 2, reconnectDelay: DEFAULT_DIRECT_RECONNECT, routeDelay: DEFAULT_ROUTE, loginDelay: DEFAULT_LOGIN }
};

const savedConfigs = loadSavedConfigs();
for (const id of Object.keys(configs)) {
  if (savedConfigs[id] && typeof savedConfigs[id] === "object") Object.assign(configs[id], savedConfigs[id]);
}
saveConfigs();

const bots = {};
for (const id of Object.keys(configs)) bots[id] = { proc: null, log: [], actualServer: "unknown", lastStart: null };
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days
// Authentication is carried by a signed cookie, so a Render restart cannot invalidate
// the panel session merely because the server cannot write /data. No plaintext password is stored.
const SESSION_SECRET = crypto.createHash("sha256").update(String(PANEL_PASSWORD) + "|gpmc-panel-session-v2").digest("hex");
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifySession(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return false;
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return data && Number.isFinite(Number(data.iat)) && Date.now() - Number(data.iat) <= SESSION_MAX_AGE * 1000;
  } catch { return false; }
}
function isAuthed(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)gpmc_session=([^;]+)/);
  return !!match && verifySession(match[1]);
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
    out[id] = { running: !!bots[id].proc, name: c.name, target: c.target, mode: c.mode, host: c.host, proxyHost: c.proxyHost, port: c.port, actualServer: bots[id].actualServer, password: c.password, disconnectInterval: c.disconnectInterval, reconnectDelay: c.reconnectDelay, routeDelay: c.routeDelay, loginDelay: c.loginDelay };
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
  const connectHost = c.mode === "proxy" ? (c.proxyHost || HOST) : c.host;
  const env = { ...process.env, VELOCITY_HOST: HOST, VELOCITY_PORT: String(VELOCITY_PORT), BOT_HOST: connectHost, BOT_PORT: String(c.port), DIRECT_CONNECT: c.mode === "direct" ? "true" : "false", BOT_TARGET: c.target, BOT_PASSWORD: c.password, BOT_NAME: c.name, DISCONNECT_INTERVAL_MS: String(c.disconnectInterval), RECONNECT_DELAY_MS: String(c.reconnectDelay), ROUTE_DELAY_MS: String(c.routeDelay), LOGIN_DELAY_MS: String(c.loginDelay), MC_VERSION: process.env.MC_VERSION || "1.21.11" };
  const child = spawn(process.execPath, [BOT_ENTRY], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  b.proc = child; b.actualServer = "connecting"; b.lastStart = Date.now();
  addLog(id, `STARTED ${c.name} -> ${c.target} @ ${connectHost}:${c.port} (${c.mode})`);
  child.stdout.on("data", d => d.toString().split(/\r?\n/).filter(Boolean).forEach(x => { const detected = detectServer(x); if (detected) b.actualServer = detected; addLog(id, x); broadcastState(); }));
  child.stderr.on("data", d => d.toString().split(/\r?\n/).filter(Boolean).forEach(x => { if (/Chunk size is 63 but only 29 was read/i.test(x)) return; addLog(id, `[ERR] ${x}`); }));
  child.stdin.on("error", err => addLog(id, `[STDIN ERROR] ${err.message}`));
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
  if (body.mode !== undefined) { const m = String(body.mode).trim().toLowerCase(); if (m !== "direct" && m !== "proxy") return { ok: false, error: "Invalid connection mode" }; c.mode = m; }
  if (body.password !== undefined) { const p = String(body.password); if (!p || p.length > 100) return { ok: false, error: "Invalid password" }; c.password = p; }
  if (body.host !== undefined) { const h = String(body.host).trim().toLowerCase(); if (!/^[a-z0-9.-]{1,253}$/.test(h)) return { ok: false, error: "Invalid host" }; c.host = h; }
  if (body.proxyHost !== undefined) { const h = String(body.proxyHost).trim().toLowerCase(); if (!/^[a-z0-9.-]{1,253}$/.test(h)) return { ok: false, error: "Invalid proxy host" }; c.proxyHost = h; }
  if (body.port !== undefined) { const n = Number(body.port); if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: "Invalid port" }; c.port = n; }
  for (const [key, min, max] of [["disconnectInterval",0,86400000],["routeDelay",0,600000],["loginDelay",0,60000]]) {
    if (body[key] !== undefined) { const n = Number(body[key]); if (!Number.isFinite(n) || n < min || n > max) return { ok:false, error:`Invalid ${key}` }; c[key] = Math.round(n); }
  }
  if (body.reconnectDelay !== undefined) { const n = Number(body.reconnectDelay); if (!Number.isFinite(n) || n < 3000 || n > 86400000) return { ok:false, error:"Invalid reconnect delay (3-86400 seconds)" }; c.reconnectDelay = Math.round(n); }
  if (!saveConfigs()) return { ok:false, error:"Could not save settings on server" };
  return { ok: true };
}

const app = express(); app.use(express.json());
app.get("/", (req,res) => { if (!isAuthed(req)) return res.sendFile(path.join(__dirname,"public","login.html")); res.sendFile(path.join(__dirname,"public","index.html")); });
app.use(express.static(path.join(__dirname,"public")));
app.post("/login", (req,res) => {
  if (String(req.body?.password||"") !== PANEL_PASSWORD) return res.status(401).json({ok:false,error:"Wrong panel password"});
  const token = signSession({ iat: Date.now() });
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie",`gpmc_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}`);
  res.json({ok:true});
});
app.post("/logout", (req,res) => {
  res.setHeader("Set-Cookie","gpmc_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
  res.json({ok:true});
});
app.get("/health",(_req,res)=>res.status(200).send("GamerPointMC Bot Panel OK"));
app.get("/api/config",requireAuth,(_req,res)=>res.json({ok:true,host:HOST,port:VELOCITY_PORT,serverOptions:SERVER_OPTIONS,bots:state()}));
app.get("/api/state",requireAuth,(_req,res)=>res.json({ok:true,bots:state()}));
app.get("/api/logs/:id",requireAuth,(req,res)=>{if(!bots[req.params.id])return res.status(404).json({ok:false,error:"Unknown bot"});res.json({ok:true,log:bots[req.params.id].log});});
app.post("/api/bots/:id/start",requireAuth,(req,res)=>res.json(startBot(req.params.id)));
app.post("/api/bots/:id/stop",requireAuth,(req,res)=>res.json(stopBot(req.params.id)));
app.post("/api/bots/:id/send",requireAuth,(req,res)=>{
  const b=bots[req.params.id];
  if(!b) return res.status(404).json({ok:false,error:"Unknown bot"});
  if(!b.proc || !b.proc.stdin || b.proc.stdin.destroyed) return res.status(400).json({ok:false,error:"Bot is not running"});
  const text=String(req.body?.text||"").trim();
  const type=String(req.body?.type||"chat").toLowerCase();
  if(!text || text.length>500) return res.status(400).json({ok:false,error:"Message/command must be 1-500 characters"});
  if(type!=="chat" && type!=="command") return res.status(400).json({ok:false,error:"Invalid send type"});
  const payload=`${type === "command" ? "CMD:" : "CHAT:"}${text.replace(/\r?\n/g," ")}\n`;
  try { b.proc.stdin.write(payload); addLog(req.params.id, `[panel] Sent ${type}: ${text}`); res.json({ok:true}); }
  catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.post("/api/bots/:id/clear",requireAuth,(req,res)=>{
  const b=bots[req.params.id]; if(!b) return res.status(404).json({ok:false,error:"Unknown bot"});
  b.log=[]; if(wss) wss.clients.forEach(ws=>{if(ws.readyState===WebSocket.OPEN&&ws.authed) ws.send(JSON.stringify({type:"clear",id:req.params.id}));}); res.json({ok:true});
});
app.post("/api/bots/:id/config",requireAuth,(req,res)=>{const r=updateConfig(req.params.id,req.body||{});if(!r.ok)return res.status(400).json(r);addLog(req.params.id,"[panel] Settings updated");broadcastState();if(bots[req.params.id].proc){stopBot(req.params.id);setTimeout(()=>startBot(req.params.id),1000);}res.json(r);});

const server=http.createServer(app); wss=new WebSocket.Server({server,path:"/ws"});
wss.on("connection",(ws,req)=>{ws.authed=isAuthed(req);if(!ws.authed)return ws.close(1008,"Unauthorized");ws.send(JSON.stringify({type:"state",bots:state()}));for(const id of Object.keys(bots))for(const line of bots[id].log.slice(-100))ws.send(JSON.stringify({type:"log",id,line}));});
server.listen(PORT,"0.0.0.0",()=>console.log(`GamerPointMC panel listening on 0.0.0.0:${PORT}`));
if(process.env.AUTO_START!=="0")setTimeout(()=>Object.keys(configs).filter(id=>id!=="8").forEach(startBot),1000);
