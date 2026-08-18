GamerPointMC 24/7 Bot

Flow:
1. Connect to Velocity
2. Authenticate with LimboAuth using /login <password>
3. Wait 30 seconds after authentication
4. Send /server lobby or /server survival
5. Reconnect if disconnected

IMPORTANT:
Set passwords through your hosting panel environment variables instead of storing
them in the ZIP.

Suggested variables:
BOT1_PASSWORD=your_bot1_password
BOT2_PASSWORD=your_bot2_password

If your hosting panel does not support environment variables, edit the config
file in the project and add the passwords there locally before deployment.
