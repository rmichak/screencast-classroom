const fs = require('fs');
const https = require('https');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

// ── Config ──────────────────────────────────────────────
const HTTP_PORT = 3100;
const HTTPS_PORT = 3101;
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || getLocalIp();
const PRESENTER_PASSWORD = process.env.PRESENTER_PASSWORD || 'teach2026';

// ── Rooms ───────────────────────────────────────────────
const rooms = new Map(); // code -> { presenter: socketId, viewers: Set<socketId> }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Auth ────────────────────────────────────────────────
const authTokens = new Set();

// ── Express ─────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === PRESENTER_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    authTokens.add(token);
    setTimeout(() => authTokens.delete(token), 12 * 60 * 60 * 1000);
    console.log('🔐 Presenter authenticated');
    res.json({ success: true, token });
  } else {
    console.log('🚫 Failed auth attempt');
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});

app.get('/present', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});

app.get('/view/:code?', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/api/info', (req, res) => {
  res.json({ ip: ANNOUNCED_IP, httpsPort: HTTPS_PORT });
});

// ── HTTPS server ────────────────────────────────────────
const httpsServer = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
}, app);

// ── HTTP redirect ───────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const host = req.headers.host?.replace(`:${HTTP_PORT}`, `:${HTTPS_PORT}`) || `localhost:${HTTPS_PORT}`;
  res.writeHead(301, { Location: `https://${host}${req.url}` });
  res.end();
});

const io = new Server(httpsServer, {
  cors: { origin: '*' },
});

// ── Socket.io signaling (peer-to-peer WebRTC) ──────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // Presenter creates a room
  socket.on('createRoom', ({ token }, callback) => {
    if (!token || !authTokens.has(token)) {
      return callback({ error: 'Unauthorized' });
    }
    const code = generateRoomCode();
    rooms.set(code, { presenter: socket.id, viewers: new Set() });
    socket.join(code);
    socket.roomCode = code;
    socket.isPresenter = true;
    console.log(`📺 Room ${code} created`);
    callback({ code });
  });

  // Viewer joins a room
  socket.on('joinRoom', ({ code }, callback) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return callback({ error: 'Room not found', noRoom: true });

    const upperCode = code.toUpperCase();
    socket.join(upperCode);
    socket.roomCode = upperCode;
    socket.isPresenter = false;
    room.viewers.add(socket.id);

    // Tell presenter a new viewer joined
    io.to(room.presenter).emit('viewerJoined', { viewerId: socket.id });
    io.to(upperCode).emit('viewerCount', room.viewers.size);

    console.log(`👀 Viewer joined room ${upperCode} (${room.viewers.size} viewers)`);
    callback({ success: true });
  });

  // ── WebRTC signaling ──────────────────────────────────
  // Presenter sends offer to a specific viewer
  socket.on('offer', ({ viewerId, offer }) => {
    io.to(viewerId).emit('offer', { offer });
  });

  // Viewer sends answer back to presenter
  socket.on('answer', ({ answer }) => {
    const room = rooms.get(socket.roomCode);
    if (room) {
      io.to(room.presenter).emit('answer', { viewerId: socket.id, answer });
    }
  });

  // ICE candidate exchange
  socket.on('iceCandidate', ({ targetId, candidate }) => {
    if (targetId) {
      // Presenter sending to specific viewer
      io.to(targetId).emit('iceCandidate', { senderId: socket.id, candidate });
    } else {
      // Viewer sending to presenter
      const room = rooms.get(socket.roomCode);
      if (room) {
        io.to(room.presenter).emit('iceCandidate', { senderId: socket.id, candidate });
      }
    }
  });

  // Presenter notifies that stream is ready
  socket.on('streamReady', () => {
    const room = rooms.get(socket.roomCode);
    if (room) {
      socket.to(socket.roomCode).emit('streamReady');
    }
  });

  // ── Disconnect ────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    if (socket.isPresenter) {
      console.log(`📺 Presenter left room ${socket.roomCode}`);
      io.to(socket.roomCode).emit('presenterLeft');
      rooms.delete(socket.roomCode);
    } else {
      room.viewers.delete(socket.id);
      io.to(room.presenter).emit('viewerLeft', { viewerId: socket.id });
      io.to(socket.roomCode).emit('viewerCount', room.viewers.size);
    }
  });
});

// ── Start ───────────────────────────────────────────────
httpServer.listen(HTTP_PORT, () => {
  console.log(`🔀 HTTP redirect on port ${HTTP_PORT}`);
});

httpsServer.listen(HTTPS_PORT, () => {
  console.log(`🚀 Classroom Screen Share running!`);
  console.log(`   Presenter: https://${ANNOUNCED_IP}:${HTTPS_PORT}/present`);
  console.log(`   Viewer:    https://${ANNOUNCED_IP}:${HTTPS_PORT}/view/CODE`);
});
