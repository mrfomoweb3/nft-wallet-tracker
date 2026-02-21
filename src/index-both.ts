/**
 * NFT Wallet Tracker — Dual Bot Entry Point
 *
 * Runs BOTH Telegram and Discord bots simultaneously on the same backend.
 * Run with:
 *   npm run dev:both
 *   npm run start:both
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { configManager, Config } from './config/index.js';
import { initLogger, logger } from './utils/logger.js';
import { WalletManager } from './wallet/index.js';
import { EthereumListener } from './blockchain/index.js';
import { EventProcessor } from './events/index.js';
import { TelegramBot } from './notifications/index.js';
import { DiscordBot } from './discord/index.js';
import { TradeExecutor } from './trading/index.js';
import { KillSwitch, SpendingTracker, TransactionLogger } from './safety/index.js';
import { UserDatabase } from './database/index.js';
import { PriceTracker } from './alerts/index.js';
import { NFTEvent, TradeResult } from './types/index.js';
import { ethers } from 'ethers';
import { NFTMetadataFetcher } from './utils/NFTMetadataFetcher.js';

const DATA_DIR = process.env.DATA_PATH || './data';

class NFTWalletTrackerBoth {
    private config!: Config;
    private walletManager!: WalletManager;
    private ethereumListener!: EthereumListener;
    private eventProcessor!: EventProcessor;
    private telegramBot!: TelegramBot;
    private discordBot!: DiscordBot;
    private tradeExecutor!: TradeExecutor;
    private killSwitch!: KillSwitch;
    private spendingTracker!: SpendingTracker;
    private transactionLogger!: TransactionLogger;

    // We maintain separate databases for Telegram vs Discord to avoid ID conflicts,
    // though in a full DB they could be merged.
    private userDbTelegram!: UserDatabase;
    private userDbDiscord!: UserDatabase;

    private priceTrackerTelegram!: PriceTracker;
    private priceTrackerDiscord!: PriceTracker;

    private metadataFetcher!: NFTMetadataFetcher;

    private _running = false;
    public get running(): boolean { return this._running; }

    async initialize(): Promise<void> {
        console.log('🚀 NFT Wallet Tracker (DUAL MODE) Starting...\n');

        this.ensureDataDir();
        this.config = configManager.load();

        if (!this.config.telegram) {
            console.error('\n❌ Telegram configuration missing.\n');
            process.exit(1);
        }
        if (!this.config.discord) {
            console.error('\n❌ Discord configuration missing.\n');
            process.exit(1);
        }

        initLogger({
            level: this.config.logging.level,
            file: this.config.logging.file,
            console: this.config.logging.console,
        });

        logger.info('Configuration loaded (Dual mode)');

        this.initializeDatabases();
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

    private initializeDatabases(): void {
        this.userDbTelegram = new UserDatabase(join(DATA_DIR, 'db', 'users.json'));
        this.userDbDiscord = new UserDatabase(join(DATA_DIR, 'db', 'users-discord.json'));
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
        // --- Telegram ---
        this.telegramBot = new TelegramBot(this.config, this.userDbTelegram, this.transactionLogger);

        this.telegramBot.onConfirmBuy = async (event: NFTEvent, quantity: number): Promise<TradeResult> => {
            return this.tradeExecutor.executeTrade({
                event, quantity, maxPrice: event.price, slippageTolerance: this.config.trading.slippageTolerance, requireConfirmation: false,
            });
        };

        this.telegramBot.onToggleKillSwitch = (enable: boolean): void => {
            if (enable) this.killSwitch.trigger('telegram_user', 'Manual trigger via Telegram');
            else this.killSwitch.reset('telegram_user');
        };

        this.telegramBot.onWalletAdded = (address: string): void => {
            if (address.startsWith('0x') && this.ethereumListener) this.ethereumListener.addWallet(address);
        };
        this.telegramBot.onWalletRemoved = (address: string): void => {
            // Need to check if Discord is still tracking it before actually removing
            const inTelegram = this.userDbTelegram.getUsersTrackingWallet(address).length > 0;
            const inDiscord = this.userDbDiscord.getUsersTrackingWallet(address).length > 0;
            if (!inTelegram && !inDiscord && address.startsWith('0x') && this.ethereumListener) {
                this.ethereumListener.removeWallet(address);
            }
        };

        // --- Discord ---
        this.discordBot = new DiscordBot(this.config, this.userDbDiscord, this.transactionLogger);

        this.discordBot.onConfirmBuy = async (event: NFTEvent, quantity: number): Promise<TradeResult> => {
            return this.tradeExecutor.executeTrade({
                event, quantity, maxPrice: event.price, slippageTolerance: this.config.trading.slippageTolerance, requireConfirmation: false,
            });
        };

        this.discordBot.onToggleKillSwitch = (enable: boolean): void => {
            if (enable) this.killSwitch.trigger('discord_user', 'Manual trigger via Discord');
            else this.killSwitch.reset('discord_user');
        };

        this.discordBot.onWalletAdded = (address: string): void => {
            if (address.startsWith('0x') && this.ethereumListener) this.ethereumListener.addWallet(address);
        };
        this.discordBot.onWalletRemoved = (address: string): void => {
            const inTelegram = this.userDbTelegram.getUsersTrackingWallet(address).length > 0;
            const inDiscord = this.userDbDiscord.getUsersTrackingWallet(address).length > 0;
            if (!inTelegram && !inDiscord && address.startsWith('0x') && this.ethereumListener) {
                this.ethereumListener.removeWallet(address);
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
        this.priceTrackerTelegram = new PriceTracker(this.userDbTelegram);
        this.priceTrackerDiscord = new PriceTracker(this.userDbDiscord);

        const alchemyKey = this.config.ethereum?.rpcUrl?.match(/alchemy\.com\/v2\/([a-zA-Z0-9_-]+)/)?.[1];
        this.metadataFetcher = new NFTMetadataFetcher(alchemyKey);

        this.priceTrackerTelegram.on('price_alert', async (data) => {
            const message = this.priceTrackerTelegram.formatPriceAlert(data);
            await this.telegramBot.sendPriceAlert(data.userId, message);
        });

        this.priceTrackerDiscord.on('price_alert', async (data) => {
            const message = this.priceTrackerDiscord.formatPriceAlert(data);
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
            await Promise.all([
                this.telegramBot.sendWhaleAlert(event),
                this.discordBot.sendWhaleAlert(event)
            ]);
        }

        await Promise.all([
            this.telegramBot.sendEventNotification(event),
            this.discordBot.sendEventNotification(event)
        ]);

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
        logger.info('Starting NFT Wallet Tracker (DUAL: Telegram + Discord)...');

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

        // Start bots
        await Promise.all([
            this.telegramBot.start(),
            this.discordBot.start()
        ]);

        this.priceTrackerTelegram.start();
        this.priceTrackerDiscord.start();

        this.syncTrackedWallets();

        this.telegramBot.setEthereumListener(this.ethereumListener);
        this.discordBot.setEthereumListener(this.ethereumListener);

        this._running = true;
        logger.info('NFT Wallet Tracker DUAL MODE is running!');

        const tWallets = this.userDbTelegram.getAllTrackedWallets().length;
        const dWallets = this.userDbDiscord.getAllTrackedWallets().length;

        const startupMessage =
            `🚀 **Bot Started Successfully (Dual Mode)**\n\n` +
            `⛓ Ethereum: ${ethConnected ? '🟢 Connected' : '🔴 Disconnected'}\n` +
            `👛 Tracked wallets: ${tWallets + dWallets}\n` +
            `📡 Listening for NFT events...`;

        try {
            await Promise.all([
                this.telegramBot.sendStartupNotification(startupMessage).catch(() => { }),
                this.discordBot.sendStartupNotification(startupMessage).catch(() => { })
            ]);
        } catch (e) {
            logger.error('Failed to send startup notification', { error: e });
        }
    }

    private syncTrackedWallets(): void {
        const wallets = new Set([
            ...this.userDbTelegram.getAllTrackedWallets(),
            ...this.userDbDiscord.getAllTrackedWallets()
        ]);

        for (const wallet of wallets) {
            if (wallet.startsWith('0x') && this.ethereumListener) {
                this.ethereumListener.addWallet(wallet);
            }
        }
        logger.info(`Synced ${wallets.size} unique tracked wallets across both bots`);
    }

    async stop(): Promise<void> {
        logger.info('Stopping NFT Wallet Tracker (Dual Mode)...');
        this.priceTrackerTelegram?.stop();
        this.priceTrackerDiscord?.stop();

        await Promise.all([
            this.telegramBot?.stop(),
            this.discordBot?.stop()
        ]);

        await this.ethereumListener?.disconnect();
        this.transactionLogger?.close();
        this.spendingTracker?.close();
        this._running = false;
        logger.info('Stopped');
    }
}

async function main(): Promise<void> {
    const tracker = new NFTWalletTrackerBoth();

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
