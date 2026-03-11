/* ── Viewer Logic (Plain WebRTC P2P) ────────────── */
const socket = io();
let pc = null;

// Same TURN/STUN servers as presenter
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

function init() {
  const pathMatch = location.pathname.match(/\/view\/([A-Za-z]{4})/);
  const urlParams = new URLSearchParams(location.search);
  const code = pathMatch?.[1] || urlParams.get('code');

  if (code) {
    joinRoom(code.toUpperCase());
  } else {
    document.getElementById('joinContainer').style.display = '';
    const input = document.getElementById('codeInput');
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '');
      if (input.value.length === 4) joinWithCode();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinWithCode(); });
  }
}

function joinWithCode() {
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { showError('Enter a 4-letter code'); return; }
  joinRoom(code);
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

async function joinRoom(code) {
  document.getElementById('joinContainer').style.display = 'none';
  document.getElementById('viewerContainer').style.display = '';
  document.getElementById('waitingStatus').style.display = '';

  const result = await new Promise((resolve) =>
    socket.emit('joinRoom', { code }, resolve)
  );

  if (result.error) {
    if (result.noRoom) {
      document.getElementById('joinContainer').style.display = '';
      document.getElementById('viewerContainer').style.display = 'none';
      showError('Room not found. Check the code and try again.');
      return;
    }
    document.getElementById('waitingStatus').style.display = 'none';
    document.getElementById('endedStatus').querySelector('h2').textContent = 'Error';
    document.getElementById('endedStatus').querySelector('p').textContent = result.error;
    document.getElementById('endedStatus').style.display = '';
    return;
  }

  // Wait for offer from presenter
  socket.on('offer', async ({ offer }) => {
    console.log('Received offer from presenter');
    await setupPeerConnection(offer);
  });

  // Stream is already live — presenter will send offer when we join
  socket.on('streamReady', () => {
    console.log('Stream ready — waiting for offer');
  });

  socket.on('presenterLeft', () => {
    if (pc) { pc.close(); pc = null; }
    document.getElementById('remoteVideo').style.display = 'none';
    document.getElementById('waitingStatus').style.display = 'none';
    document.getElementById('endedStatus').style.display = '';
  });
}

async function setupPeerConnection(offer) {
  pc = new RTCPeerConnection({ iceServers });

  // When we receive the stream
  pc.ontrack = (event) => {
    console.log('Got remote track!');
    const video = document.getElementById('remoteVideo');
    video.srcObject = event.streams[0];
    video.style.display = '';
    document.getElementById('waitingStatus').style.display = 'none';
    document.getElementById('endedStatus').style.display = 'none';

    // Hide fullscreen hint after 5s
    const hint = document.getElementById('fullscreenHint');
    setTimeout(() => hint.classList.add('hidden'), 5000);
  };

  // Send ICE candidates back to presenter via server
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('iceCandidate', { candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('Connection state:', pc.connectionState);
    if (pc.connectionState === 'failed') {
      document.getElementById('remoteVideo').style.display = 'none';
      document.getElementById('waitingStatus').style.display = 'none';
      document.getElementById('endedStatus').querySelector('h2').textContent = 'Connection Lost';
      document.getElementById('endedStatus').querySelector('p').textContent = 'Could not connect to the presenter. Try refreshing.';
      document.getElementById('endedStatus').style.display = '';
    }
  };

  // Set offer and create answer
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { answer: pc.localDescription });
}

// Fullscreen toggle
document.addEventListener('click', (e) => {
  if (!document.getElementById('viewerContainer')?.contains(e.target)) return;
  if (e.target.closest('.join-container')) return;
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    el.requestFullscreen?.() || el.webkitRequestFullscreen?.();
  } else {
    document.exitFullscreen?.() || document.webkitExitFullscreen?.();
  }
});

document.addEventListener('DOMContentLoaded', init);
