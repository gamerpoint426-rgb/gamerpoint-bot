GamerPointMC 8-Bot Railway Panel

Start command: npm start
Node: >=22

The panel now supports 8 bots. Each bot has its own host, port, target, password, reconnect delay, and Minecraft username/name.

Default bot names: Lobby, Survival, MiniGame, OneBlock, Bot5, Bot6, Bot7, Bot8.
Default reconnect: 300000 ms (5 minutes).

Bot names can be changed from Settings in the panel and are passed as BOT_NAME to Mineflayer when the bot restarts.

Important: bots 5-8 use the same default server hosts as bots 1-4, but have separate usernames/passwords. Change their Direct server host/port in the panel if you want different destinations.
