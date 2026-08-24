GamerPointMC Bot Panel v7

Railway:
Build: npm install
Start: npm start

Panel password default: NotgpPanel1
Velocity default: play.gamerpointmc.qzz.io:25565
Minecraft bot version default: 1.21.11

Four bots:
1 Lobby / lobby / Notgpbot1
2 Survival / survival / Notgpbot2
3 MiniGame / minigame / Notgpbot3
4 OneBlock / oneblock / Notgpbot4

Panel features:
- Per-bot settings dropdown
- Change target server
- Change bot password
- Periodic disconnect interval (0 disables)
- Reconnect delay
- Login delay
- Route delay
- Per-bot console tabs
- Detected current server when the bot reports it
- Save settings and restart that bot
- Direct Railway panel; no external API


Protocol compatibility update (2026-08-24):
- Mineflayer upgraded to ^4.37.1 for current Minecraft 1.21.11 protocol support.
- The bot now explicitly sets the standard client brand to "vanilla".
- Node.js runtime requirement is >=22 to match the current Mineflayer release.
- Protocol/kick diagnostics are enabled so a server-side rejection can be distinguished from a missing brand packet.


Startup fix: bot.js was corrected so the createBot() configuration contains real JavaScript line breaks. The previous archive accidentally contained literal \\n sequences, which caused Node.js SyntaxError before Mineflayer could start.
