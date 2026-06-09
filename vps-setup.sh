#!/usr/bin/env bash
# Hespoire API — one-shot VPS setup (Ubuntu 22.04/24.04, run as root)
#   curl -fsSL https://raw.githubusercontent.com/sxyaps/hespoire-api/main/vps-setup.sh | bash
# After this finishes, do the two guided steps it prints (NordVPN login + cloudflared creds).
set -e

echo "==> Installing system packages (git, ffmpeg, curl)…"
apt-get update -y
apt-get install -y curl git ffmpeg ca-certificates

echo "==> Installing Node.js 20…"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "==> Installing pm2…"
npm install -g pm2

echo "==> Installing cloudflared…"
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

echo "==> Installing NordVPN CLI…"
sh <(curl -sSf https://downloads.nordcdn.com/apps/linux/install.sh) || true

echo "==> Fetching the app…"
mkdir -p /opt
cd /opt
if [ -d hespoire-api ]; then cd hespoire-api && git pull; else git clone https://github.com/sxyaps/hespoire-api.git && cd hespoire-api; fi
npm install

echo ""
echo "============================================================"
echo " Base install done. Two manual steps left (they need secrets):"
echo ""
echo " 1) Connect NordVPN (P2P) so torrents work:"
echo "      nordvpn login --token <YOUR_NORDVPN_TOKEN>"
echo "      nordvpn set technology nordlynx"
echo "      nordvpn set autoconnect on P2P"
echo "      nordvpn connect P2P"
echo ""
echo " 2) Copy your Cloudflare tunnel creds from the Mac Mini to this box:"
echo "      (run ON THE MAC MINI, replace VPS_IP):"
echo "      scp ~/.cloudflared/73aed1da-b189-4764-b968-ca0ef8dca5a5.json root@VPS_IP:/root/.cloudflared/"
echo "      scp ~/.cloudflared/hespoire.yml                              root@VPS_IP:/root/.cloudflared/"
echo ""
echo " Then start everything (auto-restart + boot-persist):"
echo "      pm2 start /opt/hespoire-api/server.js --name hespoire-api"
echo "      pm2 start cloudflared --name hespoire-tunnel -- tunnel run 73aed1da-b189-4764-b968-ca0ef8dca5a5"
echo "      pm2 save && pm2 startup systemd -u root --hp /root"
echo ""
echo " And STOP cloudflared + node on the Mac Mini (the tunnel can only run in one place):"
echo "      pm2 delete hespoire-tunnel hespoire-api   # on the Mac Mini"
echo "============================================================"
