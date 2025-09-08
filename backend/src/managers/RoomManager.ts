import { User } from "./UserManger";

let GLOBAL_ROOM_ID = 1;

interface Room {
    user1: User,
    user2: User,
}

export class RoomManager {
    private rooms: Map<string, Room>
    constructor() {
        this.rooms = new Map<string, Room>()
    }

    createRoom(user1: User, user2: User) {
        const roomId = this.generate().toString();
        this.rooms.set(roomId.toString(), {
            user1,
            user2,
        })

        console.log(`🏠 Created room ${roomId} for users: ${user1.name} (${user1.socket.id}) and ${user2.name} (${user2.socket.id})`);

        user1.socket.emit("send-offer", {
            roomId
        })

        user2.socket.emit("send-offer", {
            roomId
        })
    }

    onOffer(roomId: string, sdp: string, senderSocketid: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for offer`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2 : room.user1;
        console.log(`📤 Sending offer from ${senderSocketid} to ${receivingUser.socket.id} in room ${roomId}`);
        
        receivingUser?.socket.emit("offer", {
            sdp,
            roomId
        })
    }

    onAnswer(roomId: string, sdp: string, senderSocketid: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for answer`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2 : room.user1;
        console.log(`📤 Sending answer from ${senderSocketid} to ${receivingUser.socket.id} in room ${roomId}`);

        receivingUser?.socket.emit("answer", {
            sdp,
            roomId
        });
    }

    onIceCandidates(roomId: string, senderSocketid: string, candidate: any, type: "sender" | "receiver") {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for ICE candidate`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2 : room.user1;
        receivingUser.socket.emit("add-ice-candidate", { candidate, type });
    }

    // Movie sharing methods
    onMovieShare(roomId: string, senderSocketId: string, movieData: { fileName: string, fileSize: number, fileType: string }) {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for movie share`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        console.log(`🎬 Movie share request from ${senderSocketId} to ${receivingUser.socket.id}: ${movieData.fileName}`);
        
        receivingUser.socket.emit("movie-share-request", {
            roomId,
            ...movieData
        });
    }

    onMovieShareResponse(roomId: string, senderSocketId: string, accepted: boolean) {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for movie share response`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        console.log(`🎬 Movie share ${accepted ? 'accepted' : 'declined'} by ${senderSocketId}`);
        
        receivingUser.socket.emit("movie-share-response", {
            roomId,
            accepted
        });
    }

    // Handle movie streaming data - FIXED: Enhanced with better logging
    onMovieData(roomId: string, senderSocketId: string, movieData: any) {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for movie data`);
            return;
        }
        
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        
        // Enhanced logging for debugging
        console.log(`🎬 Forwarding movie data in room ${roomId}:`, {
            from: senderSocketId,
            to: receivingUser.socket.id,
            messageType: movieData.messageType || 'unknown',
            chunkIndex: movieData.chunkIndex,
            totalChunks: movieData.totalChunks,
            dataSize: typeof movieData.data === 'string' ? movieData.data.length : 'not-string'
        });
        
        receivingUser.socket.emit("movie-data", {
            roomId,
            ...movieData
        });
    }

    // NEW: Handle movie progress updates
    onMovieProgress(roomId: string, senderSocketId: string, progress: number, type: 'sending' | 'receiving') {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for movie progress`);
            return;
        }
        
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        console.log(`🎬 Forwarding movie progress in room ${roomId}: ${progress}% (${type})`);
        
        receivingUser.socket.emit("movie-progress", {
            roomId,
            progress,
            type
        });
    }

    // NEW: Handle movie status updates
    onMovieStatus(roomId: string, senderSocketId: string, status: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for movie status`);
            return;
        }
        
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        console.log(`🎬 Forwarding movie status in room ${roomId}: ${status}`);
        
        receivingUser.socket.emit("movie-status", {
            roomId,
            status
        });
    }

    // NEW: Handle movie playback control
    onMovieControl(roomId: string, senderSocketId: string, control: string, value?: any) {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for movie control`);
            return;
        }
        
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        console.log(`🎬 Forwarding movie control in room ${roomId}: ${control}`, value !== undefined ? value : '');
        
        receivingUser.socket.emit("movie-control", {
            roomId,
            control,
            value
        });
    }

    // Handle text messages
    onMessage(roomId: string, senderSocketId: string, message: string, senderName: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            console.log(`❌ Room ${roomId} not found for message`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        const sendingUser = room.user1.socket.id === senderSocketId ? room.user1 : room.user2;
        
        console.log(`💬 Message in room ${roomId} from ${senderName}: ${message.substring(0, 50)}...`);
        
        // Send to receiver
        receivingUser.socket.emit("receive-message", {
            message,
            sender: "stranger",
            senderName,
            timestamp: new Date().toISOString()
        });

        // Confirm to sender
        sendingUser.socket.emit("message-sent", {
            message,
            timestamp: new Date().toISOString()
        });
    }

    // Handle typing indicators
    onTyping(roomId: string, senderSocketId: string, isTyping: boolean) {
        const room = this.rooms.get(roomId);
        if (!room) {
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        receivingUser.socket.emit("user-typing", { isTyping });
    }

    // Handle user disconnection - now returns the other user for re-queuing
    removeUserFromRoom(socketId: string): User | null {
        for (const [roomId, room] of this.rooms.entries()) {
            if (room.user1.socket.id === socketId || room.user2.socket.id === socketId) {
                const remainingUser = room.user1.socket.id === socketId ? room.user2 : room.user1;
                const disconnectedUser = room.user1.socket.id === socketId ? room.user1 : room.user2;
                
                console.log(`🚪 User ${disconnectedUser.name} (${socketId}) disconnected from room ${roomId}`);
                console.log(`👤 Returning remaining user ${remainingUser.name} (${remainingUser.socket.id}) to queue`);
                
                // Notify remaining user about disconnection
                remainingUser.socket.emit("user-disconnected", {
                    message: "Your chat partner has disconnected. Finding you a new partner..."
                });

                // Remove room
                this.rooms.delete(roomId);
                
                // Return the remaining user so they can be re-queued
                return remainingUser;
            }
        }
        return null;
    }

    // Get room by user socket ID (utility method)
    getRoomBySocketId(socketId: string): { roomId: string, room: Room } | null {
        for (const [roomId, room] of this.rooms.entries()) {
            if (room.user1.socket.id === socketId || room.user2.socket.id === socketId) {
                return { roomId, room };
            }
        }
        return null;
    }

    // Get all active rooms (utility method)
    getActiveRooms(): number {
        return this.rooms.size;
    }

    generate() {
        return GLOBAL_ROOM_ID++;
    }
}