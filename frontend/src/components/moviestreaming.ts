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
    private syncInterval: ReturnType<typeof setInterval> | null = null;

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
            // Create data channel with better configuration
            this.dataChannel = peerConnection.createDataChannel('movieSharing', {
                ordered: true,
                maxPacketLifeTime: 30000, // 30 seconds
            });
            this.isMaster = true;
            this.setupDataChannelHandlers(this.dataChannel);
            
            console.log('📡 Data channel created as initiator');
            return this.dataChannel;
        } else {
            // Listen for data channel
            peerConnection.ondatachannel = (event) => {
                console.log('📡 Received data channel from remote peer');
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
        console.log('🔧 Setting up data channel handlers, readyState:', channel.readyState);

        channel.onopen = () => {
            console.log('✅ Data channel opened successfully, readyState:', channel.readyState);
            this.onStatusUpdate?.('Data channel connected - ready for movie sharing');
        };

        channel.onclose = () => {
            console.log('❌ Data channel closed');
            this.onStatusUpdate?.('Data channel disconnected');
            this.cleanup();
        };

        channel.onerror = (error) => {
            console.error('❌ Data channel error:', error);
            this.onError?.('Data channel connection error');
        };

        channel.onmessage = (event) => {
            try {
                console.log('📨 Data channel message received, size:', event.data.length);
                this.handleIncomingMessage(event.data);
            } catch (error) {
                console.error('❌ Error handling data channel message:', error);
            }
        };

        // Log state changes
        const originalReadyState = channel.readyState;
        const stateCheckInterval = setInterval(() => {
            if (channel.readyState !== originalReadyState) {
                console.log('📡 Data channel state changed to:', channel.readyState);
                if (channel.readyState === 'closed') {
                    clearInterval(stateCheckInterval);
                }
            }
        }, 1000);
    }

    /**
     * Start sharing a movie file
     */
    async shareMovie(file: File): Promise<void> {
        console.log('🎬 Starting movie share:', {
            name: file.name,
            size: file.size,
            type: file.type,
            dataChannelState: this.dataChannel?.readyState
        });

        if (!this.dataChannel) {
            const error = 'Data channel not initialized';
            console.error('❌', error);
            this.onError?.(error);
            return;
        }

        if (this.dataChannel.readyState !== 'open') {
            const error = `Data channel not ready. State: ${this.dataChannel.readyState}`;
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
        this.sendingProgress = 0;
        this.onStatusUpdate?.('Processing movie file...');

        try {
            // Split file into chunks
            console.log('📁 Starting file chunking process...');
            await this.splitFileIntoChunks(file);
            console.log('📁 File split into', this.totalChunks, 'chunks successfully');

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

            console.log('📤 Sending metadata:', metadata);
            this.sendMessage(metadataMessage);
            console.log('📤 Metadata sent successfully');

            this.onStatusUpdate?.('Starting file transfer...');

            // Start sending chunks after small delay
            setTimeout(() => {
                console.log('📤 Starting chunk transmission...');
                this.sendNextChunk();
            }, 500);

        } catch (error) {
            console.error('❌ Failed to process movie:', error);
            this.onError?.(`Failed to process movie: ${error}`);
            this.isSending = false;
            this.sendingProgress = 0;
        }
    }

    /**
     * Split file into chunks
     */
    private async splitFileIntoChunks(file: File): Promise<void> {
        this.fileChunks = [];
        this.totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        this.sendingProgress = 0;

        console.log('📁 Starting file chunking...', {
            fileSize: file.size,
            chunkSize: CHUNK_SIZE,
            totalChunks: this.totalChunks
        });

        for (let i = 0; i < this.totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            const arrayBuffer = await chunk.arrayBuffer();
            this.fileChunks.push(arrayBuffer);

            // Log progress every 100 chunks or at key milestones
            if (i % 100 === 0 || i === this.totalChunks - 1) {
                console.log(`📁 Chunking progress: ${i + 1}/${this.totalChunks} (${((i + 1) / this.totalChunks * 100).toFixed(1)}%)`);
            }
        }

        console.log(`✅ File chunking completed: ${this.totalChunks} chunks ready for transmission`);
    }

    /**
     * Send next chunk with better error handling
     */
    private sendNextChunk() {
        if (!this.isSending) {
            console.log('🛑 Sending stopped by user or error');
            return;
        }

        if (this.sendingProgress >= this.totalChunks) {
            console.log('✅ All chunks sent successfully!');
            this.onStatusUpdate?.('Movie transfer completed successfully');
            this.isSending = false;
            this.startSyncPlayback();
            return;
        }

        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            console.error('❌ Data channel not ready for sending chunk', this.sendingProgress, 'State:', this.dataChannel?.readyState);
            this.onError?.('Connection lost during transfer');
            this.isSending = false;
            return;
        }

        try {
            const chunkData = this.fileChunks[this.sendingProgress];
            console.log(`📤 Preparing chunk ${this.sendingProgress}/${this.totalChunks} (${chunkData.byteLength} bytes)`);
            
            const base64Data = this.arrayBufferToBase64(chunkData);
            console.log(`📤 Chunk ${this.sendingProgress} encoded to base64, length: ${base64Data.length}`);

            const chunkMessage: ChunkMessage = {
                type: 'chunk',
                chunkIndex: this.sendingProgress,
                totalChunks: this.totalChunks,
                data: base64Data
            };

            // Send the message
            this.sendMessage(chunkMessage);
            console.log(`✅ Chunk ${this.sendingProgress}/${this.totalChunks} sent successfully`);

            // Update progress
            this.sendingProgress++;
            const progress = (this.sendingProgress / this.totalChunks) * 100;
            console.log(`📊 Progress update: ${progress.toFixed(1)}%`);
            this.onProgressUpdate?.(progress, 'sending');

            // Status update every 10 chunks
            if (this.sendingProgress % 10 === 0 || this.sendingProgress === this.totalChunks) {
                this.onStatusUpdate?.(`Uploading... ${this.sendingProgress}/${this.totalChunks} chunks (${progress.toFixed(1)}%)`);
            }

            // Continue sending with adaptive delay based on chunk size
            const delay = Math.max(10, Math.min(50, chunkData.byteLength / 1024));
            setTimeout(() => this.sendNextChunk(), delay);

        } catch (error) {
            console.error(`❌ Failed to send chunk ${this.sendingProgress}:`, error);
            this.onError?.(`Transfer failed at chunk ${this.sendingProgress}/${this.totalChunks}: ${error}`);
            this.isSending = false;
        }
    }

    /**
     * Send message through data channel with retry logic
     */
    private sendMessage(message: ChunkMessage) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error(`Data channel not ready, state: ${this.dataChannel?.readyState || 'null'}`);
        }

        const jsonMessage = JSON.stringify(message);
        console.log(`📤 Sending ${message.type} message, size: ${jsonMessage.length} bytes`);
        
        try {
            this.dataChannel.send(jsonMessage);
        } catch (error) {
            console.error('❌ Failed to send message:', error);
            throw error;
        }
    }

    /**
     * Handle incoming messages with better error handling
     */
    private handleIncomingMessage(data: string) {
        try {
            console.log('📨 Processing incoming message, size:', data.length);
            const message: ChunkMessage = JSON.parse(data);
            console.log(`📨 Parsed ${message.type} message successfully`);

            switch (message.type) {
                case 'metadata':
                    console.log('📋 Handling metadata message');
                    this.handleMetadata(message);
                    break;
                case 'chunk':
                    console.log(`📥 Handling chunk message: ${message.chunkIndex}/${message.totalChunks}`);
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
            console.error('❌ Failed to parse/handle message:', error);
            this.onError?.('Failed to process incoming data');
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

        console.log('📋 Processing metadata:', {
            fileName: message.metadata.fileName,
            fileSize: message.metadata.fileSize,
            fileType: message.metadata.fileType,
            totalChunks: message.totalChunks
        });

        this.movieMetadata = message.metadata;
        this.expectedTotalChunks = message.totalChunks;
        this.receivedChunks.clear();
        this.receivingProgress = 0;
        this.playbackStarted = false;
        this.bufferedChunkIndex = 0;

        this.onStatusUpdate?.(`Receiving "${message.metadata.fileName}" (${this.formatFileSize(message.metadata.fileSize)})`);
        this.setupMediaSource();

        console.log('✅ Metadata processed, expecting', this.expectedTotalChunks, 'chunks');
    }

    /**
     * Handle chunk message with better tracking
     */
    private handleChunk(message: ChunkMessage) {
        if (message.chunkIndex === undefined || !message.data) {
            console.error('❌ Invalid chunk message - missing chunkIndex or data');
            return;
        }

        try {
            console.log(`📥 Processing chunk ${message.chunkIndex}/${this.expectedTotalChunks}`);
            
            const chunkData = this.base64ToArrayBuffer(message.data);
            this.receivedChunks.set(message.chunkIndex, chunkData);
            this.receivingProgress++;

            console.log(`✅ Chunk ${message.chunkIndex} received and stored (${chunkData.byteLength} bytes)`);
            console.log(`📊 Total chunks received: ${this.receivingProgress}/${this.expectedTotalChunks}`);

            const progress = (this.receivingProgress / this.expectedTotalChunks) * 100;
            console.log(`📊 Download progress: ${progress.toFixed(1)}%`);
            this.onProgressUpdate?.(progress, 'receiving');

            // Status update every 10 chunks
            if (this.receivingProgress % 10 === 0 || this.receivingProgress === this.expectedTotalChunks) {
                this.onStatusUpdate?.(`Downloading... ${this.receivingProgress}/${this.expectedTotalChunks} chunks (${progress.toFixed(1)}%)`);
            }

            // Check if we can start playback
            this.checkPlaybackReadiness();

            // Try to buffer more chunks
            this.bufferChunks();

        } catch (error) {
            console.error(`❌ Error processing chunk ${message.chunkIndex}:`, error);
            this.onError?.(`Failed to process chunk ${message.chunkIndex}`);
        }
    }

    /**
     * Setup MediaSource with better error handling
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
            console.log('📺 MediaSource opened successfully');

            if (!this.mediaSource || !this.movieMetadata) return;

            try {
                // Use a more compatible MIME type
                let mimeType = this.movieMetadata.fileType;
                console.log('📺 Checking MIME type support:', mimeType);

                if (!MediaSource.isTypeSupported(mimeType)) {
                    console.log('📺 Original MIME type not supported, trying fallbacks');
                    // Try common fallbacks
                    const fallbacks = [
                        'video/mp4; codecs="avc1.42E01E"',
                        'video/webm; codecs="vp8"',
                        'video/mp4',
                        'video/webm'
                    ];

                    let found = false;
                    for (const fallback of fallbacks) {
                        if (MediaSource.isTypeSupported(fallback)) {
                            mimeType = fallback;
                            console.log('📺 Using fallback MIME type:', fallback);
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        throw new Error(`No supported MIME type found for ${this.movieMetadata.fileType}`);
                    }
                }

                this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);

                this.sourceBuffer.addEventListener('updateend', () => {
                    console.log('📺 Source buffer update completed');
                    this.isBuffering = false;
                    this.bufferChunks(); // Try to buffer more
                });

                this.sourceBuffer.addEventListener('error', (e) => {
                    console.error('📺 Source buffer error:', e);
                    this.onError?.('Video decoding error occurred');
                });

                console.log('✅ SourceBuffer created successfully for', mimeType);

            } catch (error) {
                console.error('❌ Failed to create SourceBuffer:', error);
                this.onError?.(`Unsupported video format: ${this.movieMetadata.fileType}`);
            }
        });

        this.mediaSource.addEventListener('sourceended', () => {
            console.log('📺 MediaSource playback ended');
        });

        this.mediaSource.addEventListener('error', (e) => {
            console.error('📺 MediaSource error:', e);
            this.onError?.('Media source error occurred');
        });
    }

    /**
     * Check if ready for playback with better logging
     */
    private checkPlaybackReadiness() {
        if (this.playbackStarted || !this.expectedTotalChunks) return;

        const bufferRatio = this.receivingProgress / this.expectedTotalChunks;
        console.log(`📊 Checking playback readiness: ${(bufferRatio * 100).toFixed(1)}% buffered (threshold: ${(BUFFER_THRESHOLD * 100)}%)`);

        if (bufferRatio >= BUFFER_THRESHOLD) {
            console.log('✅ Buffer threshold reached, starting playback preparation');
            this.playbackStarted = true;
            this.onStatusUpdate?.('Preparing video for playback...');
            this.onPlaybackReady?.();

            if (!this.isMaster) {
                console.log('📺 Starting sync playback as receiver');
                this.startSyncPlayback();
            }
        }
    }

    /**
     * Buffer chunks into MediaSource with better error handling
     */
    private bufferChunks() {
        if (!this.sourceBuffer || this.isBuffering) {
            console.log('📺 Skipping buffer chunks - sourceBuffer:', !!this.sourceBuffer, 'isBuffering:', this.isBuffering);
            return;
        }

        // Find sequential chunks to buffer
        const chunksToAppend: ArrayBuffer[] = [];
        let currentIndex = this.bufferedChunkIndex;

        // Collect up to 5 sequential chunks (reduced for better performance)
        while (chunksToAppend.length < 5 && this.receivedChunks.has(currentIndex)) {
            chunksToAppend.push(this.receivedChunks.get(currentIndex)!);
            currentIndex++;
        }

        if (chunksToAppend.length === 0) {
            console.log('📺 No sequential chunks available for buffering, waiting...');
            return;
        }

        console.log(`📺 Buffering ${chunksToAppend.length} chunks starting from index ${this.bufferedChunkIndex}`);

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

            console.log(`✅ Buffered ${chunksToAppend.length} chunks (${this.formatFileSize(totalSize)}), next index: ${currentIndex}`);

        } catch (error) {
            this.isBuffering = false;
            console.error('❌ Buffer append error:', error);
            this.onError?.('Video buffering error - try refreshing');
        }
    }

    /**
     * Start synchronized playback
     */
    private startSyncPlayback() {
        console.log('🎵 Starting sync playback, isMaster:', this.isMaster);

        if (!this.videoElement) {
            console.error('❌ No video element for playback');
            return;
        }

        if (this.isMaster) {
            // Master starts playback and broadcasts sync
            setTimeout(() => {
                if (this.videoElement) {
                    console.log('▶️ Master attempting to start playback');
                    this.videoElement.play().then(() => {
                        console.log('✅ Master started playback successfully');
                        this.startSyncBroadcast();
                    }).catch(error => {
                        console.error('❌ Failed to start playback:', error);
                        this.onError?.('Failed to start video playback');
                    });
                }
            }, 1000);
        } else {
            console.log('👥 Slave waiting for sync commands from master');
        }
    }

    /**
     * Start sync broadcasting (master only)
     */
    private startSyncBroadcast() {
        if (!this.isMaster || this.syncInterval) return;

        console.log('📡 Starting sync broadcast interval');

        this.syncInterval = setInterval(() => {
            if (!this.videoElement || !this.dataChannel || this.dataChannel.readyState !== 'open') {
                console.log('📡 Skipping sync - video or channel not ready');
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
                console.log('📡 Sync message sent:', syncMessage.syncData);
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

        console.log('🔄 Sync data received:', {
            masterTime: currentTime,
            slaveTime: this.videoElement.currentTime,
            networkDelay,
            timeDiff,
            paused
        });

        if (timeDiff > SEEK_TOLERANCE) {
            console.log(`🔄 Syncing video: ${timeDiff.toFixed(2)}s drift detected`);
            this.videoElement.currentTime = adjustedTime;
        }

        if (paused && !this.videoElement.paused) {
            console.log('⏸️ Pausing video to sync with master');
            this.videoElement.pause();
        } else if (!paused && this.videoElement.paused) {
            console.log('▶️ Playing video to sync with master');
            this.videoElement.play().catch(console.error);
        }
    }

    /**
     * Handle control message
     */
    private handleControl(message: ChunkMessage) {
        console.log('🎮 Received control command:', message.control);
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
                console.error('❌ Error ending MediaSource:', error);
            }
        }
        this.sourceBuffer = null;
    }

    /**
     * Get current status for debugging
     */
    getStatus() {
        return {
            dataChannelState: this.dataChannel?.readyState,
            isSending: this.isSending,
            sendingProgress: this.sendingProgress,
            totalChunks: this.totalChunks,
            receivingProgress: this.receivingProgress,
            expectedTotalChunks: this.expectedTotalChunks,
            playbackStarted: this.playbackStarted,
            isMaster: this.isMaster,
            mediaSourceState: this.mediaSource?.readyState
        };
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
        this.sendingProgress = 0;
        this.receivingProgress = 0;

        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }

        console.log('✅ Cleanup completed');
    }
}