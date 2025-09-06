import { useEffect, useRef, useState } from "react"
import { type Socket, io } from "socket.io-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Send, SkipForward, Mic, MicOff, Video, VideoOff, AlertCircle, Upload, X } from "lucide-react"
import { MovieStreamingService } from "./moviestreaming"

const URL = import.meta.env.VITE_API_URL;


interface Message {
    text: string;
    sender: "you" | "stranger";
    timestamp: Date;
    senderName?: string;
}

interface MovieShareRequest {
    fileName: string;
    fileSize: number;
    fileType: string;
}

export const Room = ({
    name,
    localAudioTrack,
    localVideoTrack,
}: {
    name: string
    localAudioTrack: MediaStreamTrack | null
    localVideoTrack: MediaStreamTrack | null
}) => {
    const [lobby, setLobby] = useState(true)
    const [socket, setSocket] = useState<null | Socket>(null)
    const [sendingPc, setSendingPc] = useState<null | RTCPeerConnection>(null)
    const [receivingPc, setReceivingPc] = useState<null | RTCPeerConnection>(null)
    const [remoteVideoTrack, setRemoteVideoTrack] = useState<MediaStreamTrack | null>(null)
    const [remoteAudioTrack, setRemoteAudioTrack] = useState<MediaStreamTrack | null>(null)
    const [remoteMediaStream, setRemoteMediaStream] = useState<MediaStream | null>(null)
    const remoteVideoRef = useRef<HTMLVideoElement>(null)
    const localVideoRef = useRef<HTMLVideoElement>(null)
    const messagesEndRef = useRef<HTMLDivElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const movieVideoRef = useRef<HTMLVideoElement>(null)

    const [currentRoomId, setCurrentRoomId] = useState<string | null>(null)
    const [message, setMessage] = useState("")
    const [messages, setMessages] = useState<Message[]>([])
    const [isAudioEnabled, setIsAudioEnabled] = useState(true)
    const [isVideoEnabled, setIsVideoEnabled] = useState(true)
    const [isTyping, setIsTyping] = useState(false)
    const [strangerTyping, setStrangerTyping] = useState(false)
    const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "disconnected">("connecting")

    // Movie sharing state
    const [movieStreamingService, setMovieStreamingService] = useState<MovieStreamingService | null>(null)
    const [movieShareRequest, setMovieShareRequest] = useState<MovieShareRequest | null>(null)
    const [isMovieSharing, setIsMovieSharing] = useState(false)
    const [movieProgress, setMovieProgress] = useState(0)
    const [movieStatus, setMovieStatus] = useState("")
    const [showMoviePlayer, setShowMoviePlayer] = useState(false)
    const [movieTransferType, setMovieTransferType] = useState<'sending' | 'receiving' | null>(null)

    // Typing timeout ref
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

    // Auto scroll to bottom when new messages arrive
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages])

    // Handle typing indicator
    const handleTyping = () => {
        if (!socket || !currentRoomId) return

        if (!isTyping) {
            setIsTyping(true)
            socket.emit("typing", { isTyping: true, roomId: currentRoomId })
        }

        // Clear existing timeout
        if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current)
        }

        // Set new timeout
        typingTimeoutRef.current = setTimeout(() => {
            setIsTyping(false)
            socket.emit("typing", { isTyping: false, roomId: currentRoomId })
        }, 1000)
    }

    // Initialize movie streaming service
    useEffect(() => {
        if (movieVideoRef.current && !movieStreamingService) {
            const service = new MovieStreamingService(
                movieVideoRef.current,
                (progress, type) => {
                    setMovieProgress(progress)
                    setMovieTransferType(type)
                },
                (status) => setMovieStatus(status),
                (error) => {
                    console.error('Movie streaming error:', error)
                    setMovieStatus(`Error: ${error}`)
                },
                () => {
                    setShowMoviePlayer(true)
                    setMovieStatus("Movie ready to play!")
                }
            )
            setMovieStreamingService(service)
        }
    }, [movieStreamingService])

    useEffect(() => {
        const socket = io(URL)

        // Emit join event with name
        socket.emit("join", { name })

        socket.on('send-offer', async ({ roomId }) => {
            console.log("sending offer")
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            })

            // Setup data channel for movie sharing
            if (movieStreamingService) {
                movieStreamingService.setupSendingDataChannel(pc)
            }

            setSendingPc(pc)
            if (localVideoTrack) {
                console.log("added video track")
                pc.addTrack(localVideoTrack)
            }
            if (localAudioTrack) {
                console.log("added audio track")
                pc.addTrack(localAudioTrack)
            }

            pc.onicecandidate = async (e) => {
                console.log("receiving ice candidate locally")
                if (e.candidate) {
                    socket.emit("add-ice-candidate", {
                        candidate: e.candidate,
                        type: "sender",
                        roomId
                    })
                }
            }

            pc.onnegotiationneeded = async () => {
                console.log("on negotiation needed, sending offer")
                const sdp = await pc.createOffer()
                await pc.setLocalDescription(sdp)
                socket.emit("offer", {
                    sdp,
                    roomId
                })
            }

            // Handle incoming data channels
            pc.ondatachannel = (event) => {
                console.log("📡 Received data channel")
                if (movieStreamingService) {
                    movieStreamingService.handleReceivingDataChannel(event.channel)
                }
            }
        })

        socket.on("offer", async ({ roomId, sdp: remoteSdp }) => {
            console.log("received offer")
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            })
            await pc.setRemoteDescription(remoteSdp)
            const sdp = await pc.createAnswer()
            await pc.setLocalDescription(sdp)

            const stream = new MediaStream()
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = stream
            }

            setRemoteMediaStream(stream)
            setReceivingPc(pc)

            pc.ontrack = (e) => {
                console.log("ontrack event received")
            }

            pc.onicecandidate = async (e) => {
                if (!e.candidate) {
                    return
                }
                console.log("ice candidate on receiving side")
                if (e.candidate) {
                    socket.emit("add-ice-candidate", {
                        candidate: e.candidate,
                        type: "receiver",
                        roomId
                    })
                }
            }

            // Handle incoming data channels
            pc.ondatachannel = (event) => {
                console.log("📡 Received data channel")
                if (movieStreamingService) {
                    movieStreamingService.handleReceivingDataChannel(event.channel)
                }
            }

            socket.emit("answer", {
                roomId,
                sdp: sdp
            })

            setTimeout(() => {
                const track1 = pc.getTransceivers()[0].receiver.track
                const track2 = pc.getTransceivers()[1].receiver.track
                console.log(track1)
                if (track1.kind === "video") {
                    setRemoteAudioTrack(track2)
                    setRemoteVideoTrack(track1)
                } else {
                    setRemoteAudioTrack(track1)
                    setRemoteVideoTrack(track2)
                }
                if (remoteVideoRef.current && remoteVideoRef.current.srcObject) {
                    // @ts-ignore
                    remoteVideoRef.current.srcObject.addTrack(track1)
                    // @ts-ignore
                    remoteVideoRef.current.srcObject.addTrack(track2)
                    // @ts-ignore
                    remoteVideoRef.current.play()
                }
            }, 5000)
        })

        socket.on("answer", ({ roomId, sdp: remoteSdp }) => {
            console.log("✅ Received answer for room:", roomId)
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            console.log("Room ID set to:", roomId)
            
            setSendingPc(pc => {
                pc?.setRemoteDescription(remoteSdp)
                return pc
            })
            console.log("loop closed")
        })

        socket.on("lobby", () => {
            setLobby(true)
            setConnectionStatus("connecting")
            setCurrentRoomId(null)
            setMessages([])
            setStrangerTyping(false)
            // Reset movie sharing state
            resetMovieState()
        })

        socket.on("add-ice-candidate", ({ candidate, type }) => {
            console.log("add ice candidate from remote")
            console.log({ candidate, type })
            if (type == "sender") {
                setReceivingPc(pc => {
                    if (!pc) {
                        console.error("receiving pc not found")
                    } else {
                        console.log(pc.ontrack)
                    }
                    pc?.addIceCandidate(candidate)
                    return pc
                })
            } else {
                setSendingPc(pc => {
                    if (!pc) {
                        console.error("sending pc not found")
                    }
                    pc?.addIceCandidate(candidate)
                    return pc
                })
            }
        })

        // Handle incoming messages
        socket.on("receive-message", ({ message, sender, senderName, timestamp }) => {
            const newMessage: Message = {
                text: message,
                sender: "stranger",
                timestamp: new Date(timestamp),
                senderName
            }
            setMessages(prev => [...prev, newMessage])
        })

        // Handle message sent confirmation
        socket.on("message-sent", ({ message, timestamp }) => {
            console.log("Message sent confirmation received")
        })

        // Handle typing indicators
        socket.on("user-typing", ({ isTyping }) => {
            setStrangerTyping(isTyping)
        })

        // Handle user disconnection
        socket.on("user-disconnected", ({ message }) => {
            setConnectionStatus("disconnected")
            const disconnectMessage: Message = {
                text: message,
                sender: "stranger",
                timestamp: new Date(),
            }
            setMessages(prev => [...prev, disconnectMessage])
            
            // Reset movie state
            resetMovieState()
            
            // Auto redirect to lobby after 3 seconds
            setTimeout(() => {
                handleNewChat()
            }, 3000)
        })

        // Handle movie sharing requests
        socket.on("movie-share-request", ({ fileName, fileSize, fileType }) => {
            setMovieShareRequest({ fileName, fileSize, fileType })
        })

        socket.on("movie-share-response", ({ accepted }) => {
            if (accepted) {
                setIsMovieSharing(true)
                setMovieStatus("Starting movie transfer...")
                // The movie streaming service will handle the actual transfer
            } else {
                setMovieStatus("Movie sharing declined")
                setTimeout(() => setMovieStatus(""), 3000)
            }
        })

        setSocket(socket)

        return () => {
            socket.disconnect()
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current)
            }
            movieStreamingService?.cleanup()
        }
    }, [name, movieStreamingService])

    // Setup local video
    useEffect(() => {
        if (localVideoRef.current) {
            if (localVideoTrack) {
                localVideoRef.current.srcObject = new MediaStream([localVideoTrack])
                localVideoRef.current.play()
            }
        }
    }, [localVideoTrack])

    // Handle audio/video toggle
    useEffect(() => {
        if (localAudioTrack) {
            localAudioTrack.enabled = isAudioEnabled
        }
    }, [isAudioEnabled, localAudioTrack])

    useEffect(() => {
        if (localVideoTrack) {
            localVideoTrack.enabled = isVideoEnabled
        }
    }, [isVideoEnabled, localVideoTrack])

    const resetMovieState = () => {
        setIsMovieSharing(false)
        setMovieProgress(0)
        setMovieStatus("")
        setShowMoviePlayer(false)
        setMovieShareRequest(null)
        setMovieTransferType(null)
        movieStreamingService?.cleanup()
    }

    const handleSendMessage = () => {
        if (message.trim() && socket && !lobby) {
            const newMessage: Message = {
                text: message.trim(),
                sender: "you",
                timestamp: new Date(),
            }

            setMessages(prev => [...prev, newMessage])

            // Send message through socket
            socket.emit("send-message", {
                message: message.trim(),
                roomId: currentRoomId
            })

            setMessage("")
            
            // Stop typing indicator
            if (isTyping) {
                setIsTyping(false)
                socket.emit("typing", { isTyping: false, roomId: currentRoomId })
            }
        }
    }

    const handleMovieUpload = () => {
        fileInputRef.current?.click()
    }

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file || !socket || !currentRoomId) return

        // Check file type
        if (!file.type.startsWith('video/')) {
            setMovieStatus("Please select a video file")
            setTimeout(() => setMovieStatus(""), 3000)
            return
        }

        // Send movie share request
        socket.emit("movie-share", {
            roomId: currentRoomId,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type
        })

        setIsMovieSharing(true)
        setMovieTransferType('sending')
        
        // Start sharing after a brief delay
        setTimeout(() => {
            movieStreamingService?.shareMovie(file)
        }, 1000)
    }

    const handleMovieShareResponse = (accepted: boolean) => {
        if (!socket || !currentRoomId) return

        socket.emit("movie-share-response", {
            roomId: currentRoomId,
            accepted
        })

        if (accepted) {
            setIsMovieSharing(true)
            setMovieTransferType('receiving')
            setMovieStatus("Preparing to receive movie...")
        }
        
        setMovieShareRequest(null)
    }

    const handleNewChat = () => {
        // Clean up existing connections
        if (sendingPc) {
            sendingPc.close()
            setSendingPc(null)
        }
        if (receivingPc) {
            receivingPc.close()
            setReceivingPc(null)
        }

        // Clear remote streams
        setRemoteVideoTrack(null)
        setRemoteAudioTrack(null)
        setRemoteMediaStream(null)

        // Clear messages and state
        setMessages([])
        setCurrentRoomId(null)
        setStrangerTyping(false)
        setConnectionStatus("connecting")

        // Reset movie state
        resetMovieState()

        // Reset to lobby
        setLobby(true)

        // Emit new chat request
        if (socket) {
            socket.emit("new-chat")
        }
    }

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setMessage(e.target.value)
        handleTyping()
    }

    const getStatusColor = () => {
        switch (connectionStatus) {
            case "connected": return "text-green-500"
            case "disconnected": return "text-red-500"
            default: return "text-yellow-500"
        }
    }

    const getStatusText = () => {
        switch (connectionStatus) {
            case "connected": return `Connected${name ? ` as ${name}` : ""}`
            case "disconnected": return "Disconnected"
            default: return "Connecting..."
        }
    }

    const formatFileSize = (bytes: number) => {
        const units = ['B', 'KB', 'MB', 'GB']
        let size = bytes
        let unitIndex = 0
        
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024
            unitIndex++
        }
        
        return `${size.toFixed(1)} ${units[unitIndex]}`
    }

    return (
        <div className="min-h-screen bg-gray-100 flex flex-col">
            {/* Header */}
            <div className="bg-blue-600 text-white p-4">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div>
                        <h1 className="text-xl font-bold">Omegle</h1>
                        <p className={`text-sm ${getStatusColor()}`}>
                            {lobby ? "Looking for someone you can chat with..." : getStatusText()}
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            className="bg-white text-blue-600 hover:bg-gray-100"
                            onClick={handleMovieUpload}
                            disabled={lobby || isMovieSharing}
                        >
                            <Upload className="w-4 h-4 mr-2" />
                            Share Movie
                        </Button>
                        <Button
                            variant="outline"
                            className="bg-white text-blue-600 hover:bg-gray-100"
                            onClick={handleNewChat}
                            disabled={lobby && connectionStatus === "connecting"}
                        >
                            <SkipForward className="w-4 h-4 mr-2" />
                            New Chat
                        </Button>
                    </div>
                </div>
            </div>

            {/* Movie Share Request Modal */}
            {movieShareRequest && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
                        <h3 className="text-lg font-semibold mb-4">Movie Share Request</h3>
                        <p className="text-gray-600 mb-4">
                            Your chat partner wants to share a movie with you:
                        </p>
                        <div className="bg-gray-50 rounded-lg p-4 mb-4">
                            <p className="font-medium">{movieShareRequest.fileName}</p>
                            <p className="text-sm text-gray-600">
                                {formatFileSize(movieShareRequest.fileSize)} • {movieShareRequest.fileType}
                            </p>
                        </div>
                        <div className="flex gap-2 justify-end">
                            <Button
                                variant="outline"
                                onClick={() => handleMovieShareResponse(false)}
                            >
                                Decline
                            </Button>
                            <Button
                                onClick={() => handleMovieShareResponse(true)}
                                className="bg-blue-600 hover:bg-blue-700"
                            >
                                Accept
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Movie Progress Overlay */}
            {isMovieSharing && movieProgress < 100 && (
                <div className="bg-blue-50 border-b border-blue-200 p-4">
                    <div className="max-w-7xl mx-auto">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-blue-900">
                                {movieTransferType === 'sending' ? 'Uploading Movie' : 'Receiving Movie'}
                            </span>
                            <span className="text-sm text-blue-700">
                                {movieProgress.toFixed(1)}%
                            </span>
                        </div>
                        <Progress value={movieProgress} className="h-2" />
                        {movieStatus && (
                            <p className="text-sm text-blue-700 mt-1">{movieStatus}</p>
                        )}
                    </div>
                </div>
            )}

            {/* Main Chat Area */}
            <div className="flex-1 flex max-w-7xl mx-auto w-full">
                {/* Video Section */}
                <div className="flex-1 p-4">
                    <div className={`grid gap-4 h-full ${showMoviePlayer ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2'}`}>
                        {/* Movie Player (if active) */}
                        {showMoviePlayer && (
                            <div className="bg-black rounded-lg overflow-hidden relative">
                                <video
                                    ref={movieVideoRef}
                                    controls
                                    className="w-full h-full object-contain"
                                />
                                <div className="absolute top-2 right-2">
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => setShowMoviePlayer(false)}
                                    >
                                        <X className="w-4 h-4" />
                                    </Button>
                                </div>
                                <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                                    Shared Movie
                                </div>
                            </div>
                        )}

                        {/* Stranger's Video */}
                        <div className="bg-black rounded-lg overflow-hidden relative aspect-video lg:aspect-auto">
                            {lobby ? (
                                <div className="flex items-center justify-center h-full text-white">
                                    <div className="text-center">
                                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4"></div>
                                        <p>Connecting...</p>
                                    </div>
                                </div>
                            ) : connectionStatus === "disconnected" ? (
                                <div className="flex items-center justify-center h-full text-white">
                                    <div className="text-center">
                                        <AlertCircle className="h-8 w-8 mx-auto mb-4 text-red-400" />
                                        <p>User disconnected</p>
                                        <p className="text-sm text-gray-400 mt-2">Finding new partner...</p>
                                    </div>
                                </div>
                            ) : (
                                <video
                                    autoPlay
                                    playsInline
                                    ref={remoteVideoRef}
                                    className="w-full h-full object-cover"
                                />
                            )}
                            <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                                Stranger
                            </div>
                        </div>

                        {/* Your Video */}
                        <div className="bg-black rounded-lg overflow-hidden relative aspect-video lg:aspect-auto">
                            <video
                                autoPlay
                                muted
                                playsInline
                                ref={localVideoRef}
                                className="w-full h-full object-cover"
                            />
                            <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                                You
                            </div>

                            {/* Video Controls */}
                            <div className="absolute bottom-2 right-2 flex gap-2">
                                <Button
                                    size="sm"
                                    variant={isAudioEnabled ? "default" : "destructive"}
                                    onClick={() => setIsAudioEnabled(!isAudioEnabled)}
                                >
                                    {isAudioEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                                </Button>
                                <Button
                                    size="sm"
                                    variant={isVideoEnabled ? "default" : "destructive"}
                                    onClick={() => setIsVideoEnabled(!isVideoEnabled)}
                                >
                                    {isVideoEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Chat Section */}
                <div className="w-80 bg-white border-l border-gray-200 flex flex-col">
                    {/* Chat Header */}
                    <div className="p-4 border-b border-gray-200">
                        <h3 className="font-semibold text-gray-800">Chat</h3>
                        <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${
                                connectionStatus === "connected" ? "bg-green-500" : 
                                connectionStatus === "disconnected" ? "bg-red-500" : "bg-yellow-500"
                            }`} />
                            <p className="text-sm text-gray-600">
                                {lobby ? "Waiting for connection..." : 
                                 connectionStatus === "disconnected" ? "Disconnected" : "Connected"}
                            </p>
                        </div>
                        {movieStatus && (
                            <p className="text-xs text-blue-600 mt-1">{movieStatus}</p>
                        )}
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {messages.length === 0 ? (
                            <div className="text-center text-gray-500 text-sm">
                                {lobby ? "Messages will appear here once connected" : "Start the conversation!"}
                            </div>
                        ) : (
                            messages.map((msg, index) => (
                                <div key={index} className={`${msg.sender === "you" ? "text-right" : "text-left"}`}>
                                    <div
                                        className={`inline-block max-w-xs px-3 py-2 rounded-lg text-sm ${
                                            msg.sender === "you"
                                                ? "bg-blue-600 text-white"
                                                : "bg-gray-200 text-gray-800"
                                        }`}
                                    >
                                        {msg.text}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-1">
                                        {msg.sender === "you" ? "You" : (msg.senderName || "Stranger")} • {msg.timestamp.toLocaleTimeString()}
                                    </div>
                                </div>
                            ))
                        )}
                        
                        {/* Typing indicator */}
                        {strangerTyping && (
                            <div className="text-left">
                                <div className="inline-block bg-gray-200 text-gray-800 px-3 py-2 rounded-lg text-sm">
                                    <div className="flex items-center gap-1">
                                        <div className="flex gap-1">
                                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                                        </div>
                                    </div>
                                </div>
                                <div className="text-xs text-gray-500 mt-1">
                                    Stranger is typing...
                                </div>
                            </div>
                        )}
                        
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Message Input */}
                    <div className="p-4 border-t border-gray-200">
                        <div className="flex gap-2">
                            <Input
                                placeholder={lobby ? "Wait for connection..." : "Type a message..."}
                                value={message}
                                onChange={handleInputChange}
                                onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
                                disabled={lobby || connectionStatus === "disconnected"}
                                className="flex-1"
                                maxLength={500}
                            />
                            <Button
                                onClick={handleSendMessage}
                                disabled={lobby || !message.trim() || connectionStatus === "disconnected"}
                                size="sm"
                            >
                                <Send className="w-4 h-4" />
                            </Button>
                        </div>
                        {message.length > 450 && (
                            <div className="text-xs text-gray-500 mt-1">
                                {500 - message.length} characters remaining
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Hidden file input */}
            <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleFileSelect}
                className="hidden"
            />
        </div>
    )
}