import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger.js';
import { UserDatabase } from '../database/UserDatabase.js';

const logger = createModuleLogger('snipe');

export interface SnipeTarget {
    userId: number;
    collection: string;
    maxPrice: number; // in ETH
    active: boolean;
    createdAt: number;
}

export interface ListingEvent {
    collection: string;
    tokenId: string;
    price: number;
    marketplace: string;
    seller: string;
}

/**
 * SnipeMode - Monitor and auto-buy underpriced listings
 */
export class SnipeMode extends EventEmitter {
    private targets: Map<string, SnipeTarget[]> = new Map();
    private userDb: UserDatabase;

    constructor(userDb: UserDatabase) {
        super();
        this.userDb = userDb;
    }

    /**
     * Add snipe target for user
     */
    addTarget(userId: number, collection: string, maxPrice: number): { success: boolean; error?: string } {
        const user = this.userDb.getUser(userId);

        if (!user) {
            return { success: false, error: 'User not found' };
        }

        if (user.tier !== 'premium') {
            return { success: false, error: 'Snipe mode is a Premium feature. Use /upgrade' };
        }

        const normalized = collection.toLowerCase();


        const target: SnipeTarget = {
            userId,
            collection: normalized,
            maxPrice,
            active: true,
            createdAt: Date.now(),
        };

        if (!this.targets.has(normalized)) {
            this.targets.set(normalized, []);
        }

        // Remove existing target for same user/collection
        const existing = this.targets.get(normalized)!;
        const filtered = existing.filter(t => t.userId !== userId);
        filtered.push(target);
        this.targets.set(normalized, filtered);

        logger.info('Snipe target added', { userId, collection: normalized, maxPrice });
        return { success: true };
    }

    /**
     * Remove snipe target
     */
    removeTarget(userId: number, collection: string): boolean {
        const normalized = collection.toLowerCase();
        const existing = this.targets.get(normalized);

        if (!existing) return false;

        const filtered = existing.filter(t => t.userId !== userId);
        if (filtered.length === existing.length) return false;

        if (filtered.length === 0) {
            this.targets.delete(normalized);
        } else {
            this.targets.set(normalized, filtered);
        }

        logger.info('Snipe target removed', { userId, collection: normalized });
        return true;
    }

    /**
     * Get user's active snipe targets
     */
    getUserTargets(userId: number): SnipeTarget[] {
        const userTargets: SnipeTarget[] = [];
        for (const targets of this.targets.values()) {
            for (const target of targets) {
                if (target.userId === userId && target.active) {
                    userTargets.push(target);
                }
            }
        }
        return userTargets;
    }

    /**
     * Check if a listing matches any snipe targets
     */
    checkListing(listing: ListingEvent): SnipeTarget[] {
        const normalized = listing.collection.toLowerCase();
        const targets = this.targets.get(normalized);

        if (!targets) return [];

        return targets.filter(t => t.active && listing.price <= t.maxPrice);
    }

    /**
     * Format snipe targets for display
     */
    formatTargets(targets: SnipeTarget[]): string {
        if (targets.length === 0) {
            return '🎯 *Snipe Mode*\n\nNo active snipe targets.\n\nUse `/snipe <collection> <maxPrice>` to add one.';
        }

        let message = '🎯 *Active Snipe Targets*\n\n';
        for (const target of targets) {
            const status = target.active ? '🟢' : '🔴';
            message += `${status} \`${target.collection}\` - Max: ${target.maxPrice} ETH\n`;
        }
        message += '\nUse `/snipe off <collection>` to remove.';
        return message;
    }
}
