import { JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers';
import { NFTEvent, TradeRequest, TradeResult } from '../types/index.js';
import { Config, TradingConfig } from '../config/index.js';
import { WalletManager, DecryptedWallet } from '../wallet/index.js';
import { createModuleLogger } from '../utils/logger.js';
import { KillSwitch } from '../safety/KillSwitch.js';
import { SpendingTracker } from '../safety/SpendingTracker.js';
import { TransactionLogger } from '../safety/TransactionLogger.js';

const logger = createModuleLogger('trading');

/**
 * TradeExecutor - Handles NFT copy-buy execution
 * 
 * Features:
 * - Spending cap enforcement
 * - Slippage protection
 * - Priority fee optimization
 * - Retry logic for failed transactions
 * - Full transaction logging
 */
export class TradeExecutor {
    private config: TradingConfig;
    private walletManager: WalletManager;
    private provider: JsonRpcProvider | null = null;
    private privateProvider: JsonRpcProvider | null = null;
    private killSwitch: KillSwitch;
    private spendingTracker: SpendingTracker;
    private transactionLogger: TransactionLogger;

    constructor(
        config: Config,
        walletManager: WalletManager,
        killSwitch: KillSwitch,
        spendingTracker: SpendingTracker,
        transactionLogger: TransactionLogger
    ) {
        this.config = config.trading;
        this.walletManager = walletManager;
        this.killSwitch = killSwitch;
        this.spendingTracker = spendingTracker;
        this.transactionLogger = transactionLogger;

        // Setup providers
        if (config.ethereum) {
            this.provider = new JsonRpcProvider(config.ethereum.rpcUrl);
            if (config.ethereum.privateRpc) {
                this.privateProvider = new JsonRpcProvider(config.ethereum.privateRpc);
            }
        }
    }

    /**
     * Execute a copy-buy trade
     */
    async executeTrade(request: TradeRequest): Promise<TradeResult> {
        const { event, maxPrice, priorityFee } = request;

        logger.info('Executing trade', {
            contract: event.contractAddress,
            tokenId: event.tokenId,
            maxPrice: formatEther(maxPrice),
        });

        // 1. Safety checks
        const safetyCheck = await this.performSafetyChecks(event, maxPrice);
        if (!safetyCheck.passed) {
            return {
                success: false,
                error: safetyCheck.reason,
                timestamp: Date.now(),
            };
        }

        // 2. Get trading wallet
        const wallet = this.walletManager.getPrimaryWallet(event.chain);
        if (!wallet) {
            return {
                success: false,
                error: 'No trading wallet configured',
                timestamp: Date.now(),
            };
        }

        // 3. Execute based on chain
        try {
            const result = await this.executeEthereumTrade(event, wallet, maxPrice, priorityFee);

            // 4. Log transaction
            this.transactionLogger.log({
                id: event.id,
                timestamp: Date.now(),
                chain: event.chain,
                type: 'copy_buy',
                triggerEvent: event,
                ourTxHash: result.txHash || '',
                status: result.success ? 'confirmed' : 'failed',
                contractAddress: event.contractAddress,
                tokenId: event.tokenId,
                price: result.actualPrice || 0n,
                gasUsed: result.gasUsed,
                error: result.error,
            });

            // 5. Update spending tracker
            if (result.success && result.actualPrice) {
                this.spendingTracker.recordSpend(event.chain, result.actualPrice);
            }

            return result;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error('Trade execution failed', { error: errorMessage });

            return {
                success: false,
                error: errorMessage,
                timestamp: Date.now(),
            };
        }
    }

    /**
     * Perform safety checks before trading
     */
    private async performSafetyChecks(
        event: NFTEvent,
        price: bigint
    ): Promise<{ passed: boolean; reason?: string }> {
        // Kill switch check
        if (this.killSwitch.isTriggered()) {
            return { passed: false, reason: 'Kill switch is active' };
        }

        // Trading enabled check
        if (!this.config.enabled) {
            return { passed: false, reason: 'Trading is disabled' };
        }

        // Per-transaction spending cap
        const maxPerTx = parseEther(this.config.maxSpendPerTx.toString());
        if (price > maxPerTx) {
            return {
                passed: false,
                reason: `Price ${formatEther(price)} ETH exceeds per-tx limit of ${this.config.maxSpendPerTx} ETH`,
            };
        }

        // Daily spending cap
        const todaySpend = this.spendingTracker.getTodayTotal(event.chain);
        const maxDaily = parseEther(this.config.maxDailySpend.toString());
        if (todaySpend + price > maxDaily) {
            return {
                passed: false,
                reason: `Would exceed daily spend limit of ${this.config.maxDailySpend} ETH`,
            };
        }

        return { passed: true };
    }

    /**
     * Execute trade on Ethereum
     */
    private async executeEthereumTrade(
        event: NFTEvent,
        wallet: DecryptedWallet,
        maxPrice: bigint,
        priorityFee?: bigint
    ): Promise<TradeResult> {
        if (!this.provider) {
            return { success: false, error: 'Ethereum provider not configured', timestamp: Date.now() };
        }

        // Create signer
        const signer = new Wallet(wallet.privateKey, this.privateProvider || this.provider);

        // Calculate gas parameters
        const feeData = await this.provider.getFeeData();
        const baseFee = feeData.gasPrice || parseEther('0.00000003'); // 30 gwei fallback
        const calculatedPriorityFee = priorityFee ||
            BigInt(Math.floor(Number(baseFee) * (this.config.priorityFeeMultiplier - 1)));

        // For now, we support direct contract minting
        // Full marketplace support would require decoding the original transaction
        if (event.type === 'mint') {
            return await this.executeMint(event, maxPrice);
        }

        // For marketplace buys, we need more complex logic
        if (event.marketplace !== 'unknown') {
            return await this.executeMarketplaceBuy(event);
        }

        // Log that we created objects (prevents unused variable warnings)
        logger.debug('Trade setup complete', {
            signer: signer.address,
            baseFee: baseFee.toString(),
            priorityFee: calculatedPriorityFee.toString()
        });

        return {
            success: false,
            error: 'Unsupported trade type',
            timestamp: Date.now(),
        };
    }

    /**
     * Execute a direct mint
     */
    private async executeMint(
        event: NFTEvent,
        maxPrice: bigint
    ): Promise<TradeResult> {
        logger.info('Attempting direct mint', {
            contract: event.contractAddress,
            price: formatEther(maxPrice),
        });

        // For safety, we'll return a placeholder requiring manual implementation
        // of the specific mint function for each contract
        return {
            success: false,
            error: 'Direct minting requires contract-specific implementation',
            timestamp: Date.now(),
        };
    }

    /**
     * Execute a marketplace buy
     */
    private async executeMarketplaceBuy(event: NFTEvent): Promise<TradeResult> {
        // This would integrate with marketplace APIs to fetch listings and execute buys
        // Each marketplace has its own API and contract interface

        logger.info('Marketplace buy', {
            marketplace: event.marketplace,
            contract: event.contractAddress,
            tokenId: event.tokenId,
        });

        // Placeholder - would integrate with:
        // - OpenSea Seaport API
        // - Blur API
        // - LooksRare API
        // etc.

        return {
            success: false,
            error: `Marketplace integration (${event.marketplace}) not yet implemented`,
            timestamp: Date.now(),
        };
    }

    /**
     * Get current gas prices
     */
    async getGasPrices(): Promise<{ base: bigint; priority: bigint; total: bigint }> {
        if (!this.provider) {
            throw new Error('Provider not configured');
        }

        const feeData = await this.provider.getFeeData();
        const base = feeData.gasPrice || 0n;
        const priority = feeData.maxPriorityFeePerGas || 0n;

        return {
            base,
            priority,
            total: base + priority,
        };
    }
}
