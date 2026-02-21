import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ButtonInteraction,
    EmbedBuilder,
    Colors,
} from 'discord.js';
import { NFTEvent, TradeResult } from '../types/index.js';
import { Config } from '../config/index.js';
import { createModuleLogger } from '../utils/logger.js';
import { formatNotification, formatTradeResult, formatWalletList } from './formatters.js';
import { UserDatabase, User } from '../database/UserDatabase.js';
import { GasTracker } from '../utils/GasTracker.js';
import { PortfolioTracker } from '../portfolio/PortfolioTracker.js';
import { CollectionStats } from '../stats/CollectionStats.js';
import { SnipeMode } from '../trading/SnipeMode.js';
import { TransactionLogger } from '../safety/TransactionLogger.js';
import { EthereumListener } from '../blockchain/index.js';

const logger = createModuleLogger('discord');

/**
 * DiscordBot — Full-featured multi-user NFT tracking bot for Discord.
 * 1:1 feature parity with the Telegram bot.
 */
export class DiscordBot {
    private client: Client;
    private rest: REST;
    private isRunning = false;

    // Config
    private botToken: string;
    private clientId: string;
    private guildId?: string;

    // Dependencies
    private userDb: UserDatabase;
    private gasTracker: GasTracker;
    private portfolioTracker: PortfolioTracker;
    private collectionStats: CollectionStats;
    private snipeMode: SnipeMode;
    private transactionLogger: TransactionLogger;
    private ethereumListener: EthereumListener | null = null;

    // Pending confirmations: eventId → { event, userId, expiresAt }
    private pendingConfirmations = new Map<string, { event: NFTEvent; userId: string; expiresAt: number }>();

    // Callbacks (wired by index-discord.ts, same pattern as TelegramBot)
    public onConfirmBuy?: (event: NFTEvent, quantity: number) => Promise<TradeResult>;
    public onCancelBuy?: (eventId: string) => void;
    public onToggleKillSwitch?: (enable: boolean) => void;
    public onWalletAdded?: (address: string) => void;
    public onWalletRemoved?: (address: string) => void;

    constructor(config: Config, userDb: UserDatabase, transactionLogger: TransactionLogger) {
        this.botToken = config.discord!.botToken;
        this.clientId = config.discord!.clientId;
        this.guildId = config.discord!.guildId;

        this.userDb = userDb;
        this.transactionLogger = transactionLogger;

        // Feature modules (same as Telegram)
        this.gasTracker = new GasTracker(config.ethereum?.rpcUrl || '');
        this.portfolioTracker = new PortfolioTracker(this.extractAlchemyKey(config.ethereum?.rpcUrl));
        this.collectionStats = new CollectionStats();
        this.snipeMode = new SnipeMode(userDb);

        // Discord client
        this.client = new Client({
            intents: [GatewayIntentBits.Guilds],
        });
        this.rest = new REST({ version: '10' }).setToken(this.botToken);

        // Wire interaction handler
        this.client.on('interactionCreate', async (interaction) => {
            if (interaction.isChatInputCommand()) {
                await this.handleCommand(interaction);
            } else if (interaction.isButton()) {
                await this.handleButton(interaction);
            }
        });
    }

    // ── Lifecycle ────────────────────────────────────────

    async start(): Promise<void> {
        logger.info('Starting Discord bot...');

        // Register slash commands
        await this.registerCommands();

        // Login
        await this.client.login(this.botToken);

        this.client.once('ready', () => {
            this.isRunning = true;
            logger.info(`Discord bot ready as ${this.client.user?.tag}`);
        });
    }

    async stop(): Promise<void> {
        this.client.destroy();
        this.isRunning = false;
        logger.info('Discord bot stopped');
    }

    setEthereumListener(listener: EthereumListener | undefined): void {
        this.ethereumListener = listener || null;
    }

    getStatus(): { running: boolean } {
        return { running: this.isRunning };
    }

    getUserDatabase(): UserDatabase {
        return this.userDb;
    }

    // ── Slash command registration ───────────────────────

