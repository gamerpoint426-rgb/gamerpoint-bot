# Render persistence

This version stores both **bot settings** and the **panel login session** on the Render server filesystem.

Files:
- `/data/bot-config.json` — bot settings
- `/data/panel-session.json` — persistent panel login session

## Render setup

Create a **Render Persistent Disk** and mount it at:

`/data`

Recommended environment variables:

- `DATA_DIR=/data`
- `CONFIG_FILE=/data/bot-config.json`
- `SESSION_FILE=/data/panel-session.json`

### Important

A normal browser refresh will not reset settings or ask for the panel password again.

A Render redeploy/restart will also preserve the settings and login session **only when the Persistent Disk is mounted at `/data`**.

The panel login session lasts 30 days and is stored as a SHA-256 token hash; the panel password itself is never written to the session file.

If you intentionally log out, the saved session is invalidated and the login page will appear again.
