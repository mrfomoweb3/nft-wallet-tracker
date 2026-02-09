import axios from 'axios';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('portfolio');

export interface NFTHolding {
    contractAddress: string;
    tokenId: string;
    name: string;
    collection: string;
    imageUrl?: string;
    floorPrice?: number;
}

export interface PortfolioSummary {
    totalNFTs: number;
    estimatedValue: number;
    holdings: NFTHolding[];
}

/**
 * PortfolioTracker - Track NFT holdings and value
 */
export class PortfolioTracker {
    private alchemyApiKey?: string;

    constructor(alchemyApiKey?: string) {
        this.alchemyApiKey = alchemyApiKey;
    }

    /**
     * Get NFT portfolio for a wallet
     */
    async getPortfolio(walletAddress: string): Promise<PortfolioSummary> {
        if (!this.alchemyApiKey) {
            return {
                totalNFTs: 0,
                estimatedValue: 0,
                holdings: [],
            };
        }

        try {
            const response = await axios.get(
                `https://eth-mainnet.g.alchemy.com/nft/v3/${this.alchemyApiKey}/getNFTsForOwner`,
                {
                    params: {
                        owner: walletAddress,
                        withMetadata: true,
                        pageSize: 100,
                    },
                }
            );

            const nfts = response.data.ownedNfts || [];
            const holdings: NFTHolding[] = nfts.map((nft: Record<string, unknown>) => ({
                contractAddress: (nft.contract as Record<string, unknown>)?.address || '',
                tokenId: nft.tokenId || '',
                name: (nft.name as string) || `#${nft.tokenId}`,
                collection: (nft.contract as Record<string, unknown>)?.name || 'Unknown',
                imageUrl: ((nft.image as Record<string, unknown>)?.thumbnailUrl as string) || undefined,
                floorPrice: (nft.contract as Record<string, unknown>)?.openSeaMetadata
                    ? ((nft.contract as Record<string, unknown>).openSeaMetadata as Record<string, unknown>)?.floorPrice as number
                    : undefined,
            }));

            const estimatedValue = holdings.reduce((sum, h) => sum + (h.floorPrice || 0), 0);

            return {
                totalNFTs: holdings.length,
                estimatedValue,
                holdings: holdings.slice(0, 20), // Limit to 20 for display
            };
        } catch (error) {
            logger.error('Failed to fetch portfolio', { error, wallet: walletAddress });
            return { totalNFTs: 0, estimatedValue: 0, holdings: [] };
        }
    }

    /**
     * Format portfolio for Telegram display
     */
    formatPortfolio(portfolio: PortfolioSummary, walletAddress: string): string {
        const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;

        let message = `💼 *Portfolio for ${shortAddr}*\n\n`;
        message += `📦 Total NFTs: ${portfolio.totalNFTs}\n`;
        message += `💰 Est. Value: ${portfolio.estimatedValue.toFixed(2)} ETH\n\n`;

        if (portfolio.holdings.length === 0) {
            message += '_No NFTs found_';
        } else {
            message += '*Holdings:*\n';
            for (const nft of portfolio.holdings.slice(0, 10)) {
                const value = nft.floorPrice ? ` (${nft.floorPrice.toFixed(3)} ETH)` : '';
                message += `• ${nft.collection}: ${nft.name}${value}\n`;
            }
            if (portfolio.holdings.length > 10) {
                message += `\n_...and ${portfolio.holdings.length - 10} more_`;
            }
        }

        return message;
    }
}
