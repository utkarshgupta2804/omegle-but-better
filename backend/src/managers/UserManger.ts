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

        // Remove from room if in one
        this.roomManager.removeUserFromRoom(socketId);

        this.users = this.users.filter(x => x.socket.id !== socketId);
        this.queue = this.queue.filter(x => x !== socketId);
    }

    clearQueue() {
        console.log("inside clear queues")
        console.log(this.queue.length);
        if (this.queue.length < 2) {
            return;
        }

        const id1 = this.queue.pop();
        const id2 = this.queue.pop();
        console.log("id is " + id1 + " " + id2);
        const user1 = this.users.find(x => x.socket.id === id1);
        const user2 = this.users.find(x => x.socket.id === id2);

        if (!user1 || !user2) {
            return;
        }
        console.log("creating room");

        const room = this.roomManager.createRoom(user1, user2);
        this.clearQueue();
    }

    initHandlers(socket: Socket) {
        // WebRTC signaling
        socket.on("offer", ({sdp, roomId}: {sdp: string, roomId: string}) => {
            this.roomManager.onOffer(roomId, sdp, socket.id);
        })

        socket.on("answer",({sdp, roomId}: {sdp: string, roomId: string}) => {
            this.roomManager.onAnswer(roomId, sdp, socket.id);
        })

        socket.on("add-ice-candidate", ({candidate, roomId, type}) => {
            this.roomManager.onIceCandidates(roomId, socket.id, candidate, type);
        });

        // Chat functionality
        socket.on("send-message", ({message, roomId}: {message: string, roomId: string}) => {
            const user = this.users.find(u => u.socket.id === socket.id);
            if (user) {
                this.roomManager.onMessage(roomId, socket.id, message, user.name);
            }
        });

        socket.on("typing", ({isTyping, roomId}: {isTyping: boolean, roomId: string}) => {
            this.roomManager.onTyping(roomId, socket.id, isTyping);
        });

        // Movie sharing
        socket.on("movie-share", ({roomId, fileName, fileSize, fileType}: {
            roomId: string, 
            fileName: string, 
            fileSize: number, 
            fileType: string
        }) => {
            this.roomManager.onMovieShare(roomId, socket.id, {fileName, fileSize, fileType});
        });

        socket.on("movie-share-response", ({roomId, accepted}: {roomId: string, accepted: boolean}) => {
            this.roomManager.onMovieShareResponse(roomId, socket.id, accepted);
        });

        // New chat request
        socket.on("new-chat", () => {
            // Remove from current room
            this.roomManager.removeUserFromRoom(socket.id);
            
            // Add back to queue
            if (!this.queue.includes(socket.id)) {
                this.queue.push(socket.id);
                socket.emit("lobby");
                this.clearQueue();
            }
        });

        socket.on("join", ({name}: {name: string}) => {
            const user = this.users.find(u => u.socket.id === socket.id);
            if (user) {
                user.name = name || "Anonymous";
            }
        });
    }
}