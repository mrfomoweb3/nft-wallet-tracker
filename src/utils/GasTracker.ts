import { JsonRpcProvider } from 'ethers';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('gas');

export interface GasPrices {
    low: number;
    average: number;
    high: number;
    baseFee: number;
    nextBaseFee: number;
    lastBlock: number;
    timestamp: number;
}

/**
 * GasTracker - Real-time Ethereum gas price monitoring
 * Uses eth_feeHistory for accurate priority fee percentiles
 */
export class GasTracker {
    private provider: JsonRpcProvider;
    private cachedPrices: GasPrices | null = null;
    private cacheExpiry: number = 0;
    private cacheDuration: number = 12000; // ~1 block

    constructor(rpcUrl: string) {
        this.provider = new JsonRpcProvider(rpcUrl);
    }

    /**
     * Get current gas prices using eth_feeHistory
     */
    async getGasPrices(): Promise<GasPrices> {
        // Return cached if valid
        if (this.cachedPrices && Date.now() < this.cacheExpiry) {
            return this.cachedPrices;
        }

        try {
            // Fetch fee history for the last 10 blocks with 25th, 50th, 75th percentile priority fees
            const feeHistory = await this.provider.send('eth_feeHistory', [
                '0xA',       // 10 blocks
                'latest',
                [25, 50, 75] // percentiles for priority fees
            ]);

            const baseFees: bigint[] = feeHistory.baseFeePerGas.map((hex: string) => BigInt(hex));
            const rewards: bigint[][] = feeHistory.reward.map(
                (block: string[]) => block.map((hex: string) => BigInt(hex))
            );

            // Next block's base fee (last element in baseFeePerGas)
            const nextBaseFee = baseFees[baseFees.length - 1];
            const currentBaseFee = baseFees[baseFees.length - 2];
            const lastBlock = Number(BigInt(feeHistory.oldestBlock)) + baseFees.length - 2;

            // Calculate median priority fees across recent blocks
            const lowPriority = this.medianBigInt(rewards.map((r: bigint[]) => r[0]));  // 25th percentile
            const avgPriority = this.medianBigInt(rewards.map((r: bigint[]) => r[1]));  // 50th percentile
            const highPriority = this.medianBigInt(rewards.map((r: bigint[]) => r[2])); // 75th percentile

            // Total gas price = base fee + priority fee
            const toGwei = (wei: bigint): number => Math.round(Number(wei) / 1e9 * 10) / 10;

            this.cachedPrices = {
                low: toGwei(nextBaseFee + lowPriority),
                average: toGwei(nextBaseFee + avgPriority),
                high: toGwei(nextBaseFee + highPriority),
                baseFee: toGwei(currentBaseFee),
                nextBaseFee: toGwei(nextBaseFee),
                lastBlock,
                timestamp: Date.now(),
            };
            this.cacheExpiry = Date.now() + this.cacheDuration;

            return this.cachedPrices;
        } catch (error) {
            logger.error('Failed to fetch gas prices via feeHistory, falling back', { error });
            return this.getFallbackPrices();
        }
    }

    /**
     * Fallback using basic getFeeData
     */
    private async getFallbackPrices(): Promise<GasPrices> {
        const feeData = await this.provider.getFeeData();
        const block = await this.provider.getBlockNumber();
        const baseFee = feeData.gasPrice || 0n;
        const baseFeeGwei = Math.round(Number(baseFee) / 1e9 * 10) / 10;
        const maxPriority = feeData.maxPriorityFeePerGas || 0n;
        const priorityGwei = Math.round(Number(maxPriority) / 1e9 * 10) / 10;

        this.cachedPrices = {
            low: Math.round((baseFeeGwei + priorityGwei * 0.8) * 10) / 10,
            average: Math.round((baseFeeGwei + priorityGwei) * 10) / 10,
            high: Math.round((baseFeeGwei + priorityGwei * 1.5) * 10) / 10,
            baseFee: baseFeeGwei,
            nextBaseFee: baseFeeGwei,
            lastBlock: block,
            timestamp: Date.now(),
        };
        this.cacheExpiry = Date.now() + this.cacheDuration;

        return this.cachedPrices;
    }

    /**
     * Calculate median of BigInt array
     */
    private medianBigInt(arr: bigint[]): bigint {
        const sorted = [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return (sorted[mid - 1] + sorted[mid]) / 2n;
        }
        return sorted[mid];
    }

    /**
     * Format gas prices for display
     */
    formatGasPrices(prices: GasPrices): string {
        const age = Math.round((Date.now() - prices.timestamp) / 1000);

        return `⛽ *Gas Prices (Live)*\n\n` +
            `🟢 Low: *${prices.low}* gwei\n` +
            `🟡 Average: *${prices.average}* gwei\n` +
            `🔴 High: *${prices.high}* gwei\n\n` +
            `📊 Base Fee: ${prices.baseFee} gwei\n` +
            `📈 Next Base Fee: ${prices.nextBaseFee} gwei\n` +
            `🧱 Block: #${prices.lastBlock.toLocaleString()}\n` +
            `🕐 Updated: ${age}s ago`;
    }
}
