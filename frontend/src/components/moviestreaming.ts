/**
 * Fixed Progressive Movie Streaming and Synchronization Service
 * Enhanced with better debugging and error handling
 */

// Configuration constants
const CHUNK_SIZE = 16 * 1024; // Reduced to 16KB for better compatibility
const BUFFER_THRESHOLD = 0.10; // Start playback at 10% buffer
const SYNC_INTERVAL = 3000; // Sync every 3 seconds
const SEEK_TOLERANCE = 1.0; // Allow 1s drift before correction

export interface MovieMetadata {
    fileName: string;
    fileSize: number;
    fileType: string;
    duration?: number;
}

export interface ChunkMessage {
    type: 'metadata' | 'chunk' | 'sync' | 'control';
    chunkIndex?: number;
    totalChunks?: number;
    data?: string; // Base64 encoded for JSON transport
    metadata?: MovieMetadata;
    syncData?: {
        currentTime: number;
        paused: boolean;
        timestamp: number;
    };
    control?: string; // 'start', 'pause', 'seek', etc.
}

export class MovieStreamingService {
    private dataChannel: RTCDataChannel | null = null;
    
    // Sending state
    private currentFile: File | null = null;
    private fileChunks: ArrayBuffer[] = [];
    private sendingProgress = 0;
    private totalChunks = 0;
    private isSending = false;
    
    // Receiving state
    private receivedChunks: Map<number, ArrayBuffer> = new Map();
    private expectedTotalChunks = 0;
    private receivingProgress = 0;
    private movieMetadata: MovieMetadata | null = null;
    
    // Media handling
    private mediaSource: MediaSource | null = null;
    private sourceBuffer: SourceBuffer | null = null;
    private videoElement: HTMLVideoElement | null = null;
    private isBuffering = false;
    private playbackStarted = false;
    private bufferedChunkIndex = 0;
    
    // Sync state
    private isMaster = false;
    private syncInterval: NodeJS.Timeout | null = null;
    
    // Event callbacks
    private onProgressUpdate?: (progress: number, type: 'sending' | 'receiving') => void;
    private onStatusUpdate?: (status: string) => void;
    private onError?: (error: string) => void;
    private onPlaybackReady?: () => void;

    constructor(
        videoElement: HTMLVideoElement,
        onProgressUpdate?: (progress: number, type: 'sending' | 'receiving') => void,
        onStatusUpdate?: (status: string) => void,
        onError?: (error: string) => void,
        onPlaybackReady?: () => void
    ) {
        this.videoElement = videoElement;
        this.onProgressUpdate = onProgressUpdate;
        this.onStatusUpdate = onStatusUpdate;
        this.onError = onError;
        this.onPlaybackReady = onPlaybackReady;
        
        console.log('🎬 MovieStreamingService initialized');
    }

    /**
     * Setup data channel for movie sharing
     */
    setupDataChannel(peerConnection: RTCPeerConnection, isInitiator: boolean = false): RTCDataChannel | null {
        console.log('📡 Setting up data channel, isInitiator:', isInitiator);
        
        if (isInitiator) {
            // Create data channel
            this.dataChannel = peerConnection.createDataChannel('movieSharing', {
                ordered: true,
                maxRetransmits: 0,
                maxPacketLifeTime: 3000
            });
            this.isMaster = true;
            this.setupDataChannelHandlers(this.dataChannel);
            return this.dataChannel;
        } else {
            // Listen for data channel
            peerConnection.ondatachannel = (event) => {
                console.log('📡 Received data channel');
                this.dataChannel = event.channel;
                this.isMaster = false;
                this.setupDataChannelHandlers(this.dataChannel);
            };
            return null;
        }
    }

    /**
     * Setup data channel event handlers
     */
    private setupDataChannelHandlers(channel: RTCDataChannel) {
        console.log('🔧 Setting up data channel handlers');
        
        channel.onopen = () => {
            console.log('✅ Data channel opened, readyState:', channel.readyState);
            this.onStatusUpdate?.('Data channel connected');
        };

        channel.onclose = () => {
            console.log('❌ Data channel closed');
            this.onStatusUpdate?.('Data channel disconnected');
        };

        channel.onerror = (error) => {
            console.error('❌ Data channel error:', error);
            this.onError?.('Data channel error occurred');
        };

        channel.onmessage = (event) => {
            console.log('📨 Data channel message received, size:', event.data.length);
            this.handleIncomingMessage(event.data);
        };
    }

