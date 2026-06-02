/**
 * Core types for NFT events and blockchain data
 */

// Supported blockchain networks
export type Chain = 'ethereum' | 'solana';

// NFT event types
export type NFTEventType = 'mint' | 'buy' | 'sell' | 'transfer';

// Marketplace identifiers
export type Marketplace =
    | 'opensea'
    | 'blur'
    | 'looksrare'
    | 'x2y2'
    | 'magiceden'
    | 'tensor'
    | 'rarible'
    | 'unknown';

/**
 * NFT metadata
 */
export interface NFTMetadata {
    name?: string;
    collection?: string;
    image?: string;
    description?: string;
    attributes?: Record<string, unknown>[];
}

/**
 * Raw blockchain transaction
 */
export interface RawTransaction {
    hash: string;
    blockNumber: number;
    from: string;
    to: string | null;
    value: bigint;
    data: string;
    timestamp: number;
    chain: Chain;
}

/**
 * Parsed NFT event
 */
export interface NFTEvent {
    // Event identification
    id: string;
    type: NFTEventType;
    chain: Chain;

    // Transaction details
    txHash: string;
    blockNumber: number;
    timestamp: number;

    // Wallet involvement
    trackedWallet: string;
    from: string;
    to: string;

    // NFT details
    contractAddress: string;
    tokenId: string;
    tokenStandard: 'ERC721' | 'ERC1155' | 'SPL' | 'unknown';
    quantity: number;

    // Trade details
    price: bigint;
    priceFormatted: string;
    currency: string;
    marketplace: Marketplace;

    // Metadata (fetched async)
    metadata?: NFTMetadata;

    // Optional human-readable label for the tracked wallet
    walletLabel?: string;
}

/**
 * Wallet tracking entry
 */
export interface TrackedWallet {
    address: string;
    chain: Chain;
    label?: string;
    addedAt: number;
    isActive: boolean;
}

/**
 * Trade execution request
 */
export interface TradeRequest {
    event: NFTEvent;
    quantity: number;
    maxPrice: bigint;
    slippageTolerance: number;
    priorityFee?: bigint;
    requireConfirmation: boolean;
}

/**
 * Trade execution result
 */
export interface TradeResult {
    success: boolean;
    txHash?: string;
    actualPrice?: bigint;
    gasUsed?: bigint;
    error?: string;
    timestamp: number;
}

/**
 * Notification message
 */
export interface NotificationMessage {
    type: 'event' | 'trade' | 'alert' | 'error';
    event?: NFTEvent;
    trade?: TradeResult;
    title: string;
    body: string;
    timestamp: number;
    actionRequired?: boolean;
}

/**
 * Spending record for daily limits
 */
export interface SpendingRecord {
    date: string; // YYYY-MM-DD
    chain: Chain;
    totalSpent: bigint;
    transactions: number;
}

/**
 * Transaction log entry
 */
export interface TransactionLog {
    id: string;
    timestamp: number;
    chain: Chain;
    type: 'copy_buy' | 'manual_buy' | 'sell';
    triggerEvent?: NFTEvent;
    ourTxHash: string;
    status: 'pending' | 'confirmed' | 'failed';
    contractAddress: string;
    tokenId: string;
    price: bigint;
    gasUsed?: bigint;
    error?: string;
}

/**
 * Kill switch state
 */
export interface KillSwitchState {
    triggered: boolean;
    triggeredAt?: number;
    triggeredBy?: string;
    reason?: string;
}
