import { JsonRpcProvider } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('gas');

export interface GasPrices {
    low: number;
    average: number;
    high: number;
    baseFee: number;
    timestamp: number;
}

/**
 * GasTracker - Monitor and report gas prices
 */
export class GasTracker {
    private provider: JsonRpcProvider;
    private cachedPrices: GasPrices | null = null;
    private cacheExpiry: number = 0;
    private cacheDuration: number = 15000; // 15 seconds

    constructor(rpcUrl: string) {
        this.provider = new JsonRpcProvider(rpcUrl);
    }

    /**
     * Get current gas prices
     */
    async getGasPrices(): Promise<GasPrices> {
        // Return cached if valid
        if (this.cachedPrices && Date.now() < this.cacheExpiry) {
            return this.cachedPrices;
        }

        try {
            const feeData = await this.provider.getFeeData();
            const baseFee = feeData.gasPrice || 0n;
            const baseFeeGwei = Number(baseFee) / 1e9;

            this.cachedPrices = {
                low: Math.round(baseFeeGwei * 0.9),
                average: Math.round(baseFeeGwei),
                high: Math.round(baseFeeGwei * 1.2),
                baseFee: Math.round(baseFeeGwei),
                timestamp: Date.now(),
            };
            this.cacheExpiry = Date.now() + this.cacheDuration;

            return this.cachedPrices;
        } catch (error) {
            logger.error('Failed to fetch gas prices', { error });
            throw error;
        }
    }

    /**
     * Format gas prices for display
     */
    formatGasPrices(prices: GasPrices): string {
        return `⛽ *Gas Prices*\n\n` +
            `🟢 Low: ${prices.low} gwei\n` +
            `🟡 Average: ${prices.average} gwei\n` +
            `🔴 High: ${prices.high} gwei\n\n` +
            `📊 Base Fee: ${prices.baseFee} gwei`;
    }
}
