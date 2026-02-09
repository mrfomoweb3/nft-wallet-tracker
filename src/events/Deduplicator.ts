import { NFTEvent } from '../types/index.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('deduplicator');

interface DedupEntry {
    timestamp: number;
    count: number;
}

/**
 * Deduplicator - Prevents duplicate event notifications
 * Uses a sliding time window to track processed events
 */
export class Deduplicator {
    private processed: Map<string, DedupEntry>;
    private windowMs: number;
    private cleanupInterval: NodeJS.Timeout | null = null;

    constructor(windowMs: number = 5 * 60 * 1000) { // 5 minute default
        this.processed = new Map();
        this.windowMs = windowMs;

        // Start cleanup interval
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }

    /**
     * Generate a unique key for an event
     */
    private getKey(event: NFTEvent): string {
        return `${event.txHash}-${event.contractAddress}-${event.tokenId}`;
    }

    /**
     * Check if an event is a duplicate
     */
    isDuplicate(event: NFTEvent): boolean {
        const key = this.getKey(event);
        const entry = this.processed.get(key);

        if (!entry) {
            return false;
        }

        // Check if still within window
        if (Date.now() - entry.timestamp < this.windowMs) {
            logger.debug('Duplicate event detected', { key, count: entry.count + 1 });
            entry.count++;
            return true;
        }

        // Entry expired, not a duplicate
        return false;
    }

    /**
     * Mark an event as processed
     */
    markProcessed(event: NFTEvent): void {
        const key = this.getKey(event);
        this.processed.set(key, {
            timestamp: Date.now(),
            count: 1,
        });
    }

    /**
     * Clean up expired entries
     */
    private cleanup(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, entry] of this.processed.entries()) {
            if (now - entry.timestamp > this.windowMs) {
                this.processed.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.debug('Cleaned up expired dedup entries', { count: cleaned });
        }
    }

    /**
     * Get current cache size
     */
    getSize(): number {
        return this.processed.size;
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.processed.clear();
    }

    /**
     * Stop the cleanup interval
     */
    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}