    private async registerCommands(): Promise<void> {
        const commands = [
            new SlashCommandBuilder().setName('start').setDescription('Start the bot & register'),
            new SlashCommandBuilder().setName('help').setDescription('Show help guide'),
            new SlashCommandBuilder().setName('track')
                .setDescription('Track a wallet')
                .addStringOption(o => o.setName('address').setDescription('Ethereum wallet address (0x...)').setRequired(true)),
            new SlashCommandBuilder().setName('untrack')
                .setDescription('Stop tracking a wallet')
                .addStringOption(o => o.setName('address').setDescription('Ethereum wallet address').setRequired(true)),
            new SlashCommandBuilder().setName('wallets').setDescription('List your tracked wallets'),
            new SlashCommandBuilder().setName('autobuy').setDescription('Toggle auto-buy mode'),
            new SlashCommandBuilder().setName('status').setDescription('Bot status & diagnostics'),
            new SlashCommandBuilder().setName('gas').setDescription('Current gas prices'),
            new SlashCommandBuilder().setName('stats')
                .setDescription('Collection statistics')
                .addStringOption(o => o.setName('collection').setDescription('Collection slug or contract address').setRequired(true)),
            new SlashCommandBuilder().setName('portfolio').setDescription('View your NFT portfolio (Premium)'),
            new SlashCommandBuilder().setName('alert')
                .setDescription('Set price alert (Premium)')
                .addStringOption(o => o.setName('collection').setDescription('Collection slug').setRequired(true))
                .addNumberOption(o => o.setName('percent').setDescription('Change % to trigger alert').setRequired(false))
                .addBooleanOption(o => o.setName('off').setDescription('Remove alert').setRequired(false)),
            new SlashCommandBuilder().setName('snipe')
                .setDescription('Snipe mode (Premium)')
                .addStringOption(o => o.setName('collection').setDescription('Collection slug').setRequired(false))
                .addNumberOption(o => o.setName('maxprice').setDescription('Max price in ETH').setRequired(false))
                .addBooleanOption(o => o.setName('off').setDescription('Remove snipe').setRequired(false)),
            new SlashCommandBuilder().setName('history').setDescription('Transaction history'),
            new SlashCommandBuilder().setName('tier').setDescription('View your subscription'),
            new SlashCommandBuilder().setName('upgrade').setDescription('Upgrade to Premium'),
            new SlashCommandBuilder().setName('killswitch').setDescription('Emergency stop'),
            new SlashCommandBuilder().setName('test').setDescription('Send a test alert'),
        ];

        const body = commands.map(c => c.toJSON());

        try {
            if (this.guildId) {
                await this.rest.put(Routes.applicationGuildCommands(this.clientId, this.guildId), { body });
                logger.info('Guild commands registered');
            } else {
                await this.rest.put(Routes.applicationCommands(this.clientId), { body });
                logger.info('Global commands registered (may take up to 1 hour to propagate)');
            }
        } catch (e) {
            logger.error('Failed to register commands', { error: e });
        }
    }

    // ── Command router ───────────────────────────────────

