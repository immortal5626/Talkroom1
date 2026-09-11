const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// roomId -> Map(socketId -> guestName)
const rooms = new Map();

const ADJ = ["Warm", "Quiet", "Bright", "Swift", "Calm", "Bold", "Sunny", "Cool", "Kind", "Lucky"];
const NOUN = ["Fox", "River", "Maple", "Comet", "Otter", "Harbor", "Ember", "Falcon", "Cedar", "Pebble"];

function generateRoomCode() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const num = Math.floor(10 + Math.random() * 90);
  return `${a}-${n}-${num}`;
}

function generateGuestName() {
  return `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
}

io.on("connection", (socket) => {
  let currentRoom = null;
  let guestName = generateGuestName();

  socket.on("create-room", (cb) => {
    let code = generateRoomCode();
    while (rooms.has(code)) code = generateRoomCode();
    cb({ roomId: code });
  });

  socket.on("join-room", ({ roomId }) => {
    if (!roomId) return;
    currentRoom = roomId;
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const roomMembers = rooms.get(roomId);

    const existingPeers = Array.from(roomMembers.entries()).map(([id, name]) => ({ id, name }));

    roomMembers.set(socket.id, guestName);

    socket.emit("joined", { self: { id: socket.id, name: guestName }, peers: existingPeers, roomId });
    socket.to(roomId).emit("peer-joined", { id: socket.id, name: guestName });
  });

  socket.on("chat-message", ({ text }) => {
    if (!currentRoom || !text) return;
    io.to(currentRoom).emit("chat-message", {
      id: socket.id,
      name: guestName,
      text: String(text).slice(0, 2000),
      time: Date.now(),
    });
  });

  // WebRTC signaling relay (mesh: messages targeted at a specific peer)
  socket.on("signal", ({ to, data }) => {
    if (!to) return;
    io.to(to).emit("signal", { from: socket.id, name: guestName, data });
  });

  socket.on("call-ended", () => {
    if (currentRoom) socket.to(currentRoom).emit("peer-left-call", { id: socket.id });
  });

  socket.on("disconnect", () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(socket.id);
      if (rooms.get(currentRoom).size === 0) rooms.delete(currentRoom);
      socket.to(currentRoom).emit("peer-left", { id: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`TalkRoom running on port ${PORT}`));