    /**
     * Start sharing a movie file
     */
    async shareMovie(file: File): Promise<void> {
        console.log('🎬 Starting movie share:', file.name, file.size, 'bytes');
        
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            const error = `Data channel not ready. State: ${this.dataChannel?.readyState || 'null'}`;
            console.error('❌', error);
            this.onError?.(error);
            return;
        }

        if (this.isSending) {
            console.warn('⚠️ Already sending a movie');
            return;
        }

        this.currentFile = file;
        this.isSending = true;
        this.onStatusUpdate?.('Movie uploading… please wait.');
        
        try {
            // Split file into chunks
            await this.splitFileIntoChunks(file);
            console.log('📁 File split into', this.totalChunks, 'chunks');
            
            // Send metadata first
            const metadata: MovieMetadata = {
                fileName: file.name,
                fileSize: file.size,
                fileType: file.type
            };

            const metadataMessage: ChunkMessage = {
                type: 'metadata',
                totalChunks: this.totalChunks,
                metadata
            };

            this.sendMessage(metadataMessage);
            console.log('📤 Sent metadata');
            
            // Start sending chunks after small delay
            setTimeout(() => this.sendNextChunk(), 100);
            
        } catch (error) {
            console.error('❌ Failed to process movie:', error);
            this.onError?.(`Failed to process movie: ${error}`);
            this.isSending = false;
        }
    }

    /**
     * Split file into chunks
     */
    private async splitFileIntoChunks(file: File): Promise<void> {
        this.fileChunks = [];
        this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        this.sendingProgress = 0;
        
        console.log('📁 Starting file chunking...');
        
        for (let i = 0; i < this.totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const arrayBuffer = await chunk.arrayBuffer();
            this.fileChunks.push(arrayBuffer);
            
            // Log progress every 100 chunks
            if (i % 100 === 0) {
                console.log(`📁 Chunked ${i}/${this.totalChunks}`);
            }
        }
        
        console.log(`✅ File chunked complete: ${this.totalChunks} chunks`);
    }

    /**
     * Send next chunk
     */
    private sendNextChunk() {
        if (!this.isSending || this.sendingProgress >= this.totalChunks) {
            console.log('✅ File transfer completed');
            this.onStatusUpdate?.('Movie transfer completed');
            this.isSending = false;
            this.startSyncPlayback();
            return;
        }

        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            console.error('❌ Data channel not ready for sending chunk', this.sendingProgress);
            this.onError?.('Connection lost during transfer');
            this.isSending = false;
            return;
        }

        const chunkData = this.fileChunks[this.sendingProgress];
        const base64Data = this.arrayBufferToBase64(chunkData);
        
        const chunkMessage: ChunkMessage = {
            type: 'chunk',
            chunkIndex: this.sendingProgress,
            totalChunks: this.totalChunks,
            data: base64Data
        };

        try {
            this.sendMessage(chunkMessage);
            console.log(`📤 Sent chunk ${this.sendingProgress}/${this.totalChunks} (${chunkData.byteLength} bytes)`);
            
            this.sendingProgress++;
            const progress = (this.sendingProgress / this.totalChunks) * 100;
            this.onProgressUpdate?.(progress, 'sending');

            // Continue sending with small delay
            setTimeout(() => this.sendNextChunk(), 10);
            
        } catch (error) {
            console.error(`❌ Failed to send chunk ${this.sendingProgress}:`, error);
            this.onError?.(`Transfer failed at ${this.sendingProgress}/${this.totalChunks}`);
            this.isSending = false;
        }
    }

    /**
     * Send message through data channel
     */
    private sendMessage(message: ChunkMessage) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('Data channel not ready');
        }
        
        const jsonMessage = JSON.stringify(message);
        this.dataChannel.send(jsonMessage);
    }

    /**
     * Handle incoming messages
     */
    private handleIncomingMessage(data: string) {
        try {
            const message: ChunkMessage = JSON.parse(data);
            console.log(`📨 Received ${message.type} message`);
            
            switch (message.type) {
                case 'metadata':
                    this.handleMetadata(message);
                    break;
                case 'chunk':
                    this.handleChunk(message);
                    break;
                case 'sync':
                    this.handleSync(message);
                    break;
                case 'control':
                    this.handleControl(message);
                    break;
                default:
                    console.warn('⚠️ Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('❌ Failed to parse message:', error);
        }
    }

    /**
     * Handle metadata message
     */
    private handleMetadata(message: ChunkMessage) {
        if (!message.metadata || !message.totalChunks) {
            console.error('❌ Invalid metadata message');
            return;
        }

        console.log('📋 Received metadata:', message.metadata);
        this.movieMetadata = message.metadata;
        this.expectedTotalChunks = message.totalChunks;
        this.receivedChunks.clear();
        this.receivingProgress = 0;
        this.playbackStarted = false;
        this.bufferedChunkIndex = 0;
        
        this.onStatusUpdate?.(`Receiving "${message.metadata.fileName}" (${this.formatFileSize(message.metadata.fileSize)})`);
        this.setupMediaSource();
    }

    /**
     * Handle chunk message
     */
    private handleChunk(message: ChunkMessage) {
        if (message.chunkIndex === undefined || !message.data) {
            console.error('❌ Invalid chunk message');
            return;
        }

        const chunkData = this.base64ToArrayBuffer(message.data);
        this.receivedChunks.set(message.chunkIndex, chunkData);
        this.receivingProgress++;
        
        console.log(`📥 Received chunk ${message.chunkIndex}/${this.expectedTotalChunks} (${chunkData.byteLength} bytes)`);
        
        const progress = (this.receivingProgress / this.expectedTotalChunks) * 100;
        this.onProgressUpdate?.(progress, 'receiving');
        
        // Check if we can start playback
        this.checkPlaybackReadiness();
        
        // Try to buffer more chunks
        this.bufferChunks();
    }

    /**
     * Setup MediaSource
     */
    private setupMediaSource() {
        if (!this.videoElement || !this.movieMetadata) {
            console.error('❌ Missing video element or metadata for MediaSource setup');
            return;
        }

        console.log('📺 Setting up MediaSource for', this.movieMetadata.fileType);
        
        // Clean up existing MediaSource
        if (this.mediaSource) {
            this.cleanupMediaSource();
        }

        this.mediaSource = new MediaSource();
        const objectURL = URL.createObjectURL(this.mediaSource);
        this.videoElement.src = objectURL;
        
        this.mediaSource.addEventListener('sourceopen', () => {
            console.log('📺 MediaSource opened');
            
            if (!this.mediaSource || !this.movieMetadata) return;
            
            try {
                // Use a more compatible MIME type
                let mimeType = this.movieMetadata.fileType;
                if (!MediaSource.isTypeSupported(mimeType)) {
                    // Try common fallbacks
                    const fallbacks = [
                        'video/mp4; codecs="avc1.42E01E"',
                        'video/webm; codecs="vp8"',
                        'video/mp4'
                    ];
                    
                    for (const fallback of fallbacks) {
                        if (MediaSource.isTypeSupported(fallback)) {
                            mimeType = fallback;
                            console.log('📺 Using fallback MIME type:', fallback);
                            break;
                        }
                    }
                }
                
                this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
                this.sourceBuffer.addEventListener('updateend', () => {
                    this.isBuffering = false;
                    console.log('📺 Source buffer update completed');
                    this.bufferChunks(); // Try to buffer more
                });
                
                this.sourceBuffer.addEventListener('error', (e) => {
                    console.error('📺 Source buffer error:', e);
                    this.onError?.('Video decoding error');
                });
                
                console.log('✅ SourceBuffer created for', mimeType);
                
            } catch (error) {
                console.error('❌ Failed to create SourceBuffer:', error);
                this.onError?.(`Unsupported video format: ${this.movieMetadata.fileType}`);
            }
        });

        this.mediaSource.addEventListener('sourceended', () => {
            console.log('📺 MediaSource ended');
        });

        this.mediaSource.addEventListener('error', (e) => {
            console.error('📺 MediaSource error:', e);
            this.onError?.('Media source error');
        });
    }

    /**
     * Check if ready for playback
     */
    private checkPlaybackReadiness() {
        if (this.playbackStarted || !this.expectedTotalChunks) return;
        
        const bufferRatio = this.receivingProgress / this.expectedTotalChunks;
        console.log(`📊 Buffer ratio: ${(bufferRatio * 100).toFixed(1)}%`);
        
        if (bufferRatio >= BUFFER_THRESHOLD) {
            console.log('✅ Starting playback at', (bufferRatio * 100).toFixed(1), '% buffer');
            this.playbackStarted = true;
            this.onStatusUpdate?.('Starting playback...');
            this.onPlaybackReady?.();
            
            if (!this.isMaster) {
                this.startSyncPlayback();
            }
        }
    }

    /**
     * Buffer chunks into MediaSource
     */
    private bufferChunks() {
        if (!this.sourceBuffer || this.isBuffering) {
            return;
        }

        // Find sequential chunks to buffer
        const chunksToAppend: ArrayBuffer[] = [];
        let currentIndex = this.bufferedChunkIndex;
        
        // Collect up to 10 sequential chunks
        while (chunksToAppend.length < 10 && this.receivedChunks.has(currentIndex)) {
            chunksToAppend.push(this.receivedChunks.get(currentIndex)!);
            currentIndex++;
        }
        
        if (chunksToAppend.length === 0) {
            return;
        }
        
        // Combine chunks
        const totalSize = chunksToAppend.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        
        for (const chunk of chunksToAppend) {
            combined.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
        }
        
        try {
            this.isBuffering = true;
            this.sourceBuffer.appendBuffer(combined);
            this.bufferedChunkIndex = currentIndex;
            
            console.log(`📺 Buffered ${chunksToAppend.length} chunks (${this.formatFileSize(totalSize)}), next index: ${currentIndex}`);
            
        } catch (error) {
            this.isBuffering = false;
            console.error('❌ Buffer append error:', error);
            this.onError?.('Video buffering error');
        }
    }

    /**
     * Start synchronized playback
     */
    private startSyncPlayback() {
        console.log('🎵 Starting sync playback, isMaster:', this.isMaster);
        
        if (!this.videoElement) return;
        
        if (this.isMaster) {
            // Master starts playback and broadcasts sync
            setTimeout(() => {
                if (this.videoElement) {
                    this.videoElement.play().then(() => {
                        console.log('▶️ Master started playback');
                        this.startSyncBroadcast();
                    }).catch(error => {
                        console.error('❌ Failed to start playback:', error);
                    });
                }
            }, 1000);
        }
        // Slave waits for sync commands
    }

    /**
     * Start sync broadcasting (master only)
     */
    private startSyncBroadcast() {
        if (!this.isMaster || this.syncInterval) return;
        
        console.log('📡 Starting sync broadcast');
        
        this.syncInterval = setInterval(() => {
            if (!this.videoElement || !this.dataChannel || this.dataChannel.readyState !== 'open') {
                return;
            }
            
            const syncMessage: ChunkMessage = {
                type: 'sync',
                syncData: {
                    currentTime: this.videoElement.currentTime,
                    paused: this.videoElement.paused,
                    timestamp: Date.now()
                }
            };
            
            try {
                this.sendMessage(syncMessage);
            } catch (error) {
                console.error('❌ Failed to send sync:', error);
            }
        }, SYNC_INTERVAL);
    }

    /**
     * Handle sync message
     */
    private handleSync(message: ChunkMessage) {
        if (this.isMaster || !message.syncData || !this.videoElement) return;
        
        const { currentTime, paused, timestamp } = message.syncData;
        const now = Date.now();
        const networkDelay = (now - timestamp) / 1000;
        const adjustedTime = currentTime + networkDelay;
        
        const timeDiff = Math.abs(this.videoElement.currentTime - adjustedTime);
        
        if (timeDiff > SEEK_TOLERANCE) {
            console.log(`🔄 Syncing video: ${timeDiff.toFixed(2)}s drift`);
            this.videoElement.currentTime = adjustedTime;
        }
        
        if (paused && !this.videoElement.paused) {
            this.videoElement.pause();
        } else if (!paused && this.videoElement.paused) {
            this.videoElement.play().catch(console.error);
        }
    }

    /**
     * Handle control message
     */
    private handleControl(message: ChunkMessage) {
        console.log('🎮 Received control:', message.control);
        // Handle control commands if needed
    }

    /**
     * Utility: Convert ArrayBuffer to Base64
     */
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Utility: Convert Base64 to ArrayBuffer
     */
    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    /**
     * Format file size
     */
    private formatFileSize(bytes: number): string {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;
        
        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }
        
        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }

    /**
     * Cleanup MediaSource
     */
    private cleanupMediaSource() {
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try {
                this.mediaSource.endOfStream();
            } catch (error) {
                console.error('Error ending MediaSource:', error);
            }
        }
        this.sourceBuffer = null;
    }

    /**
     * Cleanup everything
     */
    cleanup() {
        console.log('🧹 Cleaning up MovieStreamingService');
        
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        
        this.cleanupMediaSource();
        this.mediaSource = null;
        
        this.receivedChunks.clear();
        this.fileChunks = [];
        this.currentFile = null;
        this.isSending = false;
        this.playbackStarted = false;
        this.bufferedChunkIndex = 0;
        
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }
    }
}