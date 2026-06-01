import { Bot, Context, InlineKeyboard, session } from 'grammy';
import { NFTEvent, TradeResult } from '../types/index.js';
import { Config } from '../config/index.js';
import { createModuleLogger } from '../utils/logger.js';
import { formatNotification, formatTradeResult } from './formatters.js';
import { UserDatabase, User } from '../database/UserDatabase.js';
import { GasTracker } from '../utils/GasTracker.js';
import { PortfolioTracker } from '../portfolio/PortfolioTracker.js';
import { CollectionStats } from '../stats/CollectionStats.js';
import { TransactionLogger } from '../safety/TransactionLogger.js';
import { EthereumListener } from '../blockchain/index.js';

const logger = createModuleLogger('telegram');

interface SessionData {
    awaitingConfirmation?: {
        eventId: string;
        event: NFTEvent;
        expiresAt: number;
    };
}

type BotContext = Context & { session: SessionData };

/**
 * TelegramBot - Full-featured multi-user NFT tracking bot
 */
export class TelegramBot {
    private bot: Bot<BotContext>;
    private isRunning: boolean = false;

    // Dependencies
    private userDb: UserDatabase;
    private gasTracker: GasTracker;
    private portfolioTracker: PortfolioTracker;
    private collectionStats: CollectionStats;
    private transactionLogger: TransactionLogger;
    private ethereumListener: EthereumListener | null = null;

    // Callbacks
    public onConfirmBuy?: (event: NFTEvent, quantity: number) => Promise<TradeResult>;
    public onCancelBuy?: (eventId: string) => void;
    public onToggleKillSwitch?: (enable: boolean) => void;
    public onWalletAdded?: (address: string) => void;
    public onWalletRemoved?: (address: string) => void;

    constructor(
        config: Config,
        userDb: UserDatabase,
        transactionLogger: TransactionLogger
    ) {
        this.userDb = userDb;
        this.transactionLogger = transactionLogger;

        // Initialize feature modules
        this.gasTracker = new GasTracker(config.ethereum?.rpcUrl || '');
        this.portfolioTracker = new PortfolioTracker(this.extractAlchemyKey(config.ethereum?.rpcUrl));
        this.collectionStats = new CollectionStats();
        // Create bot
        this.bot = new Bot<BotContext>(config.telegram.botToken);

        // Setup middleware
        this.bot.use(session({ initial: (): SessionData => ({}) }));

        // Setup commands
        this.setupCommands();
        this.setupCallbacks();
    }

    private extractAlchemyKey(rpcUrl?: string): string | undefined {
        if (!rpcUrl) return undefined;
        const match = rpcUrl.match(/alchemy\.com\/v2\/([a-zA-Z0-9_-]+)/);
        return match?.[1];
    }

