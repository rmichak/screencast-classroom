# ScreenCast Classroom

A dead-simple screen sharing app for classrooms. The teacher shares their screen, students scan a QR code or enter a 4-letter room code, and they see the teacher's screen on their own device — phone, tablet, or laptop.

**No accounts. No installs. No friction.**

## How It Works

1. Teacher opens `/present` and enters the presenter password
2. Clicks "Share My Screen" and selects a screen/window
3. A 4-letter room code + QR code appears
4. Students scan the QR code or go to `/view/CODE`
5. Students see the teacher's screen in real-time on their device

## Why?

Classroom projectors are often small, hard to read from the back, or at a bad angle. This lets every student see your screen full-size on their own device. It's like Zoom screen share without the Zoom.

## Architecture

```
Teacher's Browser ──WebRTC──→ TURN Relay ──→ Student's Browser
         ↕                                        ↕
    Socket.io ←──── Node.js Server ────→ Socket.io
                   (signaling only)
```

- **Server** handles signaling only (room management, WebRTC offer/answer relay)
- **No video touches the server** — streams go peer-to-peer via TURN/STUN relay
- **TURN servers** handle NAT traversal so it works through any firewall
- **Presenter auth** protects who can share — viewers need no authentication

## Tech Stack

- Node.js + Express
- Socket.io (signaling)
- Plain WebRTC (no frameworks)
- Vanilla HTML/CSS/JS (zero frontend dependencies)
- QR code generation (bundled)

## Setup

```bash
git clone https://github.com/rmichak/screencast-classroom.git
cd screencast-classroom
bash setup.sh
```

### Configuration

Set environment variables before starting:

| Variable | Default | Description |
|----------|---------|-------------|
| `PRESENTER_PASSWORD` | `teach2026` | Password to access presenter mode |
| `ANNOUNCED_IP` | Auto-detected | Public IP for WebRTC (if behind NAT) |

### TURN Servers

By default, the app uses free [Metered.ca](https://www.metered.ca/) TURN servers for WebRTC relay. For production use, you should set up your own TURN server (e.g., [coturn](https://github.com/coturn/coturn)) or get your own Metered.ca API key.

Update the `iceServers` config in `public/js/presenter.js` and `public/js/viewer.js`.

## Run

```bash
npm start
```

- **Presenter:** `https://YOUR_SERVER:3101/present`
- **Viewer:** `https://YOUR_SERVER:3101/view/CODE`

### Self-Signed Cert Warning

The setup script generates self-signed SSL certificates (WebRTC requires HTTPS). Students will see a browser warning the first time — click "Advanced" → "Proceed" once. For production, use Let's Encrypt.

### Behind a Reverse Proxy (nginx)

If your server only exposes ports 80/443, set up an nginx reverse proxy:

```nginx
server {
    listen 443 ssl;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass https://127.0.0.1:3101;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

## Features

- 🖥️ One-click screen sharing
- 📱 QR code for instant mobile access
- 🔐 Password-protected presenter mode
- 👥 Real-time viewer count
- 📺 Screen preview for presenter
- 🔄 Auto-cleanup when presenter disconnects
- 📲 Fullscreen toggle (tap/click on viewer)
- 🏠 Multiple simultaneous rooms supported

## Scaling

This uses peer-to-peer WebRTC — the presenter's browser creates a separate connection per viewer. Works great for **5-30 students**. For larger classes (50+), consider adding an SFU (Selective Forwarding Unit) like [mediasoup](https://mediasoup.org/) to relay a single stream.

## License

MIT

## Author

Built by [Randy Michak](https://randymichak.com) / [Empowerment AI](https://empowerment-ai.com)
