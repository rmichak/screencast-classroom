# ScreenCast Classroom

A dead-simple screen sharing app for classrooms. The teacher shares their screen, students scan a QR code or enter a 4-letter room code, and they can see the teacher's screen on their own device — phone, tablet, or laptop.

## How It Works

1. Teacher opens `/present` and clicks "Share My Screen"
2. A 4-letter room code + QR code appears
3. Students scan the QR code or go to `/view/CODE`
4. Students see the teacher's screen in real-time

**No accounts. No installs. No friction.**

## Tech Stack

- **Node.js + Express** — web server
- **mediasoup** — SFU (Selective Forwarding Unit) for efficient WebRTC relay
- **Socket.io** — signaling
- **Vanilla HTML/CSS/JS** — no frameworks needed

## Why mediasoup?

Pure peer-to-peer WebRTC sends a separate video stream to every viewer. With 30 students, your laptop would upload 30 copies of the stream. mediasoup acts as a relay — your laptop sends ONE stream to the server, and the server fans it out to all viewers.

## Setup

```bash
# Clone and setup
git clone <this-repo>
cd classroom-screen-share
bash setup.sh

# Start the server
npm start
```

The setup script:
- Installs npm dependencies
- Generates self-signed SSL certificates (WebRTC requires HTTPS)

## Usage

- **Presenter:** `https://YOUR_SERVER_IP:3101/present`
- **Viewer:** `https://YOUR_SERVER_IP:3101/view/CODE` (or scan QR code)

### Self-Signed Certificate Warning

Since we use self-signed certs, students will see a browser warning the first time. They just need to click "Advanced" → "Proceed anyway." This only happens once.

For production, use a real domain + Let's Encrypt cert.

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 3100 | HTTP | Redirects to HTTPS |
| 3101 | HTTPS | Main app |
| 40000-40100 | UDP/TCP | WebRTC media (mediasoup) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANNOUNCED_IP` | Auto-detected | Public IP for WebRTC ICE candidates |

## Features

- 🖥️ One-click screen sharing
- 📱 QR code for instant mobile access
- 👥 Real-time viewer count
- 🔄 Auto-reconnect handling
- 📺 Fullscreen toggle (tap/click)
- 🧹 Auto-cleanup when presenter disconnects
- 🏠 Multiple simultaneous rooms supported
