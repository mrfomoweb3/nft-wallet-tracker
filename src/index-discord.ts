/**
 * NFT Wallet Tracker — Discord Bot Entry Point
 *
 * Separate from the Telegram bot. Run with:
 *   npm run dev:discord
 *   npm run start:discord
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { configManager, Config } from './config/index.js';
import { initLogger, logger } from './utils/logger.js';
import { WalletManager } from './wallet/index.js';
import { EthereumListener } from './blockchain/index.js';
import { EventProcessor } from './events/index.js';
import { DiscordBot } from './discord/index.js';
import { TradeExecutor } from './trading/index.js';
import { KillSwitch, SpendingTracker, TransactionLogger } from './safety/index.js';
import { UserDatabase } from './database/index.js';
import { PriceTracker } from './alerts/index.js';
import { NFTEvent, TradeResult } from './types/index.js';
import { ethers } from 'ethers';
import { NFTMetadataFetcher } from './utils/NFTMetadataFetcher.js';

const DATA_DIR = process.env.DATA_PATH || './data';

class NFTWalletTrackerDiscord {
    private config!: Config;
    private walletManager!: WalletManager;
    private ethereumListener!: EthereumListener;
    private eventProcessor!: EventProcessor;
    private discordBot!: DiscordBot;
    private tradeExecutor!: TradeExecutor;
    private killSwitch!: KillSwitch;
    private spendingTracker!: SpendingTracker;
    private transactionLogger!: TransactionLogger;
    private userDb!: UserDatabase;
    private priceTracker!: PriceTracker;
    private metadataFetcher!: NFTMetadataFetcher;
    private _running = false;
    public get running(): boolean { return this._running; }

    async initialize(): Promise<void> {
        console.log('🚀 NFT Wallet Tracker (Discord) Starting...\n');

        this.ensureDataDir();
        this.config = configManager.load();

        if (!this.config.discord) {
            console.error('\n❌ Discord configuration missing. Set DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID.\n');
            process.exit(1);
        }

        initLogger({
            level: this.config.logging.level,
            file: this.config.logging.file,
            console: this.config.logging.console,
        });

        logger.info('Configuration loaded (Discord mode)');

        this.initializeDatabase();
        this.initializeSafety();
        this.initializeWallet();
        this.initializeBlockchain();
        this.initializeNotifications();
        this.initializeTrading();
        this.initializeAlerts();

        logger.info('All modules initialized');
    }

    private ensureDataDir(): void {
        const dirs = [DATA_DIR, join(DATA_DIR, 'db'), join(DATA_DIR, 'logs'), join(DATA_DIR, 'wallets')];
        for (const dir of dirs) {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        }
    }

    private initializeDatabase(): void {
        this.userDb = new UserDatabase(join(DATA_DIR, 'db', 'users-discord.json'));
    }

    private initializeSafety(): void {
        this.killSwitch = new KillSwitch(join(DATA_DIR, 'killswitch.json'));
        this.spendingTracker = new SpendingTracker(join(DATA_DIR, 'db', 'spending.db'));
        this.transactionLogger = new TransactionLogger(join(DATA_DIR, 'db', 'transactions.db'));

        this.killSwitch.on('triggered', (state) => logger.warn('Kill switch triggered', state));
        this.killSwitch.on('reset', ({ resetBy }) => logger.info('Kill switch reset', { resetBy }));
    }

    private initializeWallet(): void {
        this.walletManager = new WalletManager(
            join(DATA_DIR, 'wallets', 'encrypted.json'),
            this.config.walletEncryptionPassword,
        );
    }

    private initializeBlockchain(): void {
        this.eventProcessor = new EventProcessor();
        this.eventProcessor.on('event', (event: NFTEvent) => this.handleNFTEvent(event));

        if (this.config.ethereum?.enabled) {
            this.ethereumListener = new EthereumListener(this.config.ethereum);
            this.ethereumListener.on('nft_event', (event: NFTEvent) => this.eventProcessor.process(event));
            this.ethereumListener.on('fatal_error', (error: Error) => {
                logger.error('Fatal blockchain error', { error: error.message });
            });
        }
    }

    private initializeNotifications(): void {
        this.discordBot = new DiscordBot(this.config, this.userDb, this.transactionLogger);

        this.discordBot.onConfirmBuy = async (event: NFTEvent, quantity: number): Promise<TradeResult> => {
            return this.tradeExecutor.executeTrade({
                event,
                quantity,
                maxPrice: event.price,
                slippageTolerance: this.config.trading.slippageTolerance,
                requireConfirmation: false,
            });
        };

        this.discordBot.onToggleKillSwitch = (enable: boolean): void => {
            if (enable) {
                this.killSwitch.trigger('discord_user', 'Manual trigger via Discord');
            } else {
                this.killSwitch.reset('discord_user');
            }
        };

        this.discordBot.onWalletAdded = (address: string): void => {
            if (address.startsWith('0x') && this.ethereumListener) {
                this.ethereumListener.addWallet(address);
                logger.info('Wallet registered with blockchain listener', { address });
            }
        };

        this.discordBot.onWalletRemoved = (address: string): void => {
            if (address.startsWith('0x') && this.ethereumListener) {
                this.ethereumListener.removeWallet(address);
                logger.info('Wallet unregistered from blockchain listener', { address });
            }
        };
    }

    private initializeTrading(): void {
        if (!this.config.trading.enabled || this.config.safety.readOnlyMode) {
            logger.info('Trading is disabled');
            return;
        }

        this.tradeExecutor = new TradeExecutor(
            this.config,
            this.walletManager,
            this.killSwitch,
            this.spendingTracker,
            this.transactionLogger,
        );
    }

    private initializeAlerts(): void {
        this.priceTracker = new PriceTracker(this.userDb);

        const alchemyKey = this.config.ethereum?.rpcUrl?.match(/alchemy\.com\/v2\/([a-zA-Z0-9_-]+)/)?.[1];
        this.metadataFetcher = new NFTMetadataFetcher(alchemyKey);

        this.priceTracker.on('price_alert', async (data) => {
            const message = this.priceTracker.formatPriceAlert(data);
            await this.discordBot.sendPriceAlert(data.userId, message);
        });
    }

    private async handleNFTEvent(event: NFTEvent): Promise<void> {
        logger.info('NFT Event Detected', {
            type: event.type,
            collection: event.contractAddress,
            tokenId: event.tokenId,
            wallet: event.trackedWallet,
        });

        try {
            const metadata = await this.metadataFetcher.getMetadata(event.contractAddress, event.tokenId);
            event.metadata = {
                name: metadata.name,
                collection: metadata.collection,
                image: metadata.imageUrl,
                description: metadata.description,
            };
        } catch (e) {
            logger.error('Metadata fetch failed, sending alert without metadata', { error: e });
        }

        const priceEth = parseFloat(ethers.formatEther(event.price));
        if (priceEth >= 1) {
            await this.discordBot.sendWhaleAlert(event);
        }

        await this.discordBot.sendEventNotification(event);

        this.transactionLogger.log({
            id: event.id,
            type: 'copy_buy',
            chain: event.chain,
            contractAddress: event.contractAddress,
            tokenId: event.tokenId,
            price: event.price,
            ourTxHash: event.txHash,
            timestamp: event.timestamp,
            status: 'pending',
            triggerEvent: event,
        });
    }

    async start(): Promise<void> {
        logger.info('Starting NFT Wallet Tracker (Discord)...');

        let ethConnected = false;
        if (this.ethereumListener) {
            try {
                await this.ethereumListener.connect();
                await this.ethereumListener.startListening();
                ethConnected = true;
            } catch (error) {
                logger.error('Failed to start Ethereum listener', { error: (error as Error).message });
            }
        }

        await this.discordBot.start();

        this.priceTracker.start();
        this.syncTrackedWallets();
        this.discordBot.setEthereumListener(this.ethereumListener);

        this._running = true;
        logger.info('NFT Wallet Tracker (Discord) is running!');

        const walletCount = this.userDb.getAllTrackedWallets().length;
        const startupMessage =
            `🚀 **Bot Started Successfully**\n\n` +
            `⛓ Ethereum: ${ethConnected ? '🟢 Connected' : '🔴 Disconnected'}\n` +
            `👛 Tracked wallets: ${walletCount}\n` +
            `📡 Listening for NFT events...\n\n` +
            `Use /status for live diagnostics.`;

        try {
            await this.discordBot.sendStartupNotification(startupMessage);
        } catch (e) {
            logger.error('Failed to send startup notification', { error: e });
        }
    }

    private syncTrackedWallets(): void {
        const wallets = this.userDb.getAllTrackedWallets();
        for (const wallet of wallets) {
            if (wallet.startsWith('0x') && this.ethereumListener) {
                this.ethereumListener.addWallet(wallet);
            }
        }
        logger.info(`Synced ${wallets.length} tracked wallets`);
    }

    async stop(): Promise<void> {
        logger.info('Stopping NFT Wallet Tracker (Discord)...');
        this.priceTracker?.stop();
        await this.discordBot?.stop();
        await this.ethereumListener?.disconnect();
        this.transactionLogger?.close();
        this.spendingTracker?.close();
        this._running = false;
        logger.info('Stopped');
    }
}

async function main(): Promise<void> {
    const tracker = new NFTWalletTrackerDiscord();

    const shutdown = async () => {
        console.log('\nShutting down...');
        await tracker.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        await tracker.initialize();
        await tracker.start();
    } catch (error: any) {
        if (error.constructor.name === 'ZodError') {
            const issues = (error as any).issues || [];
            console.error('\n❌ CONFIGURATION ERROR: Missing environment variables.\n');
            const missingVars = issues.map((issue: any) => {
                const path = issue.path.join('.');
                if (path === 'discord.botToken') return 'DISCORD_BOT_TOKEN';
                if (path === 'discord.clientId') return 'DISCORD_CLIENT_ID';
                if (path === 'telegram.botToken') return 'TELEGRAM_BOT_TOKEN';
                if (path === 'telegram.chatId') return 'TELEGRAM_CHAT_ID';
                if (path === 'walletEncryptionPassword') return 'WALLET_ENCRYPTION_PASSWORD';
                if (path === 'ethereum.rpcUrl') return 'ETH_RPC_URL';
                return path;
            });
            const uniqueVars = [...new Set(missingVars)];
            uniqueVars.forEach((v: unknown) => console.error(`   - ${v}`));
            console.error('');
            process.exit(1);
        } else {
            console.error('Fatal error:', error);
            process.exit(1);
        }
    }
}

main();
