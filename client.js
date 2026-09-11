const socket = io();

const ICE_SERVERS = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ---- Screens ----
const landing = document.getElementById("landing");
const roomEl = document.getElementById("room");
const landingError = document.getElementById("landingError");

// ---- Landing controls ----
const createRoomBtn = document.getElementById("createRoomBtn");
const joinForm = document.getElementById("joinForm");
const roomCodeInput = document.getElementById("roomCodeInput");

// ---- Room controls ----
const roomCodeLabel = document.getElementById("roomCodeLabel");
const selfNameEl = document.getElementById("selfName");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const leaveBtn = document.getElementById("leaveBtn");
const messagesEl = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const videoStrip = document.getElementById("videoStrip");
const callToggleBtn = document.getElementById("callToggleBtn");
const callBtnLabel = document.getElementById("callBtnLabel");
const micToggleBtn = document.getElementById("micToggleBtn");
const camToggleBtn = document.getElementById("camToggleBtn");

let selfId = null;
let selfName = null;
let currentRoomId = null;

let localStream = null;
let inCall = false;
let micOn = true;
let camOn = true;
const peerConnections = new Map(); // peerId -> RTCPeerConnection
const knownPeers = new Map(); // peerId -> name

function showError(msg) {
  landingError.textContent = msg;
  landingError.hidden = false;
}

// ---- Entering a room ----
function enterRoom(roomId) {
  socket.emit("join-room", { roomId });
}

createRoomBtn.addEventListener("click", () => {
  socket.emit("create-room", ({ roomId }) => enterRoom(roomId));
});

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const code = roomCodeInput.value.trim();
  if (!code) return showError("Enter a room code to join.");
  enterRoom(code);
});

// URL like /?room=Warm-Fox-42 auto-joins
const urlParams = new URLSearchParams(window.location.search);
const urlRoom = urlParams.get("room");
if (urlRoom) enterRoom(urlRoom);

socket.on("joined", ({ self, peers, roomId }) => {
  selfId = self.id;
  selfName = self.name;
  currentRoomId = roomId;

  landing.hidden = true;
  roomEl.hidden = false;
  roomCodeLabel.textContent = roomId;
  selfNameEl.textContent = selfName;

  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.replaceState({}, "", url);

  peers.forEach((p) => knownPeers.set(p.id, p.name));
  addSystemMessage(`You joined as ${selfName}.`);
});

copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copyLinkBtn.textContent = "Copied!";
    setTimeout(() => (copyLinkBtn.textContent = "Copy invite"), 1500);
  } catch {
    showError("Couldn't copy — copy the link from your address bar.");
  }
});

leaveBtn.addEventListener("click", () => window.location.reload());

// ---- Chat ----
function addMessage({ id, name, text }) {
  const div = document.createElement("div");
  div.className = "msg" + (id === selfId ? " self" : "");
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = id === selfId ? "You" : name;
  const body = document.createElement("div");
  body.textContent = text;
  div.appendChild(who);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit("chat-message", { text });
  messageInput.value = "";
}

sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

socket.on("chat-message", (msg) => addMessage(msg));

socket.on("peer-joined", ({ id, name }) => {
  knownPeers.set(id, name);
  addSystemMessage(`${name} joined the room.`);
  if (inCall) callPeer(id);
});

socket.on("peer-left", ({ id }) => {
  const name = knownPeers.get(id) || "Someone";
  addSystemMessage(`${name} left the room.`);
  knownPeers.delete(id);
  removePeerConnection(id);
});

socket.on("peer-left-call", ({ id }) => removePeerConnection(id));

// ---- WebRTC (mesh) ----
callToggleBtn.addEventListener("click", () => {
  if (inCall) endCall();
  else startCall();
});

async function startCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    addSystemMessage("Camera/mic permission was denied — can't start the call.");
    return;
  }
  inCall = true;
  callToggleBtn.classList.add("active");
  callBtnLabel.textContent = "End";
  micToggleBtn.hidden = false;
  camToggleBtn.hidden = false;
  videoStrip.hidden = false;
  addVideoTile(selfId, "You", localStream, true);

  knownPeers.forEach((_, id) => callPeer(id));
  addSystemMessage("Call started.");
}

function endCall() {
  inCall = false;
  callToggleBtn.classList.remove("active");
  callBtnLabel.textContent = "Call";
  micToggleBtn.hidden = true;
  camToggleBtn.hidden = true;
  videoStrip.hidden = true;
  videoStrip.innerHTML = "";

  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  socket.emit("call-ended");
  addSystemMessage("You left the call.");
}

function getOrCreatePeerConnection(peerId) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections.set(peerId, pc);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("signal", { to: peerId, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    const name = knownPeers.get(peerId) || "Guest";
    addVideoTile(peerId, name, e.streams[0], false);
  };

  pc.onconnectionstatechange = () => {
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      removePeerConnection(peerId);
    }
  };

  return pc;
}

async function callPeer(peerId) {
  if (!localStream) return;
  const pc = getOrCreatePeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("signal", { to: peerId, data: { sdp: offer } });
}

socket.on("signal", async ({ from, name, data }) => {
  knownPeers.set(from, name);

  if (data.sdp) {
    if (data.sdp.type === "offer" && !inCall) {
      // Someone is calling us while we're not in the call yet — join automatically
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        addSystemMessage("Camera/mic permission was denied — can't join the call.");
        return;
      }
      inCall = true;
      callToggleBtn.classList.add("active");
      callBtnLabel.textContent = "End";
      micToggleBtn.hidden = false;
      camToggleBtn.hidden = false;
      videoStrip.hidden = false;
      addVideoTile(selfId, "You", localStream, true);
    }

    const pc = getOrCreatePeerConnection(from);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

    if (data.sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("signal", { to: from, data: { sdp: answer } });
    }
  } else if (data.candidate) {
    const pc = getOrCreatePeerConnection(from);
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch {
      /* ignore benign ICE race errors */
    }
  }
});

function removePeerConnection(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.close();
    peerConnections.delete(peerId);
  }
  const tile = document.getElementById("tile-" + peerId);
  if (tile) tile.remove();
}

function addVideoTile(id, name, stream, isSelf) {
  let tile = document.getElementById("tile-" + id);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-tile";
    tile.id = "tile-" + id;
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    if (isSelf) video.muted = true;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = isSelf ? "You" : name;
    tile.appendChild(video);
    tile.appendChild(label);
    videoStrip.appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
}

// ---- Mic / camera toggles ----
micToggleBtn.addEventListener("click", () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  micToggleBtn.classList.toggle("muted", !micOn);
});

camToggleBtn.addEventListener("click", () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  camToggleBtn.classList.toggle("muted", !camOn);
});
