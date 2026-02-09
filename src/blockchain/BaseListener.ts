import { EventEmitter } from 'events';
import { Chain, NFTEvent } from '../types/index.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('blockchain');

/**
 * Base class for blockchain listeners
 * Provides common interface for Ethereum and Solana implementations
 */
export abstract class BaseListener extends EventEmitter {
    protected chain: Chain;
    protected trackedWallets: Set<string>;
    protected isConnected: boolean = false;
    protected reconnectAttempts: number = 0;
    protected maxReconnectAttempts: number = 10;
    protected reconnectDelayMs: number = 1000;

    constructor(chain: Chain) {
        super();
        this.chain = chain;
        this.trackedWallets = new Set();
    }

    /**
     * Connect to the blockchain
     */
    abstract connect(): Promise<void>;

    /**
     * Disconnect from the blockchain
     */
    abstract disconnect(): Promise<void>;

    /**
     * Start listening for events
     */
    abstract startListening(): Promise<void>;

    /**
     * Stop listening for events
     */
    abstract stopListening(): Promise<void>;

    /**
     * Add a wallet to track
     */
    addWallet(address: string): void {
        const normalized = this.normalizeAddress(address);
        this.trackedWallets.add(normalized);
        logger.info(`Added wallet to track: ${normalized}`, { chain: this.chain });
    }

    /**
     * Remove a wallet from tracking
     */
    removeWallet(address: string): void {
        const normalized = this.normalizeAddress(address);
        this.trackedWallets.delete(normalized);
        logger.info(`Removed wallet from tracking: ${normalized}`, { chain: this.chain });
    }

    /**
     * Check if a wallet is being tracked
     */
    isTracked(address: string): boolean {
        return this.trackedWallets.has(this.normalizeAddress(address));
    }

    /**
     * Get all tracked wallets
     */
    getTrackedWallets(): string[] {
        return Array.from(this.trackedWallets);
    }

    /**
     * Normalize address format (chain-specific)
     */
    protected abstract normalizeAddress(address: string): string;

    /**
     * Handle connection errors with reconnection logic
     */
    protected async handleConnectionError(error: Error): Promise<void> {
        logger.error(`Connection error on ${this.chain}`, { error: error.message });
        this.isConnected = false;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

            logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`, {
                chain: this.chain,
            });

            setTimeout(async () => {
                try {
                    await this.connect();
                    await this.startListening();
                    this.reconnectAttempts = 0;
                } catch (err) {
                    await this.handleConnectionError(err as Error);
                }
            }, delay);
        } else {
            logger.error(`Max reconnection attempts reached for ${this.chain}`);
            this.emit('fatal_error', new Error(`Failed to reconnect to ${this.chain}`));
        }
    }

    /**
     * Emit an NFT event
     */
    protected emitNFTEvent(event: NFTEvent): void {
        logger.debug('NFT event detected', {
            type: event.type,
            contract: event.contractAddress,
            tokenId: event.tokenId,
            wallet: event.trackedWallet,
        });
        this.emit('nft_event', event);
    }

    /**
     * Get connection status
     */
    getStatus(): { connected: boolean; chain: Chain; walletCount: number } {
        return {
            connected: this.isConnected,
            chain: this.chain,
            walletCount: this.trackedWallets.size,
        };
    }
}
