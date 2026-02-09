import { EventEmitter } from 'events';
import axios from 'axios';
import { createModuleLogger } from '../utils/logger.js';
import { UserDatabase } from '../database/UserDatabase.js';

const logger = createModuleLogger('price-tracker');

interface FloorPriceData {
    collection: string;
    floorPrice: number;
    timestamp: number;
}

/**
 * PriceTracker - Monitor floor prices and send alerts
 */
export class PriceTracker extends EventEmitter {
    private userDb: UserDatabase;
    private floorPrices: Map<string, FloorPriceData> = new Map();
    private checkInterval: NodeJS.Timeout | null = null;
    private intervalMs: number = 5 * 60 * 1000; // 5 minutes

    constructor(userDb: UserDatabase) {
        super();
        this.userDb = userDb;
    }

    /**
     * Start periodic price checking
     */
    start(): void {
        logger.info('Starting price tracker');
        this.checkInterval = setInterval(() => this.checkPrices(), this.intervalMs);
        // Initial check
        this.checkPrices();
    }

    /**
     * Stop price tracking
     */
    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        logger.info('Price tracker stopped');
    }

    /**
     * Check all tracked collections for price changes
     */
    private async checkPrices(): Promise<void> {
        const users = this.userDb.getUsersWithPriceAlerts();

        // Get unique collections
        const collections = new Set<string>();
        for (const user of users) {
            for (const alert of user.priceAlerts) {
                collections.add(alert.collection);
            }
        }

        for (const collection of collections) {
            try {
                const currentFloor = await this.fetchFloorPrice(collection);
                const previousData = this.floorPrices.get(collection);

                if (previousData && previousData.floorPrice > 0) {
                    const changePercent = ((currentFloor - previousData.floorPrice) / previousData.floorPrice) * 100;

                    // Check if any user's threshold is exceeded
                    for (const user of users) {
                        const alert = user.priceAlerts.find(a => a.collection === collection);
                        if (alert && Math.abs(changePercent) >= alert.changePercent) {
                            this.emit('price_alert', {
                                userId: user.id,
                                collection,
                                previousFloor: previousData.floorPrice,
                                currentFloor,
                                changePercent,
                            });
                        }
                    }
                }

                // Update stored floor price
                this.floorPrices.set(collection, {
                    collection,
                    floorPrice: currentFloor,
                    timestamp: Date.now(),
                });
            } catch (error) {
                logger.error('Failed to check floor price', { collection, error });
            }
        }
    }

    /**
     * Fetch floor price for a collection
     */
    private async fetchFloorPrice(collection: string): Promise<number> {
        try {
            // Try Reservoir API (more reliable, free tier available)
            const response = await axios.get(
                `https://api.reservoir.tools/collections/v6`,
                {
                    params: { slug: collection },
                    timeout: 10000,
                }
            );

            const data = response.data.collections?.[0];
            return data?.floorAsk?.price?.amount?.native || 0;
        } catch {
            // Fallback: return cached or 0
            return this.floorPrices.get(collection)?.floorPrice || 0;
        }
    }

    /**
     * Format price alert for Telegram
     */
    formatPriceAlert(data: {
        collection: string;
        previousFloor: number;
        currentFloor: number;
        changePercent: number;
    }): string {
        const emoji = data.changePercent >= 0 ? '📈' : '📉';
        const direction = data.changePercent >= 0 ? 'UP' : 'DOWN';

        return `${emoji} *Price Alert*\n\n` +
            `📊 Collection: *${data.collection}*\n` +
            `💰 Previous: ${data.previousFloor.toFixed(4)} ETH\n` +
            `💰 Current: ${data.currentFloor.toFixed(4)} ETH\n` +
            `📊 Change: ${direction} ${Math.abs(data.changePercent).toFixed(1)}%`;
    }
}
