#!/bin/bash
# Install a LaunchAgent that starts the Telegram bot at login and keeps it alive.
# The wrapper script lives in ~/.dsh (same pattern as dsh-web-autostart.sh) so
# launchd can always execute it.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.deepseek-ai.dsh-telegram-bot.plist"
BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$HOME/.dsh/dsh-tg-autostart.sh"

mkdir -p "$HOME/.dsh"

cat > "$WRAPPER" <<EOF
#!/bin/bash
# DSH Telegram bot — LaunchAgent wrapper (same pattern as dsh-web-autostart.sh).
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$HOME"
cd "$BOT_DIR"
exec /usr/local/bin/node src/index.mjs
EOF
chmod +x "$WRAPPER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.deepseek-ai.dsh-telegram-bot</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>${WRAPPER}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>WorkingDirectory</key>
	<string>${HOME}</string>
	<key>StandardOutPath</key>
	<string>${HOME}/.dsh/dsh-tg.log</string>
	<key>StandardErrorPath</key>
	<string>${HOME}/.dsh/dsh-tg.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed: $PLIST"
echo "wrapper:   $WRAPPER"
launchctl list | grep dsh-telegram-bot || true
