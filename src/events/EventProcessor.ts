import { EventEmitter } from 'events';
import { NFTEvent } from '../types/index.js';
import { createModuleLogger } from '../utils/logger.js';
import { SpamFilter } from './SpamFilter.js';
import { Deduplicator } from './Deduplicator.js';

const logger = createModuleLogger('events');

/**
 * Event processor handles incoming NFT events
 * - Applies spam filtering
 * - Deduplicates events  
 * - Emits processed events for notification/trading
 */
export class EventProcessor extends EventEmitter {
    private spamFilter: SpamFilter;
    private deduplicator: Deduplicator;
    private processedCount: number = 0;
    private filteredCount: number = 0;

    constructor() {
        super();
        this.spamFilter = new SpamFilter();
        this.deduplicator = new Deduplicator();
    }

    /**
     * Process an incoming NFT event
     */
    async process(event: NFTEvent): Promise<boolean> {
        logger.debug('Processing NFT event', {
            type: event.type,
            contract: event.contractAddress,
            wallet: event.trackedWallet,
        });

        // 1. Check for spam
        if (this.spamFilter.isSpam(event)) {
            this.filteredCount++;
            logger.debug('Event filtered as spam', { contract: event.contractAddress });
            return false;
        }

        // 2. Check for duplicates
        if (this.deduplicator.isDuplicate(event)) {
            logger.debug('Event filtered as duplicate', { txHash: event.txHash });
            return false;
        }

        // 3. Mark as processed
        this.deduplicator.markProcessed(event);
        this.processedCount++;

        // 4. Emit for downstream processing
        logger.info('NFT event processed', {
            type: event.type,
            contract: event.contractAddress,
            tokenId: event.tokenId,
            price: event.priceFormatted,
            wallet: event.trackedWallet,
        });

        this.emit('event', event);

        // Emit specific event type for easier handling
        this.emit(event.type, event);

        return true;
    }

    /**
     * Get processing statistics
     */
    getStats(): { processed: number; filtered: number } {
        return {
            processed: this.processedCount,
            filtered: this.filteredCount,
        };
    }

    /**
     * Add a known spam contract
     */
    addSpamContract(address: string): void {
        this.spamFilter.addSpamContract(address);
    }

    /**
     * Reset statistics
     */
    resetStats(): void {
        this.processedCount = 0;
        this.filteredCount = 0;
    }
}
