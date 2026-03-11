/* ── Presenter Logic (Plain WebRTC P2P) ─────────── */
const socket = io();
let stream = null;
let authToken = null;
const peerConnections = new Map(); // viewerId -> RTCPeerConnection

// Free TURN/STUN servers for NAT traversal
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  {
    urls: 'turn:global.relay.metered.ca:80',
    username: 'b4be29935fda005de7b3c8e4',
    credential: 'o4MgYqoqp4VOMiDy',
  },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: 'b4be29935fda005de7b3c8e4',
    credential: 'o4MgYqoqp4VOMiDy',
  },
  {
    urls: 'turn:global.relay.metered.ca:443',
    username: 'b4be29935fda005de7b3c8e4',
    credential: 'o4MgYqoqp4VOMiDy',
  },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: 'b4be29935fda005de7b3c8e4',
    credential: 'o4MgYqoqp4VOMiDy',
  },
];

// Check saved auth
const savedToken = sessionStorage.getItem('presenterToken');
if (savedToken) {
  authToken = savedToken;
  document.getElementById('authPanel').classList.add('hidden');
  document.getElementById('startPanel').classList.remove('hidden');
}

document.getElementById('passwordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') authenticate();
});

// ── Socket events ───────────────────────────────────────
socket.on('viewerCount', (count) => {
  document.getElementById('viewerCount').textContent = count;
});

// New viewer joined — create peer connection and send offer
socket.on('viewerJoined', async ({ viewerId }) => {
  if (!stream) return;
  console.log(`New viewer: ${viewerId}`);
  await createPeerConnection(viewerId);
});

// Viewer sent answer
socket.on('answer', async ({ viewerId, answer }) => {
  const pc = peerConnections.get(viewerId);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    console.log(`Answer set for viewer: ${viewerId}`);
  }
});

// ICE candidate from viewer
socket.on('iceCandidate', async ({ senderId, candidate }) => {
  const pc = peerConnections.get(senderId);
  if (pc && candidate) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// Viewer left
socket.on('viewerLeft', ({ viewerId }) => {
  const pc = peerConnections.get(viewerId);
  if (pc) {
    pc.close();
    peerConnections.delete(viewerId);
  }
});

// ── Auth ────────────────────────────────────────────────
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

// ── Peer Connection ─────────────────────────────────────
async function createPeerConnection(viewerId) {
  const pc = new RTCPeerConnection({ iceServers });
  peerConnections.set(viewerId, pc);

  // Add screen tracks to this connection
  stream.getTracks().forEach((track) => {
    pc.addTrack(track, stream);
  });

  // Send ICE candidates to viewer
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('iceCandidate', { targetId: viewerId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`Peer ${viewerId}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      pc.close();
      peerConnections.delete(viewerId);
    }
  };

  // Create and send offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { viewerId, offer: pc.localDescription });
}

// ── Start Sharing ───────────────────────────────────────
async function startSharing() {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false,
    });

    stream.getVideoTracks()[0].onended = () => stopSharing();
    document.getElementById('preview').srcObject = stream;

    // Create room
    const { code, error } = await new Promise((resolve) =>
      socket.emit('createRoom', { token: authToken }, resolve)
    );

    if (error) {
      if (error === 'Unauthorized') {
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

    // Notify server stream is ready
    socket.emit('streamReady');

    // Update UI
    document.getElementById('startPanel').classList.add('hidden');
    document.getElementById('sharingPanel').classList.add('active');
    document.getElementById('roomCode').textContent = code;

    const viewerUrl = `${location.origin}/view/${code}`;
    const linkEl = document.getElementById('viewerLink');
    linkEl.href = viewerUrl;
    linkEl.textContent = viewerUrl;

    QRCode.toCanvas(document.getElementById('qrCanvas'), viewerUrl, {
      width: 200, margin: 1, color: { dark: '#0a0f1a', light: '#ffffff' },
    });

  } catch (err) {
    console.error('Failed:', err);
    if (err.name === 'NotAllowedError') return;
    alert('Failed to start sharing: ' + err.message);
  }
}

function stopSharing() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();
  socket.disconnect();

  document.getElementById('startPanel').classList.remove('hidden');
  document.getElementById('sharingPanel').classList.remove('active');
  document.getElementById('preview').srcObject = null;
  document.getElementById('viewerCount').textContent = '0';

  socket.connect();
}
