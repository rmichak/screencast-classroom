const fs = require('fs');
const https = require('https');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const os = require('os');
const path = require('path');

// ── Config ──────────────────────────────────────────────
const HTTP_PORT = 3100;
const HTTPS_PORT = 3101;
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || getLocalIp();
const PRESENTER_PASSWORD = process.env.PRESENTER_PASSWORD || 'teach2026';

const mediaCodecs = [
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {},
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 0,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d0032',
      'level-asymmetry-allowed': 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42001f',
      'level-asymmetry-allowed': 1,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
];

// ── Rooms ───────────────────────────────────────────────
const rooms = new Map(); // code -> { router, presenter, producerTransport, producer, consumers: Map<socketId, {transport, consumer}> }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O to avoid confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// ── Network helper ──────────────────────────────────────
function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Express ─────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth tokens (in-memory, short-lived)
const authTokens = new Set();

// Route: presenter auth
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === PRESENTER_PASSWORD) {
    const token = require('crypto').randomBytes(32).toString('hex');
    authTokens.add(token);
    // Token expires in 12 hours
    setTimeout(() => authTokens.delete(token), 12 * 60 * 60 * 1000);
    console.log(`🔐 Presenter authenticated`);
    res.json({ success: true, token });
  } else {
    console.log(`🚫 Failed auth attempt`);
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});

// Route: presenter page (always served, auth checked client-side)
app.get('/present', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});

// Route: viewer page (no auth needed)
app.get('/view/:code?', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// Route: API to get server info
app.get('/api/info', (req, res) => {
  res.json({ ip: ANNOUNCED_IP, httpsPort: HTTPS_PORT });
});

// ── HTTP redirect to HTTPS ──────────────────────────────
const httpServer = http.createServer((req, res) => {
  const host = req.headers.host?.replace(`:${HTTP_PORT}`, `:${HTTPS_PORT}`) || `localhost:${HTTPS_PORT}`;
  res.writeHead(301, { Location: `https://${host}${req.url}` });
  res.end();
});

// ── HTTPS server ────────────────────────────────────────
const httpsServer = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
}, app);

const io = new Server(httpsServer, {
  cors: { origin: '*' },
});

// ── mediasoup ───────────────────────────────────────────
let worker;

async function startMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 40000,
    rtcMaxPort: 40100,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died! Exiting...');
    process.exit(1);
  });

  console.log(`✅ mediasoup worker started (pid: ${worker.pid})`);
}

async function createRoom(code) {
  const router = await worker.createRouter({ mediaCodecs });
  const room = {
    code,
    router,
    presenter: null,
    producerTransport: null,
    producer: null,
    consumers: new Map(), // socketId -> { transport, consumer }
  };
  rooms.set(code, room);
  return room;
}

