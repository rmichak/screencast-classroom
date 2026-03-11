/* ── Viewer Logic ────────────────────────────────── */
const socket = io();
let device = null;
let consumerTransport = null;

// mediasoup-client is loaded via local bundle in the HTML
// Init on page load
document.addEventListener('DOMContentLoaded', init);

function init() {
  // Check URL for room code
  const pathMatch = location.pathname.match(/\/view\/([A-Za-z]{4})/);
  const urlParams = new URLSearchParams(location.search);
  const code = pathMatch?.[1] || urlParams.get('code');

  if (code) {
    joinRoom(code.toUpperCase());
  } else {
    // Show join form
    document.getElementById('joinContainer').style.display = '';

    // Auto-join on 4 characters
    const input = document.getElementById('codeInput');
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '');
      if (input.value.length === 4) {
        joinWithCode();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinWithCode();
    });
  }
}

function joinWithCode() {
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) {
    showError('Enter a 4-letter code');
    return;
  }
  joinRoom(code);
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

async function joinRoom(code) {
  // Hide join form, show viewer
  document.getElementById('joinContainer').style.display = 'none';
  document.getElementById('viewerContainer').style.display = '';

  try {
    // 1. Join room on server
    const result = await new Promise((resolve) =>
      socket.emit('joinRoom', { code }, resolve)
    );

    if (result.error) {
      if (result.noRoom) {
        // Room doesn't exist — go back to join form
        document.getElementById('joinContainer').style.display = '';
        document.getElementById('viewerContainer').style.display = 'none';
        showError('Room not found. Check the code and try again.');
        return;
      }
      throw new Error(result.error);
    }

    // 2. Create mediasoup device
    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: result.rtpCapabilities });

    if (result.hasProducer) {
      // Producer already active — start consuming
      await startConsuming();
    } else {
      // Show waiting state
      document.getElementById('waitingStatus').style.display = '';
    }

    // 3. Listen for producer ready (if we're waiting)
    socket.on('producerReady', async () => {
      document.getElementById('waitingStatus').style.display = 'none';
      await startConsuming();
    });

    // 4. Listen for presenter leaving
    socket.on('presenterLeft', () => {
      document.getElementById('remoteVideo').style.display = 'none';
      document.getElementById('waitingStatus').style.display = 'none';
      document.getElementById('endedStatus').style.display = '';
    });

  } catch (err) {
    console.error('joinRoom error:', err);
    document.getElementById('waitingStatus').style.display = 'none';
    document.getElementById('endedStatus').querySelector('h2').textContent = 'Connection Error';
    document.getElementById('endedStatus').querySelector('p').textContent = err.message;
    document.getElementById('endedStatus').style.display = '';
  }
}

async function startConsuming() {
  try {
    // 1. Create consumer transport
    const transportParams = await new Promise((resolve) =>
      socket.emit('createConsumerTransport', resolve)
    );
    if (transportParams.error) throw new Error(transportParams.error);

    consumerTransport = device.createRecvTransport(transportParams);

    consumerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      socket.emit('connectConsumerTransport', { dtlsParameters }, (res) => {
        if (res.error) errback(new Error(res.error));
        else callback();
      });
    });

    // 2. Consume
    const consumeResult = await new Promise((resolve) =>
      socket.emit('consume', { rtpCapabilities: device.rtpCapabilities }, resolve)
    );
    if (consumeResult.error) throw new Error(consumeResult.error);

    // 3. Create consumer and attach to video
    const consumer = await consumerTransport.consume({
      id: consumeResult.id,
      producerId: consumeResult.producerId,
      kind: consumeResult.kind,
      rtpParameters: consumeResult.rtpParameters,
    });

    // IMPORTANT: consumer.track is already a MediaStreamTrack
    // But we need to create a new MediaStream and add it
    const remoteStream = new MediaStream([consumer.track]);
    const video = document.getElementById('remoteVideo');
    video.srcObject = remoteStream;
    video.style.display = '';

    // Hide any status messages
    document.getElementById('waitingStatus').style.display = 'none';
    document.getElementById('endedStatus').style.display = 'none';

    // Fullscreen hint
    const hint = document.getElementById('fullscreenHint');
    setTimeout(() => hint.classList.add('hidden'), 5000);

  } catch (err) {
    console.error('startConsuming error:', err);
  }
}

// ── Fullscreen toggle on click ──────────────────────
document.addEventListener('click', (e) => {
  if (!document.getElementById('viewerContainer').contains(e.target)) return;
  if (e.target.closest('.join-container')) return;

  const el = document.documentElement;
  if (!document.fullscreenElement) {
    el.requestFullscreen?.() || el.webkitRequestFullscreen?.();
  } else {
    document.exitFullscreen?.() || document.webkitExitFullscreen?.();
  }
});