    private setupCommands(): void {
        // /start - Register and welcome
        this.bot.command('start', async (ctx) => {
            const user = this.userDb.getOrCreateUser(
                ctx.from!.id,
                ctx.from?.username,
                ctx.from?.first_name
            );

            await ctx.reply(
                `🚀 *NFT Wallet Tracker Bot*\n\n` +
                `Welcome${user.firstName ? `, ${user.firstName}` : ''}!\n\n` +
                `*Tracking:*\n` +
                `/track <address> - Track a wallet\n` +
                `/untrack <address> - Stop tracking\n` +
                `/wallets - List tracked wallets\n` +
                `/autobuy - Toggle auto-buy\n` +
                `/portfolio - View NFT holdings\n\n` +
                `*Alerts:*\n` +
                `/alert <collection> <percent> - Price alerts\n` +
                `/gas - Current gas prices\n` +
                `/stats <collection> - Collection stats\n\n` +
                `*Utilities:*\n` +
                `/status - Bot status\n` +
                `/history - Transaction history\n` +
                `/killswitch - Emergency stop\n` +
                `/test - Send test alert`,
                { parse_mode: 'Markdown' }
            );
        });

        // /help
        this.bot.command('help', async (ctx) => {
            await ctx.reply(
                `📖 *Help Guide*\n\n` +
                `*Wallet Tracking:*\n` +
                `Track whale wallets and get notified of their NFT activity.\n\n` +
                `*Auto-Buy:*\n` +
                `When enabled, automatically copy-buy NFTs that tracked wallets purchase.\n\n` +
                `*Price Alerts:*\n` +
                `Get notified when a collection's floor price changes by X%.\n\n` +
                `*Snipe Mode:*\n` +
                `Auto-buy listings below your set price.`,
                { parse_mode: 'Markdown' }
            );
        });

        // /tier - Account info
        this.bot.command('tier', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);
            const limit = this.userDb.getWalletLimit();

            await ctx.reply(
                `✅ *Your Account*\n\n` +
                `Wallets: ${user.wallets.length}/${limit}\n` +
                `Price Alerts: ✅\n` +
                `Snipe Mode: ✅\n` +
                `Portfolio: ✅`,
                { parse_mode: 'Markdown' }
            );
        });

        // /upgrade
        this.bot.command('upgrade', async (ctx) => {
            await ctx.reply('✅ All features are already unlocked!');
        });

        // /track <address>
        this.bot.command('track', async (ctx) => {
            const address = ctx.match?.trim();
            if (!address) {
                await ctx.reply('Usage: `/track 0x123...`', { parse_mode: 'Markdown' });
                return;
            }

            if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
                await ctx.reply('❌ Invalid Ethereum address format.');
                return;
            }

            // Auto-register user if they haven't run /start
            this.userDb.getOrCreateUser(ctx.from!.id, ctx.from?.username, ctx.from?.first_name);

            const result = this.userDb.addWallet(ctx.from!.id, address);
            if (result.success) {
                // Register with blockchain listener for real-time monitoring
                if (this.onWalletAdded) this.onWalletAdded(address);
                await ctx.reply(`✅ Now tracking:\n\`${address}\``, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(`❌ ${result.error}`);
            }
        });

        // /bulkimport <address1>, <address2>, ...
        this.bot.command('bulkimport', async (ctx) => {
            const input = ctx.match?.trim();
            if (!input) {
                await ctx.reply(
                    '*Bulk Import*\n\n' +
                    'Usage: `/bulkimport 0x123..., 0x456..., 0x789...`\n\n' +
                    'Separate addresses with commas, spaces, or new lines.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            this.userDb.getOrCreateUser(ctx.from!.id, ctx.from?.username, ctx.from?.first_name);

            const candidates = input.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
            const valid = candidates.filter(s => /^0x[a-fA-F0-9]{40}$/.test(s));
            const invalid = candidates.filter(s => !/^0x[a-fA-F0-9]{40}$/.test(s));

            if (valid.length === 0) {
                await ctx.reply('❌ No valid Ethereum addresses found.');
                return;
            }

            const added: string[] = [];
            const skipped: string[] = [];
            const failed: { address: string; reason: string }[] = [];

            for (const address of valid) {
                const result = this.userDb.addWallet(ctx.from!.id, address);
                if (result.success) {
                    if (this.onWalletAdded) this.onWalletAdded(address);
                    added.push(address);
                } else if (result.error?.includes('Already tracking')) {
                    skipped.push(address);
                } else {
                    failed.push({ address, reason: result.error || 'Unknown error' });
                }
            }

            let message = '📥 *Bulk Import Results*\n\n';
            if (added.length > 0) {
                message += `✅ *Added (${added.length}):*\n${added.map(a => `\`${a}\``).join('\n')}\n\n`;
            }
            if (skipped.length > 0) {
                message += `⏭ *Already tracking (${skipped.length}):*\n${skipped.map(a => `\`${a}\``).join('\n')}\n\n`;
            }
            if (failed.length > 0) {
                message += `❌ *Failed (${failed.length}):*\n${failed.map(f => `\`${f.address}\` — ${f.reason}`).join('\n')}\n\n`;
            }
            if (invalid.length > 0) {
                message += `⚠️ *Invalid format (${invalid.length}):*\n${invalid.map(s => `\`${s}\``).join('\n')}`;
            }

            await ctx.reply(message.trim(), { parse_mode: 'Markdown' });
        });

        // /untrack <address>
        this.bot.command('untrack', async (ctx) => {
            const address = ctx.match?.trim();
            if (!address) {
                await ctx.reply('Usage: `/untrack 0x123...`', { parse_mode: 'Markdown' });
                return;
            }

            // Auto-register user if they haven't run /start
            this.userDb.getOrCreateUser(ctx.from!.id, ctx.from?.username, ctx.from?.first_name);

            const success = this.userDb.removeWallet(ctx.from!.id, address);
            if (success) {
                // Check if any other user is still tracking this wallet
                const stillTracked = this.userDb.getUsersTrackingWallet(address).length > 0;
                if (!stillTracked && this.onWalletRemoved) {
                    this.onWalletRemoved(address);
                }
                await ctx.reply(`✅ Stopped tracking:\n\`${address}\``, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply('❌ Wallet not found in your tracking list.');
            }
        });

        // /wallets - List user's wallets
        this.bot.command('wallets', async (ctx) => {
            const wallets = this.userDb.getUserWallets(ctx.from!.id);

            if (wallets.length === 0) {
                await ctx.reply('📭 No wallets tracked.\n\nUse `/track <address>` to add one.', { parse_mode: 'Markdown' });
                return;
            }

            await ctx.reply(
                `👛 *Your Tracked Wallets* (${wallets.length})\n\n` +
                wallets.map((w, i) => `${i + 1}. \`${w}\``).join('\n'),
                { parse_mode: 'Markdown' }
            );
        });

        // /autobuy - Toggle auto-buy
        this.bot.command('autobuy', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);
            const status = user.settings.autoBuyEnabled ? '🟢 ON' : '🔴 OFF';

            const keyboard = new InlineKeyboard()
                .text('🟢 Turn ON', 'autobuy_on')
                .text('🔴 Turn OFF', 'autobuy_off');

            await ctx.reply(
                `🤖 *Auto-Buy Control*\n\n` +
                `Current: ${status}\n\n` +
                `When ON, bot automatically buys NFTs when tracked wallets buy/mint.`,
                { parse_mode: 'Markdown', reply_markup: keyboard }
            );
        });

        // /status - Bot status with blockchain diagnostics
        this.bot.command('status', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);
            const stats = this.userDb.getUserCount();
            const txStats = this.transactionLogger.getStats();

            let ethStatus = '⚪ Not configured';
            let blockInfo = '';
            if (this.ethereumListener) {
                const diag = this.ethereumListener.getDiagnostics();
                ethStatus = diag.connected ? '🟢 Connected' : '🔴 Disconnected';
                blockInfo =
                    `\n📦 Blocks processed: ${diag.blocksProcessed}` +
                    `\n🔢 Last block: ${diag.lastBlockNumber || 'none'}` +
                    `\n🎯 Events detected: ${diag.eventsDetected}` +
                    `\n👛 Wallets monitored: ${diag.trackedWalletCount}`;
                if (diag.trackedWallets.length > 0) {
                    blockInfo += `\n📋 Wallets: ${diag.trackedWallets.map(w => w.slice(0, 8) + '...').join(', ')}`;
                }
                if (diag.lastError) {
                    blockInfo += `\n⚠️ Last error: ${diag.lastError.slice(0, 100)}`;
                }
            }

            await ctx.reply(
                `📊 *Bot Status*\n\n` +
                `👛 Your wallets: ${user.wallets.length}\n` +
                `🤖 Auto-buy: ${user.settings.autoBuyEnabled ? '🟢' : '🔴'}\n\n` +
                `⛓ *Ethereum Listener:* ${ethStatus}${blockInfo}\n\n` +
                `📈 *Stats:*\n` +
                `Users: ${stats.total}\n` +
                `Transactions: ${txStats.total}\n` +
                `Confirmed: ${txStats.confirmed}`,
                { parse_mode: 'Markdown' }
            );
        });

        // /gas - Gas prices
        this.bot.command('gas', async (ctx) => {
            try {
                const prices = await this.gasTracker.getGasPrices();
                await ctx.reply(this.gasTracker.formatGasPrices(prices), { parse_mode: 'Markdown' });
            } catch {
                await ctx.reply('❌ Failed to fetch gas prices.');
            }
        });

        // /stats <collection> - Collection stats
        this.bot.command('stats', async (ctx) => {
            const collection = ctx.match?.trim();
            if (!collection) {
                await ctx.reply('Usage: `/stats boredapeyachtclub` or `/stats 0x123...`', { parse_mode: 'Markdown' });
                return;
            }

            await ctx.reply('🔍 Fetching stats...');

            const stats = await this.collectionStats.getStats(collection);
            if (stats) {
                await ctx.reply(this.collectionStats.formatStats(stats), { parse_mode: 'Markdown' });
            } else {
                await ctx.reply('❌ Collection not found.');
            }
        });

        // /portfolio
        this.bot.command('portfolio', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);

            if (user.wallets.length === 0) {
                await ctx.reply('📭 No wallets to show portfolio for.\n\nUse `/track <address>` first.', { parse_mode: 'Markdown' });
                return;
            }

            await ctx.reply('🔍 Fetching portfolio...');

            // Show first tracked wallet's portfolio
            const portfolio = await this.portfolioTracker.getPortfolio(user.wallets[0]);
            await ctx.reply(
                this.portfolioTracker.formatPortfolio(portfolio, user.wallets[0]),
                { parse_mode: 'Markdown' }
            );
        });

        // /alert <collection> <percent>
        this.bot.command('alert', async (ctx) => {
            this.userDb.getOrCreateUser(ctx.from!.id);

            const args = ctx.match?.trim().split(/\s+/);
            if (!args || args.length < 2) {
                await ctx.reply(
                    '*Price Alerts*\n\n' +
                    'Usage: `/alert bayc 10` - Alert when BAYC floor changes 10%\n' +
                    '`/alert off bayc` - Remove alert',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            if (args[0].toLowerCase() === 'off') {
                const collection = args[1];
                const removed = this.userDb.removePriceAlert(ctx.from!.id, collection);
                await ctx.reply(removed ? `✅ Alert removed for ${collection}` : '❌ No alert found.');
                return;
            }

            const collection = args[0];
            const percent = parseFloat(args[1]);

            if (isNaN(percent) || percent <= 0 || percent > 100) {
                await ctx.reply('❌ Invalid percentage. Use 1-100.');
                return;
            }

            const result = this.userDb.addPriceAlert(ctx.from!.id, collection, percent);
            if (result.success) {
                await ctx.reply(`✅ Alert set for *${collection}*\nTrigger: ±${percent}% change`, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(`❌ ${result.error}`);
            }
        });

        // /history - Transaction history
        this.bot.command('history', async (ctx) => {
            const transactions = this.transactionLogger.getRecent(10);

            if (transactions.length === 0) {
                await ctx.reply('📭 No transaction history yet.');
                return;
            }

            let message = '📜 *Recent Transactions*\n\n';
            for (const tx of transactions) {
                const status = tx.status === 'confirmed' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
                const date = new Date(tx.timestamp).toLocaleDateString();
                message += `${status} ${tx.type} - ${date}\n`;
            }

            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        // /test - Simulate a test NFT event to verify the alert pipeline
        this.bot.command('test', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id, ctx.from?.username, ctx.from?.first_name);

            // Use the user's first tracked wallet, or a famous wallet
            const testWallet = user.wallets[0] || '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

            await ctx.reply('🧪 *Sending test alert...*\nThis simulates an NFT purchase by your tracked wallet.', { parse_mode: 'Markdown' });

            // Create a realistic fake event
            const testEvent: NFTEvent = {
                id: `test-${Date.now()}`,
                type: 'buy',
                chain: 'ethereum',
                txHash: '0x' + 'a'.repeat(64),
                blockNumber: 21000000,
                timestamp: Date.now(),
                trackedWallet: testWallet,
                from: '0x0000000000000000000000000000000000000000',
                to: testWallet,
                contractAddress: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', // BAYC
                tokenId: '4562',
                tokenStandard: 'ERC721',
                quantity: 1,
                price: BigInt('32500000000000000000'), // 32.5 ETH
                priceFormatted: '32.5 ETH',
                currency: 'ETH',
                marketplace: 'opensea',
                metadata: {
                    name: 'Bored Ape #4562',
                    collection: 'Bored Ape Yacht Club',
                },
            };

            // Send through the real notification pipeline
            const message = formatNotification(testEvent);
            try {
                const keyboard = new InlineKeyboard()
                    .text('✅ Buy', `confirm_buy:${testEvent.id}`)
                    .text('❌ Skip', `cancel_buy:${testEvent.id}`);

                await this.bot.api.sendMessage(ctx.from!.id.toString(), message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard,
                });
                await ctx.reply('✅ Test alert sent! If you see it above, the notification pipeline is working.');
            } catch (e) {
                await ctx.reply(`❌ Test failed: ${(e as Error).message}`);
            }
        });

        // /killswitch
        this.bot.command('killswitch', async (ctx) => {
            const keyboard = new InlineKeyboard()
                .text('🛑 ENABLE', 'killswitch_on')
                .text('✅ Disable', 'killswitch_off');

            await ctx.reply(
                '⚠️ *Kill Switch*\n\nEnabling stops all trading immediately.',
                { parse_mode: 'Markdown', reply_markup: keyboard }
            );
        });
    }

    private setupCallbacks(): void {
        // Auto-buy toggle
        this.bot.callbackQuery('autobuy_on', async (ctx) => {
            this.userDb.updateSettings(ctx.from!.id, { autoBuyEnabled: true });
            await ctx.answerCallbackQuery({ text: '🟢 Auto-buy enabled!' });
            await ctx.editMessageText('🟢 *Auto-Buy ENABLED*\n\nBot will auto-buy when tracked wallets buy.', { parse_mode: 'Markdown' });
        });

        this.bot.callbackQuery('autobuy_off', async (ctx) => {
            this.userDb.updateSettings(ctx.from!.id, { autoBuyEnabled: false });
            await ctx.answerCallbackQuery({ text: '🔴 Auto-buy disabled' });
            await ctx.editMessageText('🔴 *Auto-Buy DISABLED*', { parse_mode: 'Markdown' });
        });

        // Premium activation (demo)
        this.bot.callbackQuery('activate_premium', async (ctx) => {
            this.userDb.upgradeToPremium(ctx.from!.id);
            await ctx.answerCallbackQuery({ text: '⭐ Premium activated!' });
            await ctx.editMessageText(
                '⭐ *Welcome to Premium!*\n\n' +
                'You now have access to:\n' +
                '• 100 wallet tracking\n' +
                '• Price alerts\n' +
                '• Portfolio tracking\n' +
                '• Snipe mode\n\n' +
                'Enjoy! 🎉',
                { parse_mode: 'Markdown' }
            );
        });

        // Buy confirmation
        this.bot.callbackQuery(/^confirm_buy:(.+)$/, async (ctx) => {
            const eventId = ctx.match[1];
            const session = ctx.session;

            if (!session.awaitingConfirmation || session.awaitingConfirmation.eventId !== eventId) {
                await ctx.answerCallbackQuery({ text: '⏰ Expired' });
                return;
            }

            const event = session.awaitingConfirmation.event;
            session.awaitingConfirmation = undefined;

            await ctx.answerCallbackQuery({ text: '🔄 Executing...' });
            await ctx.editMessageText('⏳ *Executing buy...*', { parse_mode: 'Markdown' });

            if (this.onConfirmBuy) {
                const result = await this.onConfirmBuy(event, 1);
                await ctx.editMessageText(formatTradeResult(result, event), { parse_mode: 'Markdown' });
            }
        });

        this.bot.callbackQuery(/^cancel_buy:(.+)$/, async (ctx) => {
            const eventId = ctx.match[1];
            if (ctx.session.awaitingConfirmation?.eventId === eventId) {
                ctx.session.awaitingConfirmation = undefined;
            }
            if (this.onCancelBuy) this.onCancelBuy(eventId);
            await ctx.answerCallbackQuery({ text: '❌ Cancelled' });
            await ctx.editMessageText('❌ *Buy cancelled*', { parse_mode: 'Markdown' });
        });

        // Kill switch
        this.bot.callbackQuery('killswitch_on', async (ctx) => {
            if (this.onToggleKillSwitch) this.onToggleKillSwitch(true);
            await ctx.answerCallbackQuery({ text: '🛑 Kill switch enabled!' });
            await ctx.editMessageText('🛑 *Kill Switch ENABLED*', { parse_mode: 'Markdown' });
        });

        this.bot.callbackQuery('killswitch_off', async (ctx) => {
            if (this.onToggleKillSwitch) this.onToggleKillSwitch(false);
            await ctx.answerCallbackQuery({ text: '✅ Kill switch disabled' });
            await ctx.editMessageText('✅ *Kill Switch DISABLED*', { parse_mode: 'Markdown' });
        });
    }

    async start(): Promise<void> {
        logger.info('Starting Telegram bot...');

        this.bot.catch((err) => {
            logger.error('Bot error', { error: err.error });
            err.ctx.reply('❌ An error occurred.').catch(() => { });
        });

        try {
            await this.bot.api.setMyCommands([
                { command: 'start', description: 'Start the bot' },
                { command: 'track', description: 'Track a wallet' },
                { command: 'bulkimport', description: 'Track multiple wallets at once' },
                { command: 'untrack', description: 'Stop tracking' },
                { command: 'wallets', description: 'List wallets' },
                { command: 'autobuy', description: 'Toggle auto-buy' },
                { command: 'status', description: 'Bot status' },
                { command: 'gas', description: 'Gas prices' },
                { command: 'stats', description: 'Collection stats' },
                { command: 'portfolio', description: 'View portfolio' },
                { command: 'alert', description: 'Price alerts' },
                { command: 'history', description: 'Transaction history' },
                { command: 'tier', description: 'Subscription status' },
                { command: 'upgrade', description: 'Get Premium' },
                { command: 'killswitch', description: 'Emergency stop' },
            ]);
            logger.info('Commands registered');
        } catch (e) {
            logger.error('Failed to set commands', { error: e });
        }

        this.bot.start({
            onStart: () => {
                this.isRunning = true;
                logger.info('Telegram bot polling');
            },
        });
    }

    async stop(): Promise<void> {
        await this.bot.stop();
        this.isRunning = false;
    }

    /**
     * Send NFT event notification to all users tracking the wallet
     */
    async sendEventNotification(event: NFTEvent): Promise<void> {
        const users = this.userDb.getUsersTrackingWallet(event.trackedWallet);
        const message = formatNotification(event);

        for (const user of users) {
            try {
                const keyboard = new InlineKeyboard()
                    .text('✅ Buy', `confirm_buy:${event.id}`)
                    .text('❌ Skip', `cancel_buy:${event.id}`);

                await this.bot.api.sendMessage(user.id.toString(), message, {
                    parse_mode: 'Markdown',
                    reply_markup: user.settings.autoBuyEnabled ? undefined : keyboard,
                });

                // If auto-buy is enabled, execute immediately
                if (user.settings.autoBuyEnabled && this.onConfirmBuy) {
                    const result = await this.onConfirmBuy(event, 1);
                    await this.bot.api.sendMessage(
                        user.id.toString(),
                        formatTradeResult(result, event),
                        { parse_mode: 'Markdown' }
                    );
                }
            } catch (e) {
                logger.error('Failed to notify user', { userId: user.id, error: e });
            }
        }
    }

    async sendWhaleAlert(event: NFTEvent): Promise<void> {
        const users = Object.values(this.userDb['data'].users) as User[];

        const message = `🐋 *WHALE ALERT*\n\n` +
            `Wallet: \`${event.trackedWallet.slice(0, 10)}...\`\n` +
            `Action: ${event.type.toUpperCase()}\n` +
            `Price: ${event.priceFormatted}\n` +
            `Collection: ${event.contractAddress.slice(0, 10)}...`;

        for (const user of users) {
            try {
                await this.bot.api.sendMessage(user.id.toString(), message, { parse_mode: 'Markdown' });
            } catch (e) {
                logger.error('Failed to send whale alert', { userId: user.id });
            }
        }
    }

    /**
     * Send price alert
     */
    async sendPriceAlert(userId: number, message: string): Promise<void> {
        try {
            await this.bot.api.sendMessage(userId.toString(), message, { parse_mode: 'Markdown' });
        } catch (e) {
            logger.error('Failed to send price alert', { userId });
        }
    }

    getUserDatabase(): UserDatabase {
        return this.userDb;
    }

    getStatus(): { running: boolean } {
        return { running: this.isRunning };
    }

    /**
     * Set the Ethereum listener reference for /status diagnostics
     */
    setEthereumListener(listener: EthereumListener | undefined): void {
        this.ethereumListener = listener || null;
    }

    /**
     * Send a startup notification to all registered users
     */
    async sendStartupNotification(message: string): Promise<void> {
        const users = Object.values(this.userDb['data'].users) as User[];
        for (const user of users) {
            try {
                await this.bot.api.sendMessage(user.id.toString(), message, { parse_mode: 'Markdown' });
            } catch (e) {
                logger.error('Failed to send startup notification', { userId: user.id });
            }
        }
    }
}
