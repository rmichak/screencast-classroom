/* ── Presenter Logic ─────────────────────────────── */
// mediasoup-client is loaded via local bundle in the HTML

const socket = io();
let stream = null;
let producerTransport = null;
let producer = null;
let device = null;
let roomCode = null;
let authToken = null;

// Check if already authed (sessionStorage survives page refresh)
const savedToken = sessionStorage.getItem('presenterToken');
if (savedToken) {
  authToken = savedToken;
  document.getElementById('authPanel').classList.add('hidden');
  document.getElementById('startPanel').classList.remove('hidden');
}

// Listen for Enter key on password input
document.getElementById('passwordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') authenticate();
});

// Listen for viewer count
socket.on('viewerCount', (count) => {
  document.getElementById('viewerCount').textContent = count;
});

async function authenticate() {
  const password = document.getElementById('passwordInput').value;
  const errorEl = document.getElementById('authError');

  if (!password) {
    errorEl.textContent = 'Enter a password';
    errorEl.classList.add('show');
    return;
  }

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

    if (data.success) {
      authToken = data.token;
      sessionStorage.setItem('presenterToken', authToken);
      document.getElementById('authPanel').classList.add('hidden');
      document.getElementById('startPanel').classList.remove('hidden');
      errorEl.classList.remove('show');
    } else {
      errorEl.textContent = 'Wrong password';
      errorEl.classList.add('show');
      document.getElementById('passwordInput').value = '';
      document.getElementById('passwordInput').focus();
      setTimeout(() => errorEl.classList.remove('show'), 3000);
    }
  } catch (err) {
    errorEl.textContent = 'Connection error';
    errorEl.classList.add('show');
  }
}

async function startSharing() {
  try {
    // 1. Get screen stream
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });

    // Handle user clicking "Stop sharing" in browser UI
    stream.getVideoTracks()[0].onended = () => stopSharing();

    // Show preview
    document.getElementById('preview').srcObject = stream;

    // 2. Create room on server (with auth token)
    const { code, error } = await new Promise((resolve) =>
      socket.emit('createRoom', { token: authToken }, resolve)
    );
    if (error) {
      if (error === 'Unauthorized') {
        // Token expired, go back to login
        sessionStorage.removeItem('presenterToken');
        document.getElementById('startPanel').classList.add('hidden');
        document.getElementById('authPanel').classList.remove('hidden');
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        alert('Session expired. Please log in again.');
        return;
      }
      throw new Error(error);
    }
    roomCode = code;

    // 3. Create mediasoup device
    device = new mediasoupClient.Device();
    const { rtpCapabilities } = await new Promise((resolve) =>
      socket.emit('getRtpCapabilities', resolve)
    );
    await device.load({ routerRtpCapabilities: rtpCapabilities });

    // 4. Create producer transport
    const transportParams = await new Promise((resolve) =>
      socket.emit('createProducerTransport', resolve)
    );
    if (transportParams.error) throw new Error(transportParams.error);

    producerTransport = device.createSendTransport(transportParams);

    producerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      socket.emit('connectProducerTransport', { dtlsParameters }, (res) => {
        if (res.error) errback(new Error(res.error));
        else callback();
      });
    });

    producerTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      socket.emit('produce', { kind, rtpParameters }, (res) => {
        if (res.error) errback(new Error(res.error));
        else callback({ id: res.id });
      });
    });

    // 5. Produce the video track (prefer VP8 for max compatibility)
    const codecOptions = [];
    const codec = device.rtpCapabilities.codecs.find(
      (c) => c.mimeType.toLowerCase() === 'video/vp8'
    );
    
    producer = await producerTransport.produce({
      track: stream.getVideoTracks()[0],
      ...(codec ? { codec } : {}),
    });

    // 6. Update UI
    updateUI(code);

  } catch (err) {
    console.error('Failed to start sharing:', err);
    if (err.name === 'NotAllowedError') return; // User cancelled
    alert('Failed to start sharing: ' + err.message);
  }
}

function updateUI(code) {
  document.getElementById('startPanel').classList.add('hidden');
  document.getElementById('sharingPanel').classList.add('active');
  document.getElementById('roomCode').textContent = code;

  // Build viewer URL (use the current origin so it works through any proxy)
  const viewerUrl = `${location.origin}/view/${code}`;
  const linkEl = document.getElementById('viewerLink');
  linkEl.href = viewerUrl;
  linkEl.textContent = viewerUrl;

  // Generate QR code
  QRCode.toCanvas(document.getElementById('qrCanvas'), viewerUrl, {
    width: 200,
    margin: 1,
    color: { dark: '#0a0f1a', light: '#ffffff' },
  });
}

function stopSharing() {
  // Stop all tracks
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  // Close producer + transport
  if (producer) producer.close();
  if (producerTransport) producerTransport.close();

  // Disconnect socket (triggers server cleanup)
  socket.disconnect();

  // Reset UI
  document.getElementById('startPanel').classList.remove('hidden');
  document.getElementById('sharingPanel').classList.remove('active');
  document.getElementById('preview').srcObject = null;
  document.getElementById('viewerCount').textContent = '0';

  // Reconnect socket for next session
  socket.connect();
}
