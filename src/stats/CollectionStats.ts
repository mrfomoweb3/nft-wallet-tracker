import axios from 'axios';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('stats');

export interface CollectionData {
    name: string;
    contractAddress: string;
    floorPrice: number;
    totalVolume: number;
    owners: number;
    totalSupply: number;
    imageUrl?: string;
    oneDayChange: number;
    sevenDayChange: number;
}

/**
 * CollectionStats - Fetch collection statistics
 */
export class CollectionStats {
    private cache: Map<string, { data: CollectionData; expiry: number }> = new Map();
    private cacheDuration: number = 5 * 60 * 1000; // 5 minutes

    /**
     * Get collection stats by slug or contract address
     */
    async getStats(collectionIdentifier: string): Promise<CollectionData | null> {
        const cacheKey = collectionIdentifier.toLowerCase();

        // Check cache
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
            return cached.data;
        }

        try {
            // Try OpenSea API (free tier)
            const isAddress = collectionIdentifier.startsWith('0x');
            const url = isAddress
                ? `https://api.opensea.io/api/v2/chain/ethereum/contract/${collectionIdentifier}`
                : `https://api.opensea.io/api/v2/collections/${collectionIdentifier}`;

            const response = await axios.get(url, {
                headers: {
                    'Accept': 'application/json',
                },
                timeout: 10000,
            });

            const data = response.data;

            const stats: CollectionData = {
                name: data.name || data.collection || 'Unknown',
                contractAddress: data.address || collectionIdentifier,
                floorPrice: data.floor_price || 0,
                totalVolume: data.total_volume || 0,
                owners: data.num_owners || 0,
                totalSupply: data.total_supply || 0,
                imageUrl: data.image_url,
                oneDayChange: data.one_day_change || 0,
                sevenDayChange: data.seven_day_change || 0,
            };

            // Cache result
            this.cache.set(cacheKey, { data: stats, expiry: Date.now() + this.cacheDuration });

            return stats;
        } catch (error) {
            logger.error('Failed to fetch collection stats', { error, collection: collectionIdentifier });

            // Return mock data for demo
            return {
                name: collectionIdentifier,
                contractAddress: collectionIdentifier.startsWith('0x') ? collectionIdentifier : 'N/A',
                floorPrice: 0,
                totalVolume: 0,
                owners: 0,
                totalSupply: 0,
                oneDayChange: 0,
                sevenDayChange: 0,
            };
        }
    }

    /**
     * Format collection stats for Telegram
     */
    formatStats(stats: CollectionData): string {
        const changeEmoji = (change: number) => change >= 0 ? '📈' : '📉';
        const formatChange = (change: number) => `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;

        return `📊 *Collection Stats*\n\n` +
            `🎨 *${stats.name}*\n\n` +
            `💰 Floor: ${stats.floorPrice.toFixed(4)} ETH\n` +
            `📦 Supply: ${stats.totalSupply.toLocaleString()}\n` +
            `👥 Owners: ${stats.owners.toLocaleString()}\n` +
            `📈 Volume: ${stats.totalVolume.toFixed(2)} ETH\n\n` +
            `${changeEmoji(stats.oneDayChange)} 24h: ${formatChange(stats.oneDayChange)}\n` +
            `${changeEmoji(stats.sevenDayChange)} 7d: ${formatChange(stats.sevenDayChange)}`;
    }
}
