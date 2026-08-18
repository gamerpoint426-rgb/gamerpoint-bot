GamerPointMC Bot Panel integration

The included panel/index.html is the UI. Its switches currently emit START/STOP
requests in the browser console area. To make them control the Node bot process,
connect the setBot(n,on) function to your own authenticated HTTP/WebSocket API.

Recommended API:
POST /api/bots/1/start
POST /api/bots/1/stop
POST /api/bots/2/start
POST /api/bots/2/stop
GET  /api/logs

Do NOT expose an unauthenticated start/stop API to the public internet.
The bot itself must never issue the Minecraft /stop command.

Bot flow:
Velocity -> LimboAuth -> /login PASSWORD -> wait 30s after successful auth ->
/server lobby or /server survival -> stay connected -> reconnect on disconnect.

Use environment variables for passwords:
BOT1_PASSWORD
BOT2_PASSWORD
