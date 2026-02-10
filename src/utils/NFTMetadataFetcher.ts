import axios from 'axios';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('metadata');

export interface NFTMetadataResult {
    name: string;
    collection: string;
    imageUrl?: string;
    floorPrice?: number;
    description?: string;
    tokenType?: string;
}

/**
 * NFTMetadataFetcher - Fast NFT metadata lookups via Alchemy NFT API
 */
export class NFTMetadataFetcher {
    private alchemyApiKey?: string;
    private cache: Map<string, NFTMetadataResult> = new Map();
    private cacheTTL: number = 5 * 60 * 1000; // 5 minutes
    private cacheExpiry: Map<string, number> = new Map();

    constructor(alchemyApiKey?: string) {
        this.alchemyApiKey = alchemyApiKey;
    }

    /**
     * Fetch metadata for a specific NFT (fast, single-token lookup)
     */
    async getMetadata(contractAddress: string, tokenId: string): Promise<NFTMetadataResult> {
        // Check cache
        const cacheKey = `${contractAddress.toLowerCase()}:${tokenId}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() < (this.cacheExpiry.get(cacheKey) || 0)) {
            return cached;
        }

        if (!this.alchemyApiKey) {
            return { name: `#${tokenId}`, collection: 'Unknown' };
        }

        try {
            const response = await axios.get(
                `https://eth-mainnet.g.alchemy.com/nft/v3/${this.alchemyApiKey}/getNFTMetadata`,
                {
                    params: {
                        contractAddress,
                        tokenId,
                        refreshCache: false,
                    },
                    timeout: 5000, // 5s timeout for speed
                }
            );

            const data = response.data;
            const result: NFTMetadataResult = {
                name: data.name || data.raw?.metadata?.name || `#${tokenId}`,
                collection: data.contract?.name || data.contract?.openSeaMetadata?.collectionName || 'Unknown',
                imageUrl: data.image?.thumbnailUrl || data.image?.cachedUrl || data.image?.originalUrl,
                floorPrice: data.contract?.openSeaMetadata?.floorPrice,
                description: data.description?.slice(0, 200),
                tokenType: data.contract?.tokenType,
            };

            // Cache it
            this.cache.set(cacheKey, result);
            this.cacheExpiry.set(cacheKey, Date.now() + this.cacheTTL);

            return result;
        } catch (error) {
            logger.error('Failed to fetch NFT metadata', {
                contractAddress,
                tokenId,
                error: (error as Error).message,
            });
            return { name: `#${tokenId}`, collection: 'Unknown' };
        }
    }

    /**
     * Clean up expired cache entries
     */
    cleanCache(): void {
        const now = Date.now();
        for (const [key, expiry] of this.cacheExpiry.entries()) {
            if (now > expiry) {
                this.cache.delete(key);
                this.cacheExpiry.delete(key);
            }
        }
    }
}
