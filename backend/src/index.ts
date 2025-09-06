import { Socket } from "socket.io";
import http from "http";
import express from 'express';
import { Server } from 'socket.io';
import { UserManager } from "./managers/UserManger";

const app = express();
const server = http.createServer(app); // Fixed: was http.createServer(http)

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const userManager = new UserManager();

io.on('connection', (socket: Socket) => {
  console.log('🔌 User connected:', socket.id);
  
  // Handle user joining with name
  socket.on("join", ({name}: {name: string}) => {
    console.log(`👤 User ${name || 'Anonymous'} joined with socket ${socket.id}`);
    userManager.addUser(name || "Anonymous", socket);
  });
  
  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
    userManager.removeUser(socket.id);
  });
});

server.listen(3000, () => {
    console.log('Server listening on *:3000');
});