async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport({
    listenInfos: [
      {
        protocol: 'udp',
        ip: '0.0.0.0',
        announcedAddress: ANNOUNCED_IP,
        portRange: { min: 40000, max: 40100 },
      },
      {
        protocol: 'tcp',
        ip: '0.0.0.0',
        announcedAddress: ANNOUNCED_IP,
        portRange: { min: 40000, max: 40100 },
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

// ── Socket.io ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // ── Presenter: create room (requires auth token) ──
  socket.on('createRoom', async ({ token }, callback) => {
    try {
      if (!token || !authTokens.has(token)) {
        return callback({ error: 'Unauthorized' });
      }
      const code = generateRoomCode();
      const room = await createRoom(code);
      room.presenter = socket.id;
      socket.join(code);
      socket.roomCode = code;
      socket.isPresenter = true;
      console.log(`📺 Room ${code} created by ${socket.id}`);
      callback({ code });
    } catch (err) {
      console.error('createRoom error:', err);
      callback({ error: err.message });
    }
  });

  // ── Presenter: get transport to send ──
  socket.on('createProducerTransport', async (callback) => {
    try {
      const room = rooms.get(socket.roomCode);
      if (!room) return callback({ error: 'Room not found' });

      const { transport, params } = await createWebRtcTransport(room.router);
      room.producerTransport = transport;
      callback(params);
    } catch (err) {
      console.error('createProducerTransport error:', err);
      callback({ error: err.message });
    }
  });

  // ── Presenter: connect transport ──
  socket.on('connectProducerTransport', async ({ dtlsParameters }, callback) => {
    try {
      const room = rooms.get(socket.roomCode);
      if (!room?.producerTransport) return callback({ error: 'No transport' });
      await room.producerTransport.connect({ dtlsParameters });
      callback({});
    } catch (err) {
      console.error('connectProducerTransport error:', err);
      callback({ error: err.message });
    }
  });

  // ── Presenter: start producing (sending screen) ──
  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    try {
      const room = rooms.get(socket.roomCode);
      if (!room?.producerTransport) return callback({ error: 'No transport' });

      room.producer = await room.producerTransport.produce({ kind, rtpParameters });
      console.log(`🎬 Producer created in room ${socket.roomCode}`);

      // Notify viewers in this room that producer is ready
      socket.to(socket.roomCode).emit('producerReady');

      callback({ id: room.producer.id });
    } catch (err) {
      console.error('produce error:', err);
      callback({ error: err.message });
    }
  });

  // ── Viewer: join room ──
  socket.on('joinRoom', async ({ code }, callback) => {
    try {
      const room = rooms.get(code?.toUpperCase());
      if (!room) return callback({ error: 'Room not found', noRoom: true });

      socket.join(code.toUpperCase());
      socket.roomCode = code.toUpperCase();
      socket.isPresenter = false;

      // Update viewer count
      const viewerCount = getViewerCount(room);
      io.to(room.code).emit('viewerCount', viewerCount + 1);

      const hasProducer = !!room.producer;
      console.log(`👀 Viewer ${socket.id} joined room ${code} (producer: ${hasProducer})`);

      callback({
        hasProducer,
        rtpCapabilities: room.router.rtpCapabilities,
      });
    } catch (err) {
      console.error('joinRoom error:', err);
      callback({ error: err.message });
    }
  });

  // ── Viewer: get transport to receive ──
  socket.on('createConsumerTransport', async (callback) => {
    try {
      const room = rooms.get(socket.roomCode);
      if (!room) return callback({ error: 'Room not found' });

      const { transport, params } = await createWebRtcTransport(room.router);
      room.consumers.set(socket.id, { transport, consumer: null });
      callback(params);
    } catch (err) {
      console.error('createConsumerTransport error:', err);
      callback({ error: err.message });
    }
  });

  // ── Viewer: connect transport ──
  socket.on('connectConsumerTransport', async ({ dtlsParameters }, callback) => {
    try {
      const room = rooms.get(socket.roomCode);
      const consumerData = room?.consumers.get(socket.id);
      if (!consumerData?.transport) return callback({ error: 'No transport' });
      await consumerData.transport.connect({ dtlsParameters });
      callback({});
    } catch (err) {
      console.error('connectConsumerTransport error:', err);
      callback({ error: err.message });
    }
  });

  // ── Viewer: consume (receive screen) ──
  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    try {
      const room = rooms.get(socket.roomCode);
      if (!room?.producer) return callback({ error: 'No producer' });

      if (!room.router.canConsume({ producerId: room.producer.id, rtpCapabilities })) {
        return callback({ error: 'Cannot consume' });
      }

      const consumerData = room.consumers.get(socket.id);
      if (!consumerData?.transport) return callback({ error: 'No consumer transport' });

      const consumer = await consumerData.transport.consume({
        producerId: room.producer.id,
        rtpCapabilities,
        paused: false,
      });

      consumerData.consumer = consumer;

      callback({
        id: consumer.id,
        producerId: room.producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (err) {
      console.error('consume error:', err);
      callback({ error: err.message });
    }
  });

  // ── Get RTP capabilities ──
  socket.on('getRtpCapabilities', (callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });
    callback({ rtpCapabilities: room.router.rtpCapabilities });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    if (socket.isPresenter) {
      // Presenter left — clean up entire room
      console.log(`📺 Presenter left room ${socket.roomCode} — cleaning up`);
      io.to(socket.roomCode).emit('presenterLeft');

      // Close all consumer transports
      for (const [, data] of room.consumers) {
        data.transport?.close();
        data.consumer?.close();
      }
      room.producerTransport?.close();
      room.producer?.close();
      room.router.close();
      rooms.delete(socket.roomCode);
    } else {
      // Viewer left
      const consumerData = room.consumers.get(socket.id);
      if (consumerData) {
        consumerData.transport?.close();
        consumerData.consumer?.close();
        room.consumers.delete(socket.id);
      }
      // Update viewer count
      const viewerCount = getViewerCount(room);
      io.to(room.code).emit('viewerCount', viewerCount);
    }
  });
});

function getViewerCount(room) {
  return room.consumers.size;
}

// ── Start ───────────────────────────────────────────────
(async () => {
  await startMediasoup();

  httpServer.listen(HTTP_PORT, () => {
    console.log(`🔀 HTTP redirect on port ${HTTP_PORT}`);
  });

  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`🚀 Classroom Screen Share running!`);
    console.log(`   Presenter: https://${ANNOUNCED_IP}:${HTTPS_PORT}/present`);
    console.log(`   Viewer:    https://${ANNOUNCED_IP}:${HTTPS_PORT}/view/CODE`);
    console.log(`   Announced IP: ${ANNOUNCED_IP}`);
  });
})();
