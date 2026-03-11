/* ── Presenter Logic ─────────────────────────────── */
const socket = io();
let stream = null;
let producerTransport = null;
let producer = null;
let device = null;
let roomCode = null;

// Load mediasoup-client from CDN
const script = document.createElement('script');
script.src = 'https://cdn.jsdelivr.net/npm/mediasoup-client@3.7.4/lib/mediasoup-client.min.js';
script.onload = () => console.log('mediasoup-client loaded');
document.head.appendChild(script);

// Listen for viewer count
socket.on('viewerCount', (count) => {
  document.getElementById('viewerCount').textContent = count;
});

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

    // 2. Create room on server
    const { code, error } = await new Promise((resolve) =>
      socket.emit('createRoom', resolve)
    );
    if (error) throw new Error(error);
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

    // 5. Produce the video track
    producer = await producerTransport.produce({
      track: stream.getVideoTracks()[0],
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

  // Build viewer URL
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
