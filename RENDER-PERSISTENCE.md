# Render persistence

The panel now saves bot settings on the server in `bot-config.json` instead of browser/local mobile storage.

## Recommended Render setup
Create a Render Persistent Disk and mount it at `/data`. The application already uses `/data/bot-config.json` by default.

If a Persistent Disk is not mounted, settings will survive normal browser refreshes while the Node process stays alive, but Render can erase the file when the service is restarted/redeployed.

Optional environment variable:
- `DATA_DIR=/data`
- or `CONFIG_FILE=/data/bot-config.json`

The panel supports live chat/commands from each bot console.