    private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        const name = interaction.commandName;
        try {
            switch (name) {
                case 'start': return await this.cmdStart(interaction);
                case 'help': return await this.cmdHelp(interaction);
                case 'track': return await this.cmdTrack(interaction);
                case 'untrack': return await this.cmdUntrack(interaction);
                case 'wallets': return await this.cmdWallets(interaction);
                case 'autobuy': return await this.cmdAutobuy(interaction);
                case 'status': return await this.cmdStatus(interaction);
                case 'gas': return await this.cmdGas(interaction);
                case 'stats': return await this.cmdStats(interaction);
                case 'portfolio': return await this.cmdPortfolio(interaction);
                case 'alert': return await this.cmdAlert(interaction);
                case 'snipe': return await this.cmdSnipe(interaction);
                case 'history': return await this.cmdHistory(interaction);
                case 'tier': return await this.cmdTier(interaction);
                case 'upgrade': return await this.cmdUpgrade(interaction);
                case 'killswitch': return await this.cmdKillswitch(interaction);
                case 'test': return await this.cmdTest(interaction);
                default:
                    await interaction.reply({ content: '❓ Unknown command.', flags: ['Ephemeral'] });
            }
        } catch (e) {
            logger.error('Command error', { command: name, error: e });
            const errorMsg = '❌ An error occurred.';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorMsg, flags: ['Ephemeral'] }).catch(() => { });
            } else {
                await interaction.reply({ content: errorMsg, flags: ['Ephemeral'] }).catch(() => { });
            }
        }
    }

    // ── Command implementations ──────────────────────────

    private discordUserId(interaction: ChatInputCommandInteraction | ButtonInteraction): number {
        // Use a numeric hash of the Discord snowflake id for DB compatibility
        return this.snowflakeToNumericId(interaction.user.id);
    }

    /**
     * Convert Discord snowflake (string) to a stable positive 32-bit integer
     * so it fits the same `number` id used by Telegram in the UserDatabase.
     */
    private snowflakeToNumericId(snowflake: string): number {
        let hash = 0;
        for (let i = 0; i < snowflake.length; i++) {
            hash = ((hash << 5) - hash + snowflake.charCodeAt(i)) | 0;
        }
        return Math.abs(hash);
    }

    // ─── /start ──────────────────────────────────────────

    private async cmdStart(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId, interaction.user.username, interaction.user.globalName ?? undefined);

        const tierEmoji = user.tier === 'premium' ? '⭐' : '🆓';

        const embed = new EmbedBuilder()
            .setTitle('🚀 NFT Wallet Tracker Bot')
            .setColor(Colors.Blurple)
            .setDescription(
                `Welcome${user.firstName ? `, ${user.firstName}` : ''}!\n` +
                `Account: ${tierEmoji} **${user.tier.toUpperCase()}**`
            )
            .addFields(
                {
                    name: '📝 Commands',
                    value: [
                        '`/track <address>` — Track a wallet',
                        '`/untrack <address>` — Stop tracking',
                        '`/wallets` — List tracked wallets',
                        '`/autobuy` — Toggle auto-buy',
                        '`/status` — Bot status',
                    ].join('\n'),
                },
                {
                    name: '⭐ Premium Features',
                    value: [
                        '`/alert <collection> <percent>` — Price alerts',
                        '`/portfolio` — View NFT holdings',
                        '`/snipe <collection> <maxPrice>` — Snipe mode',
                    ].join('\n'),
                },
                {
                    name: '🛠 Utilities',
                    value: [
                        '`/stats <collection>` — Collection stats',
                        '`/gas` — Current gas prices',
                        '`/history` — Transaction history',
                        '`/tier` — Subscription info',
                        '`/upgrade` — Get Premium',
                    ].join('\n'),
                },
            );

        await interaction.reply({ embeds: [embed] });
    }

    // ─── /help ──────────────────────────────────────────

    private async cmdHelp(interaction: ChatInputCommandInteraction): Promise<void> {
        const embed = new EmbedBuilder()
            .setTitle('📖 Help Guide')
            .setColor(Colors.Blue)
            .addFields(
                { name: 'Wallet Tracking', value: 'Track whale wallets and get notified of their NFT activity.' },
                { name: 'Auto-Buy', value: 'When enabled, automatically copy-buy NFTs that tracked wallets purchase.' },
                { name: 'Price Alerts (Premium)', value: 'Get notified when a collection\'s floor price changes by X%.' },
                { name: 'Snipe Mode (Premium)', value: 'Auto-buy listings below your set price.' },
            );

        await interaction.reply({ embeds: [embed] });
    }

    // ─── /track ─────────────────────────────────────────

    private async cmdTrack(interaction: ChatInputCommandInteraction): Promise<void> {
        const address = interaction.options.getString('address', true).trim();

        if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
            await interaction.reply({ content: '❌ Invalid Ethereum address format.', flags: ['Ephemeral'] });
            return;
        }

        const userId = this.discordUserId(interaction);
        this.userDb.getOrCreateUser(userId, interaction.user.username, interaction.user.globalName ?? undefined);

        const result = this.userDb.addWallet(userId, address);
        if (result.success) {
            if (this.onWalletAdded) this.onWalletAdded(address);
            await interaction.reply({ content: `✅ Now tracking:\n\`${address}\`` });
        } else {
            await interaction.reply({ content: `❌ ${result.error}`, flags: ['Ephemeral'] });
        }
    }

    // ─── /untrack ───────────────────────────────────────

    private async cmdUntrack(interaction: ChatInputCommandInteraction): Promise<void> {
        const address = interaction.options.getString('address', true).trim();
        const userId = this.discordUserId(interaction);

        this.userDb.getOrCreateUser(userId, interaction.user.username, interaction.user.globalName ?? undefined);

        const success = this.userDb.removeWallet(userId, address);
        if (success) {
            const stillTracked = this.userDb.getUsersTrackingWallet(address).length > 0;
            if (!stillTracked && this.onWalletRemoved) this.onWalletRemoved(address);
            await interaction.reply({ content: `✅ Stopped tracking:\n\`${address}\`` });
        } else {
            await interaction.reply({ content: '❌ Wallet not found in your tracking list.', flags: ['Ephemeral'] });
        }
    }

    // ─── /wallets ───────────────────────────────────────

    private async cmdWallets(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const wallets = this.userDb.getUserWallets(userId);
        const user = this.userDb.getUser(userId);
        const limit = user ? this.userDb.getWalletLimit(user.tier) : 1;

        const embed = formatWalletList(wallets, limit);
        await interaction.reply({ embeds: [embed] });
    }

    // ─── /autobuy ───────────────────────────────────────

    private async cmdAutobuy(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId);
        const status = user.settings.autoBuyEnabled ? '🟢 ON' : '🔴 OFF';

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('autobuy_on').setLabel('🟢 Turn ON').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('autobuy_off').setLabel('🔴 Turn OFF').setStyle(ButtonStyle.Danger),
        );

        const embed = new EmbedBuilder()
            .setTitle('🤖 Auto-Buy Control')
            .setColor(Colors.Blue)
            .setDescription(`Current: **${status}**\n\nWhen ON, bot automatically buys NFTs when tracked wallets buy/mint.`);

        await interaction.reply({ embeds: [embed], components: [row] });
    }

    // ─── /status ────────────────────────────────────────

    private async cmdStatus(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId);
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
                blockInfo += `\n📋 Wallets: ${diag.trackedWallets.map((w: string) => w.slice(0, 8) + '...').join(', ')}`;
            }
            if (diag.lastError) {
                blockInfo += `\n⚠️ Last error: ${diag.lastError.slice(0, 100)}`;
            }
        }

        const embed = new EmbedBuilder()
            .setTitle('📊 Bot Status')
            .setColor(Colors.Green)
            .addFields(
                { name: '👤 Your tier', value: user.tier, inline: true },
                { name: '👛 Your wallets', value: user.wallets.length.toString(), inline: true },
                { name: '🤖 Auto-buy', value: user.settings.autoBuyEnabled ? '🟢' : '🔴', inline: true },
                { name: `⛓ Ethereum Listener`, value: `${ethStatus}${blockInfo}` },
                { name: '📈 Stats', value: `Users: ${stats.total}\nTransactions: ${txStats.total}\nConfirmed: ${txStats.confirmed}` },
            );

        await interaction.reply({ embeds: [embed] });
    }

    // ─── /gas ────────────────────────────────────────────

    private async cmdGas(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply();
        try {
            const prices = await this.gasTracker.getGasPrices();
            const age = Math.round((Date.now() - prices.timestamp) / 1000);

            const embed = new EmbedBuilder()
                .setTitle('⛽ Gas Prices (Live)')
                .setColor(Colors.Orange)
                .addFields(
                    { name: '🟢 Low', value: `**${prices.low}** gwei`, inline: true },
                    { name: '🟡 Average', value: `**${prices.average}** gwei`, inline: true },
                    { name: '🔴 High', value: `**${prices.high}** gwei`, inline: true },
                    { name: '📊 Base Fee', value: `${prices.baseFee} gwei`, inline: true },
                    { name: '📈 Next Base Fee', value: `${prices.nextBaseFee} gwei`, inline: true },
                    { name: '🧱 Block', value: `#${prices.lastBlock.toLocaleString()}`, inline: true },
                )
                .setFooter({ text: `Updated ${age}s ago` });

            await interaction.editReply({ embeds: [embed] });
        } catch {
            await interaction.editReply({ content: '❌ Failed to fetch gas prices.' });
        }
    }

    // ─── /stats ──────────────────────────────────────────

    private async cmdStats(interaction: ChatInputCommandInteraction): Promise<void> {
        const collection = interaction.options.getString('collection', true).trim();
        await interaction.deferReply();

        const stats = await this.collectionStats.getStats(collection);
        if (stats) {
            const changeEmoji = (c: number) => c >= 0 ? '📈' : '📉';
            const fmtChange = (c: number) => `${c >= 0 ? '+' : ''}${(c * 100).toFixed(1)}%`;

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${stats.name}`)
                .setColor(Colors.Purple)
                .addFields(
                    { name: '💰 Floor', value: `${stats.floorPrice.toFixed(4)} ETH`, inline: true },
                    { name: '📦 Supply', value: stats.totalSupply.toLocaleString(), inline: true },
                    { name: '👥 Owners', value: stats.owners.toLocaleString(), inline: true },
                    { name: '📈 Volume', value: `${stats.totalVolume.toFixed(2)} ETH`, inline: true },
                    { name: `${changeEmoji(stats.oneDayChange)} 24h`, value: fmtChange(stats.oneDayChange), inline: true },
                    { name: `${changeEmoji(stats.sevenDayChange)} 7d`, value: fmtChange(stats.sevenDayChange), inline: true },
                );

            if (stats.imageUrl) embed.setThumbnail(stats.imageUrl);
            await interaction.editReply({ embeds: [embed] });
        } else {
            await interaction.editReply({ content: '❌ Collection not found.' });
        }
    }

    // ─── /portfolio ──────────────────────────────────────

    private async cmdPortfolio(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId);

        if (user.tier !== 'premium') {
            await interaction.reply({ content: '⭐ Portfolio tracking is a Premium feature.\n\nUse `/upgrade` to unlock!', flags: ['Ephemeral'] });
            return;
        }

        if (user.wallets.length === 0) {
            await interaction.reply({ content: '📭 No wallets to show portfolio for.\n\nUse `/track` first.', flags: ['Ephemeral'] });
            return;
        }

        await interaction.deferReply();
        const portfolio = await this.portfolioTracker.getPortfolio(user.wallets[0]);
        const shortAddr = `${user.wallets[0].slice(0, 6)}...${user.wallets[0].slice(-4)}`;

        const embed = new EmbedBuilder()
            .setTitle(`💼 Portfolio for ${shortAddr}`)
            .setColor(Colors.Gold)
            .addFields(
                { name: '📦 Total NFTs', value: portfolio.totalNFTs.toString(), inline: true },
                { name: '💰 Est. Value', value: `${portfolio.estimatedValue.toFixed(2)} ETH`, inline: true },
            );

        if (portfolio.holdings.length === 0) {
            embed.setDescription('_No NFTs found_');
        } else {
            const lines = portfolio.holdings.slice(0, 10).map(nft => {
                const value = nft.floorPrice ? ` (${nft.floorPrice.toFixed(3)} ETH)` : '';
                return `• ${nft.collection}: ${nft.name}${value}`;
            });
            if (portfolio.holdings.length > 10) {
                lines.push(`\n_...and ${portfolio.holdings.length - 10} more_`);
            }
            embed.addFields({ name: 'Holdings', value: lines.join('\n') });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    // ─── /alert ──────────────────────────────────────────

    private async cmdAlert(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId);

        if (user.tier !== 'premium') {
            await interaction.reply({ content: '⭐ Price alerts are a Premium feature.\n\nUse `/upgrade` to unlock!', flags: ['Ephemeral'] });
            return;
        }

        const collection = interaction.options.getString('collection', true).trim();
        const off = interaction.options.getBoolean('off') ?? false;
        const percent = interaction.options.getNumber('percent');

        if (off) {
            const removed = this.userDb.removePriceAlert(userId, collection);
            await interaction.reply({ content: removed ? `✅ Alert removed for ${collection}` : '❌ No alert found.', flags: ['Ephemeral'] });
            return;
        }

        if (percent == null) {
            await interaction.reply({
                content: '**Price Alerts**\n\nUsage: `/alert collection:bayc percent:10`\nRemove: `/alert collection:bayc off:True`',
                flags: ['Ephemeral'],
            });
            return;
        }

        if (percent <= 0 || percent > 100) {
            await interaction.reply({ content: '❌ Invalid percentage. Use 1-100.', flags: ['Ephemeral'] });
            return;
        }

        const result = this.userDb.addPriceAlert(userId, collection, percent);
        if (result.success) {
            await interaction.reply({ content: `✅ Alert set for **${collection}**\nTrigger: ±${percent}% change` });
        } else {
            await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        }
    }

    // ─── /snipe ──────────────────────────────────────────

    private async cmdSnipe(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId);

        if (user.tier !== 'premium') {
            await interaction.reply({ content: '⭐ Snipe mode is a Premium feature.\n\nUse `/upgrade` to unlock!', flags: ['Ephemeral'] });
            return;
        }

        const collection = interaction.options.getString('collection');
        const maxPrice = interaction.options.getNumber('maxprice');
        const off = interaction.options.getBoolean('off') ?? false;

        // No args → list targets
        if (!collection) {
            const targets = this.snipeMode.getUserTargets(userId);
            // Build plain text (snipeMode.formatTargets uses Markdown‐style, rebuild for Discord)
            if (targets.length === 0) {
                await interaction.reply({ content: '🎯 **Snipe Mode**\n\nNo active snipe targets.\n\nUse `/snipe collection:<slug> maxprice:<eth>` to add one.', flags: ['Ephemeral'] });
            } else {
                let msg = '🎯 **Active Snipe Targets**\n\n';
                for (const t of targets) {
                    msg += `${t.active ? '🟢' : '🔴'} \`${t.collection}\` — Max: ${t.maxPrice} ETH\n`;
                }
                msg += '\nUse `/snipe collection:<slug> off:True` to remove.';
                await interaction.reply({ content: msg });
            }
            return;
        }

        if (off) {
            const removed = this.snipeMode.removeTarget(userId, collection);
            await interaction.reply({ content: removed ? `✅ Snipe removed for ${collection}` : '❌ No snipe found.', flags: ['Ephemeral'] });
            return;
        }

        if (maxPrice == null || maxPrice <= 0) {
            await interaction.reply({
                content: '**Snipe Mode**\n\nUsage: `/snipe collection:bayc maxprice:50`\nDisable: `/snipe collection:bayc off:True`\nList: `/snipe`',
                flags: ['Ephemeral'],
            });
            return;
        }

        const result = this.snipeMode.addTarget(userId, collection, maxPrice);
        if (result.success) {
            await interaction.reply({ content: `🎯 Snipe active for **${collection}**\nMax price: ${maxPrice} ETH` });
        } else {
            await interaction.reply({ content: `❌ ${result.error}`, flags: ['Ephemeral'] });
        }
    }

    // ─── /history ────────────────────────────────────────

    private async cmdHistory(interaction: ChatInputCommandInteraction): Promise<void> {
        const transactions = this.transactionLogger.getRecent(10);

        if (transactions.length === 0) {
            await interaction.reply({ content: '📭 No transaction history yet.', flags: ['Ephemeral'] });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('📜 Recent Transactions')
            .setColor(Colors.Blue);

        const lines: string[] = [];
        for (const tx of transactions) {
            const status = tx.status === 'confirmed' ? '✅' : tx.status === 'pending' ? '⏳' : '❌';
            const date = new Date(tx.timestamp).toLocaleDateString();
            lines.push(`${status} ${tx.type} — ${date}`);
        }
        embed.setDescription(lines.join('\n'));

        await interaction.reply({ embeds: [embed] });
    }

    // ─── /tier ──────────────────────────────────────────

    private async cmdTier(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId);
        const limit = this.userDb.getWalletLimit(user.tier);
        const emoji = user.tier === 'premium' ? '⭐' : '🆓';

        const embed = new EmbedBuilder()
            .setTitle(`${emoji} Your Subscription`)
            .setColor(user.tier === 'premium' ? Colors.Gold : Colors.Greyple)
            .addFields(
                { name: 'Tier', value: `**${user.tier.toUpperCase()}**`, inline: true },
                { name: 'Wallets', value: `${user.wallets.length}/${limit}`, inline: true },
                { name: 'Price Alerts', value: user.tier === 'premium' ? '✅' : '❌', inline: true },
                { name: 'Snipe Mode', value: user.tier === 'premium' ? '✅' : '❌', inline: true },
                { name: 'Portfolio', value: user.tier === 'premium' ? '✅' : '❌', inline: true },
            );

        if (user.tier === 'free') {
            embed.setFooter({ text: 'Use /upgrade to unlock all features!' });
        }

        await interaction.reply({ embeds: [embed] });
    }

    // ─── /upgrade ───────────────────────────────────────

    private async cmdUpgrade(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId);

        if (user.tier === 'premium') {
            await interaction.reply({ content: '⭐ You already have Premium!', flags: ['Ephemeral'] });
            return;
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('activate_premium').setLabel('🎁 Activate Premium (Demo)').setStyle(ButtonStyle.Primary),
        );

        const embed = new EmbedBuilder()
            .setTitle('⭐ Upgrade to Premium')
            .setColor(Colors.Gold)
            .addFields(
                {
                    name: 'Free Tier',
                    value: '• Track 1 wallet\n• Basic alerts\n• Gas tracker\n• Collection stats',
                    inline: true,
                },
                {
                    name: 'Premium Tier',
                    value: '• Track 100 wallets\n• Price alerts\n• Portfolio tracking\n• Snipe mode\n• Priority support',
                    inline: true,
                },
            )
            .setFooter({ text: 'Click below to activate (demo)' });

        await interaction.reply({ embeds: [embed], components: [row] });
    }

    // ─── /killswitch ────────────────────────────────────

    private async cmdKillswitch(interaction: ChatInputCommandInteraction): Promise<void> {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('killswitch_on').setLabel('🛑 ENABLE').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('killswitch_off').setLabel('✅ Disable').setStyle(ButtonStyle.Success),
        );

        const embed = new EmbedBuilder()
            .setTitle('⚠️ Kill Switch')
            .setColor(Colors.Red)
            .setDescription('Enabling stops all trading immediately.');

        await interaction.reply({ embeds: [embed], components: [row] });
    }

    // ─── /test ──────────────────────────────────────────

    private async cmdTest(interaction: ChatInputCommandInteraction): Promise<void> {
        const userId = this.discordUserId(interaction);
        const user = this.userDb.getOrCreateUser(userId, interaction.user.username, interaction.user.globalName ?? undefined);

        const testWallet = user.wallets[0] || '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

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
            contractAddress: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
            tokenId: '4562',
            tokenStandard: 'ERC721',
            quantity: 1,
            price: BigInt('32500000000000000000'),
            priceFormatted: '32.5 ETH',
            currency: 'ETH',
            marketplace: 'opensea',
            metadata: {
                name: 'Bored Ape #4562',
                collection: 'Bored Ape Yacht Club',
            },
        };

        const embed = formatNotification(testEvent);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`confirm_buy:${testEvent.id}`).setLabel('✅ Buy').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`cancel_buy:${testEvent.id}`).setLabel('❌ Skip').setStyle(ButtonStyle.Secondary),
        );

        try {
            await interaction.reply({ content: '🧪 **Sending test alert...**', flags: ['Ephemeral'] });
            await interaction.followUp({ embeds: [embed], components: [row] });
        } catch (e) {
            await interaction.reply({ content: `❌ Test failed: ${(e as Error).message}`, flags: ['Ephemeral'] });
        }
    }

    // ── Button handler ───────────────────────────────────

    private async handleButton(interaction: ButtonInteraction): Promise<void> {
        const id = interaction.customId;
        const userId = this.snowflakeToNumericId(interaction.user.id);

        try {
            if (id === 'autobuy_on') {
                this.userDb.updateSettings(userId, { autoBuyEnabled: true });
                await interaction.update({
                    embeds: [new EmbedBuilder().setTitle('🟢 Auto-Buy ENABLED').setColor(Colors.Green).setDescription('Bot will auto-buy when tracked wallets buy.')],
                    components: [],
                });
            } else if (id === 'autobuy_off') {
                this.userDb.updateSettings(userId, { autoBuyEnabled: false });
                await interaction.update({
                    embeds: [new EmbedBuilder().setTitle('🔴 Auto-Buy DISABLED').setColor(Colors.Red)],
                    components: [],
                });
            } else if (id === 'activate_premium') {
                await interaction.deferUpdate();
                this.userDb.upgradeToPremium(userId);
                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('⭐ Welcome to Premium!')
                            .setColor(Colors.Gold)
                            .setDescription(
                                'You now have access to:\n' +
                                '• 100 wallet tracking\n• Price alerts\n• Portfolio tracking\n• Snipe mode\n\nEnjoy! 🎉'
                            ),
                    ],
                    components: [],
                });
            } else if (id === 'killswitch_on') {
                if (this.onToggleKillSwitch) this.onToggleKillSwitch(true);
                await interaction.update({
                    embeds: [new EmbedBuilder().setTitle('🛑 Kill Switch ENABLED').setColor(Colors.Red)],
                    components: [],
                });
            } else if (id === 'killswitch_off') {
                if (this.onToggleKillSwitch) this.onToggleKillSwitch(false);
                await interaction.update({
                    embeds: [new EmbedBuilder().setTitle('✅ Kill Switch DISABLED').setColor(Colors.Green)],
                    components: [],
                });
            } else if (id.startsWith('confirm_buy:')) {
                const eventId = id.replace('confirm_buy:', '');
                const pending = this.pendingConfirmations.get(eventId);

                if (!pending || Date.now() > pending.expiresAt) {
                    await interaction.reply({ content: '⏰ Confirmation expired.', ephemeral: true });
                    return;
                }

                this.pendingConfirmations.delete(eventId);
                await interaction.update({
                    embeds: [new EmbedBuilder().setTitle('⏳ Executing buy...').setColor(Colors.Yellow)],
                    components: [],
                });

                if (this.onConfirmBuy) {
                    const result = await this.onConfirmBuy(pending.event, 1);
                    const resultEmbed = formatTradeResult(result, pending.event);
                    await interaction.editReply({ embeds: [resultEmbed] });
                }
            } else if (id.startsWith('cancel_buy:')) {
                const eventId = id.replace('cancel_buy:', '');
                this.pendingConfirmations.delete(eventId);
                if (this.onCancelBuy) this.onCancelBuy(eventId);
                await interaction.update({
                    embeds: [new EmbedBuilder().setTitle('❌ Buy cancelled').setColor(Colors.Red)],
                    components: [],
                });
            }
        } catch (e) {
            logger.error('Button handler error', { id, error: e });
        }
    }

    // ── Outbound notifications (called by index-discord.ts) ──

    /**
     * Send NFT event notification to all users tracking the wallet.
     * In Discord we DM the users (like Telegram private messages).
     */
    async sendEventNotification(event: NFTEvent): Promise<void> {
        const users = this.userDb.getUsersTrackingWallet(event.trackedWallet);
        const embed = formatNotification(event);

        for (const user of users) {
            try {
                const discordUser = await this.findDiscordUser(user.id);
                if (!discordUser) continue;

                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`confirm_buy:${event.id}`).setLabel('✅ Buy').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`cancel_buy:${event.id}`).setLabel('❌ Skip').setStyle(ButtonStyle.Secondary),
                );

                // Store pending confirmation
                this.pendingConfirmations.set(event.id, {
                    event,
                    userId: discordUser.id,
                    expiresAt: Date.now() + 5 * 60 * 1000,
                });

                const dm = await discordUser.createDM();
                await dm.send({
                    embeds: [embed],
                    components: user.settings.autoBuyEnabled ? [] : [row],
                });

                // Auto-buy if enabled
                if (user.settings.autoBuyEnabled && this.onConfirmBuy) {
                    const result = await this.onConfirmBuy(event, 1);
                    const resultEmbed = formatTradeResult(result, event);
                    await dm.send({ embeds: [resultEmbed] });
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
        const users = Object.values((this.userDb as any)['data'].users).filter(
            (u: any) => (u as User).tier === 'premium'
        ) as User[];

        const embed = new EmbedBuilder()
            .setTitle('🐋 WHALE ALERT')
            .setColor(Colors.DarkAqua)
            .addFields(
                { name: 'Wallet', value: `\`${event.trackedWallet.slice(0, 10)}...\``, inline: true },
                { name: 'Action', value: event.type.toUpperCase(), inline: true },
                { name: 'Price', value: event.priceFormatted, inline: true },
                { name: 'Collection', value: `\`${event.contractAddress.slice(0, 10)}...\``, inline: true },
            );

        for (const user of users) {
            try {
                const discordUser = await this.findDiscordUser(user.id);
                if (!discordUser) continue;
                const dm = await discordUser.createDM();
                await dm.send({ embeds: [embed] });
            } catch (e) {
                logger.error('Failed to send whale alert', { userId: user.id });
            }
        }
    }

    /**
     * Send price alert via DM
     */
    async sendPriceAlert(userId: number, message: string): Promise<void> {
        try {
            const discordUser = await this.findDiscordUser(userId);
            if (!discordUser) return;
            const dm = await discordUser.createDM();
            await dm.send({ content: message });
        } catch (e) {
            logger.error('Failed to send price alert', { userId });
        }
    }

    /**
     * Send startup notification to all registered users
     */
    async sendStartupNotification(message: string): Promise<void> {
        const users = Object.values((this.userDb as any)['data'].users) as User[];
        for (const user of users) {
            try {
                const discordUser = await this.findDiscordUser(user.id);
                if (!discordUser) continue;
                const dm = await discordUser.createDM();
                await dm.send({ content: message });
            } catch (e) {
                logger.error('Failed to send startup notification', { userId: user.id });
            }
        }
    }

    // ── Helpers ──────────────────────────────────────────

    private extractAlchemyKey(rpcUrl?: string): string | undefined {
        if (!rpcUrl) return undefined;
        const match = rpcUrl.match(/alchemy\.com\/v2\/([a-zA-Z0-9_-]+)/);
        return match?.[1];
    }

    /**
     * Find a Discord user by numeric id stored in DB.
     * We store a hashed version; for DMs we need the real snowflake.
     * For now if the user interacted via slash commands, the client will have them cached.
     */
    private async findDiscordUser(numericId: number) {
        // Search client cache for the user whose hashed snowflake matches
        for (const [snowflake, user] of this.client.users.cache) {
            if (this.snowflakeToNumericId(snowflake) === numericId) {
                return user;
            }
        }
        return null;
    }
}
