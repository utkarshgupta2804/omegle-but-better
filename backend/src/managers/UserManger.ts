import { Socket } from "socket.io";
import { RoomManager } from "./RoomManager";

export interface User {
    socket: Socket;
    name: string;
}

export class UserManager {
    private users: User[];
    private queue: string[];
    private roomManager: RoomManager;

    constructor() {
        this.users = [];
        this.queue = [];
        this.roomManager = new RoomManager();
    }

    addUser(name: string, socket: Socket) {
        this.users.push({
            name, socket
        })
        this.queue.push(socket.id);
        socket.emit("lobby");
        this.clearQueue()
        this.initHandlers(socket);
    }

    removeUser(socketId: string) {
        const user = this.users.find(x => x.socket.id === socketId);
        console.log(`🚪 User ${user?.name || 'Unknown'} (${socketId}) disconnected`);

        // Remove from room and get the remaining user
        const remainingUser = this.roomManager.removeUserFromRoom(socketId);

        // If there was a remaining user from a room, add them back to queue
        if (remainingUser) {
            console.log(`♻️ Re-queuing user ${remainingUser.name} (${remainingUser.socket.id})`);

            // Make sure they're not already in queue
            if (!this.queue.includes(remainingUser.socket.id)) {
                this.queue.push(remainingUser.socket.id);
                remainingUser.socket.emit("lobby");

                // Try to match them immediately
                setTimeout(() => {
                    this.clearQueue();
                }, 500);
            }
        }

        // Remove user from users list and queue
        this.users = this.users.filter(x => x.socket.id !== socketId);
        this.queue = this.queue.filter(x => x !== socketId);

        console.log(`📊 Current queue size: ${this.queue.length}, Active users: ${this.users.length}`);
    }

    clearQueue() {
        console.log("🔄 Checking queue for matches");
        console.log(`Queue length: ${this.queue.length}`);

        while (this.queue.length >= 2) {
            const id1 = this.queue.shift(); // take first
            const id2 = this.queue.shift(); // take next

            console.log(`🎯 Attempting to match users: ${id1} and ${id2}`);

            const user1 = this.users.find(x => x.socket.id === id1);
            const user2 = this.users.find(x => x.socket.id === id2);

            if (!user1 || !user2) {
                console.log("❌ One or both users not found, skipping match");

                // Put valid users back at the **front** of queue
                if (user1) this.queue.unshift(user1.socket.id);
                if (user2) this.queue.unshift(user2.socket.id);
                return;
            }

            console.log(`✅ Creating room for ${user1.name} and ${user2.name}`);
            this.roomManager.createRoom(user1, user2);
        }
    }

    initHandlers(socket: Socket) {
        // WebRTC signaling
        socket.on("offer", ({ sdp, roomId }: { sdp: string, roomId: string }) => {
            this.roomManager.onOffer(roomId, sdp, socket.id);
        })

        socket.on("answer", ({ sdp, roomId }: { sdp: string, roomId: string }) => {
            this.roomManager.onAnswer(roomId, sdp, socket.id);
        })

        socket.on("add-ice-candidate", ({ candidate, roomId, type }) => {
            this.roomManager.onIceCandidates(roomId, socket.id, candidate, type);
        });

        // Chat functionality
        socket.on("send-message", ({ message, roomId }: { message: string, roomId: string }) => {
            const user = this.users.find(u => u.socket.id === socket.id);
            if (user) {
                this.roomManager.onMessage(roomId, socket.id, message, user.name);
            }
        });

        socket.on("typing", ({ isTyping, roomId }: { isTyping: boolean, roomId: string }) => {
            this.roomManager.onTyping(roomId, socket.id, isTyping);
        });

        // Movie sharing
        socket.on("movie-share", ({ roomId, fileName, fileSize, fileType }: {
            roomId: string,
            fileName: string,
            fileSize: number,
            fileType: string
        }) => {
            console.log(`🎬 Movie share request: ${fileName} (${fileSize} bytes) in room ${roomId}`);
            this.roomManager.onMovieShare(roomId, socket.id, { fileName, fileSize, fileType });
        });

        socket.on("movie-share-response", ({ roomId, accepted }: { roomId: string, accepted: boolean }) => {
            console.log(`🎬 Movie share response in room ${roomId}: ${accepted ? 'accepted' : 'declined'}`);
            this.roomManager.onMovieShareResponse(roomId, socket.id, accepted);
        });

        // Movie streaming data - FIXED: This was missing proper handling
        socket.on("movie-data", ({ roomId, data, messageType, chunkIndex, totalChunks }: { 
            roomId: string, 
            data: any,
            messageType?: string,
            chunkIndex?: number,
            totalChunks?: number 
        }) => {
            console.log(`🎬 Movie data received for room ${roomId}:`, {
                messageType: messageType || 'unknown',
                chunkIndex,
                totalChunks,
                dataSize: typeof data === 'string' ? data.length : 'not-string'
            });
            
            this.roomManager.onMovieData(roomId, socket.id, {
                data,
                messageType,
                chunkIndex,
                totalChunks
            });
        });

        // Movie progress updates
        socket.on("movie-progress", ({ roomId, progress, type }: { 
            roomId: string, 
            progress: number, 
            type: 'sending' | 'receiving' 
        }) => {
            console.log(`🎬 Movie progress update for room ${roomId}: ${progress}% (${type})`);
            this.roomManager.onMovieProgress(roomId, socket.id, progress, type);
        });

        // Movie status updates
        socket.on("movie-status", ({ roomId, status }: { roomId: string, status: string }) => {
            console.log(`🎬 Movie status update for room ${roomId}: ${status}`);
            this.roomManager.onMovieStatus(roomId, socket.id, status);
        });

        // Movie playback control
        socket.on("movie-control", ({ roomId, control, value }: { 
            roomId: string, 
            control: string, 
            value?: any 
        }) => {
            console.log(`🎬 Movie control for room ${roomId}: ${control}`, value !== undefined ? value : '');
            this.roomManager.onMovieControl(roomId, socket.id, control, value);
        });

        // New chat request
        socket.on("new-chat", () => {
            console.log(`🔄 New chat request from ${socket.id}`);

            // Remove from current room (this will return them to queue automatically)
            const remainingUser = this.roomManager.removeUserFromRoom(socket.id);

            // Add current user back to queue if not already there
            if (!this.queue.includes(socket.id)) {
                this.queue.push(socket.id);
                socket.emit("lobby");

                // Try to find match
                setTimeout(() => {
                    this.clearQueue();
                }, 500);
            }
        });

        socket.on("join", ({ name }: { name: string }) => {
            const user = this.users.find(u => u.socket.id === socket.id);
            if (user) {
                user.name = name || "Anonymous";
                console.log(`👤 User updated name to: ${user.name}`);
            }
        });
    }
}