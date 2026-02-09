import { Bot, Context, InlineKeyboard, session } from 'grammy';
import { NFTEvent, TradeResult } from '../types/index.js';
import { Config } from '../config/index.js';
import { createModuleLogger } from '../utils/logger.js';
import { formatNotification, formatTradeResult } from './formatters.js';
import { UserDatabase, User } from '../database/UserDatabase.js';
import { GasTracker } from '../utils/GasTracker.js';
import { PortfolioTracker } from '../portfolio/PortfolioTracker.js';
import { CollectionStats } from '../stats/CollectionStats.js';
import { SnipeMode } from '../trading/SnipeMode.js';
import { TransactionLogger } from '../safety/TransactionLogger.js';

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
    private snipeMode: SnipeMode;
    private transactionLogger: TransactionLogger;

    // Callbacks
    public onConfirmBuy?: (event: NFTEvent, quantity: number) => Promise<TradeResult>;
    public onCancelBuy?: (eventId: string) => void;
    public onToggleKillSwitch?: (enable: boolean) => void;

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
        this.snipeMode = new SnipeMode(userDb);

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

            const tierEmoji = user.tier === 'premium' ? '⭐' : '🆓';
            await ctx.reply(
                `🚀 *NFT Wallet Tracker Bot*\n\n` +
                `Welcome${user.firstName ? `, ${user.firstName}` : ''}!\n` +
                `Account: ${tierEmoji} ${user.tier.toUpperCase()}\n\n` +
                `*Commands:*\n` +
                `/track <address> - Track a wallet\n` +
                `/untrack <address> - Stop tracking\n` +
                `/wallets - List tracked wallets\n` +
                `/autobuy - Toggle auto-buy\n` +
                `/status - Bot status\n\n` +
                `*Premium Features:*\n` +
                `/alert <collection> <percent> - Price alerts\n` +
                `/portfolio - View NFT holdings\n` +
                `/snipe <collection> <maxPrice> - Snipe mode\n\n` +
                `*Utilities:*\n` +
                `/stats <collection> - Collection stats\n` +
                `/gas - Current gas prices\n` +
                `/history - Transaction history\n` +
                `/tier - View subscription\n` +
                `/upgrade - Get Premium`,
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
                `*Price Alerts (Premium):*\n` +
                `Get notified when a collection's floor price changes by X%.\n\n` +
                `*Snipe Mode (Premium):*\n` +
                `Auto-buy listings below your set price.`,
                { parse_mode: 'Markdown' }
            );
        });

        // /tier - Show subscription status
        this.bot.command('tier', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);
            const limit = this.userDb.getWalletLimit(user.tier);
            const emoji = user.tier === 'premium' ? '⭐' : '🆓';

            await ctx.reply(
                `${emoji} *Your Subscription*\n\n` +
                `Tier: *${user.tier.toUpperCase()}*\n` +
                `Wallets: ${user.wallets.length}/${limit}\n` +
                `Price Alerts: ${user.tier === 'premium' ? '✅' : '❌'}\n` +
                `Snipe Mode: ${user.tier === 'premium' ? '✅' : '❌'}\n` +
                `Portfolio: ${user.tier === 'premium' ? '✅' : '❌'}\n\n` +
                (user.tier === 'free' ? 'Use /upgrade to unlock all features!' : 'You have full access!'),
                { parse_mode: 'Markdown' }
            );
        });

        // /upgrade - Premium upgrade info
        this.bot.command('upgrade', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);

            if (user.tier === 'premium') {
                await ctx.reply('⭐ You already have Premium!');
                return;
            }

            const keyboard = new InlineKeyboard()
                .text('🎁 Activate Premium (Demo)', 'activate_premium');

            await ctx.reply(
                `⭐ *Upgrade to Premium*\n\n` +
                `*Free Tier:*\n` +
                `• Track 1 wallet\n` +
                `• Basic alerts\n` +
                `• Gas tracker\n` +
                `• Collection stats\n\n` +
                `*Premium Tier:*\n` +
                `• Track 100 wallets\n` +
                `• Price alerts\n` +
                `• Portfolio tracking\n` +
                `• Snipe mode\n` +
                `• Priority support\n\n` +
                `Click below to activate (demo):`,
                { parse_mode: 'Markdown', reply_markup: keyboard }
            );
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

            const result = this.userDb.addWallet(ctx.from!.id, address);
            if (result.success) {
                await ctx.reply(`✅ Now tracking:\n\`${address}\``, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(`❌ ${result.error}`);
            }
        });

        // /untrack <address>
        this.bot.command('untrack', async (ctx) => {
            const address = ctx.match?.trim();
            if (!address) {
                await ctx.reply('Usage: `/untrack 0x123...`', { parse_mode: 'Markdown' });
                return;
            }

            const success = this.userDb.removeWallet(ctx.from!.id, address);
            if (success) {
                await ctx.reply(`✅ Stopped tracking:\n\`${address}\``, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply('❌ Wallet not found in your tracking list.');
            }
        });

        // /wallets - List user's wallets
        this.bot.command('wallets', async (ctx) => {
            const wallets = this.userDb.getUserWallets(ctx.from!.id);
            const user = this.userDb.getUser(ctx.from!.id);
            const limit = user ? this.userDb.getWalletLimit(user.tier) : 1;

            if (wallets.length === 0) {
                await ctx.reply('📭 No wallets tracked.\n\nUse `/track <address>` to add one.', { parse_mode: 'Markdown' });
                return;
            }

            await ctx.reply(
                `👛 *Your Tracked Wallets* (${wallets.length}/${limit})\n\n` +
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

        // /status - Bot status
        this.bot.command('status', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);
            const stats = this.userDb.getUserCount();
            const txStats = this.transactionLogger.getStats();

            await ctx.reply(
                `📊 *Bot Status*\n\n` +
                `👤 Your tier: ${user.tier}\n` +
                `👛 Your wallets: ${user.wallets.length}\n` +
                `🤖 Auto-buy: ${user.settings.autoBuyEnabled ? '🟢' : '🔴'}\n\n` +
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

        // /portfolio - Portfolio tracking (Premium)
        this.bot.command('portfolio', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);

            if (user.tier !== 'premium') {
                await ctx.reply('⭐ Portfolio tracking is a Premium feature.\n\nUse /upgrade to unlock!');
                return;
            }

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

        // /alert <collection> <percent> - Price alerts (Premium)
        this.bot.command('alert', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);

            if (user.tier !== 'premium') {
                await ctx.reply('⭐ Price alerts are a Premium feature.\n\nUse /upgrade to unlock!');
                return;
            }

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

        // /snipe <collection> <maxPrice> - Snipe mode (Premium)
        this.bot.command('snipe', async (ctx) => {
            const user = this.userDb.getOrCreateUser(ctx.from!.id);

            if (user.tier !== 'premium') {
                await ctx.reply('⭐ Snipe mode is a Premium feature.\n\nUse /upgrade to unlock!');
                return;
            }

            const args = ctx.match?.trim().split(/\s+/);

            if (!args || args.length === 0) {
                const targets = this.snipeMode.getUserTargets(ctx.from!.id);
                await ctx.reply(this.snipeMode.formatTargets(targets), { parse_mode: 'Markdown' });
                return;
            }

            if (args[0].toLowerCase() === 'off') {
                const collection = args[1];
                if (!collection) {
                    await ctx.reply('Usage: `/snipe off <collection>`', { parse_mode: 'Markdown' });
                    return;
                }
                const removed = this.snipeMode.removeTarget(ctx.from!.id, collection);
                await ctx.reply(removed ? `✅ Snipe removed for ${collection}` : '❌ No snipe found.');
                return;
            }

            if (args.length < 2) {
                await ctx.reply(
                    '*Snipe Mode*\n\n' +
                    'Usage: `/snipe bayc 50` - Auto-buy BAYC under 50 ETH\n' +
                    '`/snipe off bayc` - Disable snipe\n' +
                    '`/snipe` - View active snipes',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const collection = args[0];
            const maxPrice = parseFloat(args[1]);

            if (isNaN(maxPrice) || maxPrice <= 0) {
                await ctx.reply('❌ Invalid price.');
                return;
            }

            const result = this.snipeMode.addTarget(ctx.from!.id, collection, maxPrice);
            if (result.success) {
                await ctx.reply(`🎯 Snipe active for *${collection}*\nMax price: ${maxPrice} ETH`, { parse_mode: 'Markdown' });
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
                { command: 'untrack', description: 'Stop tracking' },
                { command: 'wallets', description: 'List wallets' },
                { command: 'autobuy', description: 'Toggle auto-buy' },
                { command: 'status', description: 'Bot status' },
                { command: 'gas', description: 'Gas prices' },
                { command: 'stats', description: 'Collection stats' },
                { command: 'portfolio', description: 'View portfolio' },
                { command: 'alert', description: 'Price alerts' },
                { command: 'snipe', description: 'Snipe mode' },
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

    /**
     * Send whale alert to all premium users
     */
    async sendWhaleAlert(event: NFTEvent): Promise<void> {
        const users = Object.values(this.userDb['data'].users).filter(
            (u: User) => u.tier === 'premium'
        );

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
}
