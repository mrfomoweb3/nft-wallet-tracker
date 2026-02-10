import { WebSocketProvider, formatEther, Log } from 'ethers';
import { BaseListener } from './BaseListener.js';
import { NFTEvent, NFTEventType, Marketplace } from '../types/index.js';
import { EthereumConfig } from '../config/index.js';
import { createModuleLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const logger = createModuleLogger('ethereum');

// ERC-721 Transfer event signature
const ERC721_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ERC-1155 TransferSingle/TransferBatch event signatures
const ERC1155_TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const ERC1155_TRANSFER_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

// Zero address (indicates mint)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// WETH contract (mainnet) - used for marketplace payment detection
const WETH_CONTRACT = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// ERC-20 Transfer event topic (same as ERC-721 but used for WETH payments)
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Known marketplace contracts (mainnet)
const MARKETPLACE_CONTRACTS: Record<string, Marketplace> = {
    '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC': 'opensea', // Seaport 1.5
    '0x00000000000001ad428e4906aE43D8F9852d0dD6': 'opensea', // Seaport 1.6
    '0x39da41747a83aeE658334415666f3EF92DD0D541': 'blur',     // Blur pool
    '0x29469395eAf6f95920E59F858042f0e28D98a20B': 'blur',     // Blur v2
    '0x59728544B08AB483533076417FbBB2fD0B17CE3a': 'looksrare',
    '0x74312363e45DCaBA76c59ec49a7Aa8A65a67EeD3': 'x2y2',
};

/**
 * Ethereum blockchain listener
 * Uses WebSocket for real-time event monitoring
 */
export class EthereumListener extends BaseListener {
    private provider: WebSocketProvider | null = null;
    private config: EthereumConfig;
    private pendingTxSubscription: NodeJS.Timeout | null = null;
    private processedTxHashes: Set<string> = new Set();
    private processedTxExpiry: Map<string, number> = new Map();

    // Diagnostics
    private blocksProcessed: number = 0;
    private lastBlockNumber: number = 0;
    private eventsDetected: number = 0;
    private lastError: string | null = null;

    constructor(config: EthereumConfig) {
        super('ethereum');
        this.config = config;
    }

    /**
     * Connect to Ethereum WebSocket
     */
    async connect(): Promise<void> {
        try {
            logger.info('Connecting to Ethereum WebSocket...', { url: this.config.wsUrl });

            this.provider = new WebSocketProvider(this.config.wsUrl);

            // Wait for connection
            await this.provider.ready;

            const network = await this.provider.getNetwork();
            logger.info('Connected to Ethereum', {
                chainId: network.chainId.toString(),
                name: network.name,
            });

            this.isConnected = true;
            this.emit('connected', { chain: 'ethereum' });

            // Handle disconnection - cast to EventTarget for type safety
            const ws = this.provider.websocket as unknown as EventTarget;
            ws.addEventListener('close', () => {
                logger.warn('WebSocket connection closed');
                this.handleConnectionError(new Error('WebSocket closed'));
            });

            ws.addEventListener('error', () => {
                this.handleConnectionError(new Error('WebSocket error'));
            });

        } catch (error) {
            logger.error('Failed to connect to Ethereum', { error });
            throw error;
        }
    }

    /**
     * Disconnect from Ethereum
     */
    async disconnect(): Promise<void> {
        if (this.pendingTxSubscription) {
            clearInterval(this.pendingTxSubscription);
            this.pendingTxSubscription = null;
        }

        if (this.provider) {
            await this.provider.destroy();
            this.provider = null;
        }

        this.isConnected = false;
        logger.info('Disconnected from Ethereum');
    }

    /**
     * Start listening for NFT events
     */
    async startListening(): Promise<void> {
        if (!this.provider) {
            throw new Error('Not connected to Ethereum');
        }

        logger.info('Starting Ethereum event listener...');

        // Listen for all blocks
        this.provider.on('block', async (blockNumber: number) => {
            try {
                await this.processBlock(blockNumber);
                this.blocksProcessed++;
                this.lastBlockNumber = blockNumber;

                // Log every 10th block to confirm liveness
                if (this.blocksProcessed % 10 === 1) {
                    logger.info('Block processing alive', {
                        blockNumber,
                        totalProcessed: this.blocksProcessed,
                        trackedWallets: this.trackedWallets.size,
                        eventsDetected: this.eventsDetected,
                    });
                }
            } catch (error) {
                this.lastError = (error as Error).message;
                logger.error('Error processing block', { blockNumber, error });
            }
        });

        // Cleanup old processed transactions periodically
        setInterval(() => this.cleanupProcessedTx(), 60000);

        logger.info('Ethereum listener started, waiting for blocks...');
    }

    /**
     * Stop listening for events
     */
    async stopListening(): Promise<void> {
        if (this.provider) {
            this.provider.removeAllListeners('block');
        }
        logger.info('Ethereum listener stopped');
    }

    /**
     * Process a block for NFT events
     */
    private async processBlock(blockNumber: number): Promise<void> {
        if (!this.provider) return;

        // Get ERC-721 Transfer logs
        const logs = await this.provider.getLogs({
            fromBlock: blockNumber,
            toBlock: blockNumber,
            topics: [[ERC721_TRANSFER_TOPIC, ERC1155_TRANSFER_SINGLE, ERC1155_TRANSFER_BATCH]],
        });

        for (const log of logs) {
            await this.processLog(log);
        }
    }

    /**
     * Process a single log event
     */
    private async processLog(log: Log): Promise<void> {
        try {
            // Check if this transaction involves a tracked wallet
            const from = this.extractAddress(log.topics[1]);
            const to = this.extractAddress(log.topics[2]);

            const trackedWallet = this.isTracked(from) ? from : this.isTracked(to) ? to : null;
            if (!trackedWallet) return;

            // Deduplication check
            const dedupKey = `${log.transactionHash}-${log.index}`;
            if (this.isProcessed(dedupKey)) return;
            this.markProcessed(dedupKey);

            // Determine if it's ERC-721 or ERC-1155
            const isERC1155 = log.topics[0] === ERC1155_TRANSFER_SINGLE || log.topics[0] === ERC1155_TRANSFER_BATCH;

            // Get transaction details for price info
            const tx = await this.provider!.getTransaction(log.transactionHash);
            const receipt = await this.provider!.getTransactionReceipt(log.transactionHash);
            const block = await this.provider!.getBlock(log.blockNumber);

            if (!tx || !receipt || !block) return;

            // Determine event type
            const eventType = this.determineEventType(from, to, trackedWallet);

            // Detect marketplace
            const marketplace = this.detectMarketplace(tx.to || '', receipt.logs);

            // Filter out zero-value transfers (likely spam or internal transfers)
            // But skip filtering for known marketplace transactions — payment may be via WETH
            if (tx.value === 0n && eventType !== 'mint' && marketplace === 'unknown') {
                const paymentValue = this.extractPaymentFromLogs(receipt.logs);
                if (paymentValue === 0n) {
                    logger.debug('Filtered zero-value transfer', { txHash: log.transactionHash });
                    return;
                }
            }

            // Marketplace already detected above

            // Extract token ID
            const tokenId = isERC1155
                ? this.extractERC1155TokenId(log)
                : this.extractERC721TokenId(log);

            // Calculate price
            const price = tx.value > 0n ? tx.value : this.extractPaymentFromLogs(receipt.logs);

            // Create NFT event
            const event: NFTEvent = {
                id: uuidv4(),
                type: eventType,
                chain: 'ethereum',
                txHash: log.transactionHash,
                blockNumber: log.blockNumber,
                timestamp: block.timestamp * 1000,
                trackedWallet: trackedWallet,
                from: from,
                to: to,
                contractAddress: log.address,
                tokenId: tokenId.toString(),
                tokenStandard: isERC1155 ? 'ERC1155' : 'ERC721',
                quantity: isERC1155 ? this.extractERC1155Quantity(log) : 1,
                price: price,
                priceFormatted: `${formatEther(price)} ETH`,
                currency: 'ETH',
                marketplace: marketplace,
            };

            this.eventsDetected++;
            this.emitNFTEvent(event);

        } catch (error) {
            logger.error('Error processing log', {
                txHash: log.transactionHash,
                error: (error as Error).message
            });
        }
    }

    /**
     * Extract address from topic (padded 32 bytes)
     */
    private extractAddress(topic: string | undefined): string {
        if (!topic) return ZERO_ADDRESS;
        return '0x' + topic.slice(-40).toLowerCase();
    }

    /**
     * Determine event type based on addresses
     */
    private determineEventType(from: string, to: string, trackedWallet: string): NFTEventType {
        if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
            return 'mint';
        }
        if (from.toLowerCase() === trackedWallet.toLowerCase()) {
            return 'sell';
        }
        if (to.toLowerCase() === trackedWallet.toLowerCase()) {
            return 'buy';
        }
        return 'transfer';
    }

    /**
     * Detect marketplace from transaction
     */
    private detectMarketplace(to: string, logs: readonly Log[]): Marketplace {
        // Check direct contract interaction
        const normalized = to.toLowerCase();
        for (const [address, marketplace] of Object.entries(MARKETPLACE_CONTRACTS)) {
            if (normalized === address.toLowerCase()) {
                return marketplace;
            }
        }

        // Check logs for marketplace contract interaction
        for (const log of logs) {
            const logAddress = log.address.toLowerCase();
            for (const [address, marketplace] of Object.entries(MARKETPLACE_CONTRACTS)) {
                if (logAddress === address.toLowerCase()) {
                    return marketplace;
                }
            }
        }

        return 'unknown';
    }

    /**
     * Extract ERC-721 token ID from log
     */
    private extractERC721TokenId(log: Log): bigint {
        // Token ID is the third topic for ERC-721 Transfer
        return BigInt(log.topics[3] || '0');
    }

    /**
     * Extract ERC-1155 token ID from log
     */
    private extractERC1155TokenId(log: Log): bigint {
        // For ERC-1155, token ID is in the data
        if (log.data.length >= 66) {
            return BigInt('0x' + log.data.slice(2, 66));
        }
        return 0n;
    }

    /**
     * Extract ERC-1155 quantity from log
     */
    private extractERC1155Quantity(log: Log): number {
        if (log.data.length >= 130) {
            return Number(BigInt('0x' + log.data.slice(66, 130)));
        }
        return 1;
    }

    /**
     * Extract payment value from transaction logs (for marketplace buys)
     */
    private extractPaymentFromLogs(logs: readonly Log[]): bigint {
        let totalPayment = 0n;

        for (const log of logs) {
            // Check for WETH Transfer events (ERC-20 Transfer from WETH contract)
            if (
                log.address.toLowerCase() === WETH_CONTRACT &&
                log.topics[0] === ERC20_TRANSFER_TOPIC &&
                log.topics.length >= 3 &&
                log.data.length >= 66
            ) {
                try {
                    const value = BigInt(log.data.slice(0, 66));
                    totalPayment += value;
                } catch {
                    // Skip malformed data
                }
            }
        }

        return totalPayment;
    }

    /**
     * Normalize Ethereum address to lowercase
     */
    protected normalizeAddress(address: string): string {
        return address.toLowerCase();
    }

    /**
     * Check if transaction was already processed
     */
    private isProcessed(key: string): boolean {
        return this.processedTxHashes.has(key);
    }

    /**
     * Mark transaction as processed
     */
    private markProcessed(key: string): void {
        this.processedTxHashes.add(key);
        this.processedTxExpiry.set(key, Date.now() + 5 * 60 * 1000); // 5 min expiry
    }

    /**
     * Clean up old processed transaction hashes
     */
    private cleanupProcessedTx(): void {
        const now = Date.now();
        for (const [key, expiry] of this.processedTxExpiry.entries()) {
            if (now > expiry) {
                this.processedTxHashes.delete(key);
                this.processedTxExpiry.delete(key);
            }
        }
    }

    /**
     * Get diagnostic info for /status command
     */
    getDiagnostics(): {
        connected: boolean;
        blocksProcessed: number;
        lastBlockNumber: number;
        eventsDetected: number;
        trackedWalletCount: number;
        trackedWallets: string[];
        lastError: string | null;
    } {
        return {
            connected: this.isConnected,
            blocksProcessed: this.blocksProcessed,
            lastBlockNumber: this.lastBlockNumber,
            eventsDetected: this.eventsDetected,
            trackedWalletCount: this.trackedWallets.size,
            trackedWallets: Array.from(this.trackedWallets),
            lastError: this.lastError,
        };
    }
}
