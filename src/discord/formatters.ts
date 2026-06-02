import { EmbedBuilder, Colors } from 'discord.js';
import { NFTEvent, TradeResult, Chain, Marketplace } from '../types/index.js';

/**
 * Format an NFT event as a Discord embed notification
 */
export function formatNotification(event: NFTEvent): EmbedBuilder {
    const emoji = getEventEmoji(event.type);
    const chainEmoji = getChainEmoji(event.chain);
    const marketplaceLabel = formatMarketplace(event.marketplace);

    const collectionName = event.metadata?.collection || 'Unknown Collection';
    const nftName = event.metadata?.name || `#${event.tokenId}`;

    const embed = new EmbedBuilder()
        .setTitle(`${emoji} ${formatEventType(event.type).toUpperCase()} ${chainEmoji}`)
        .setColor(getEventColor(event.type))
        .setTimestamp();

    // Collection + NFT name
    embed.addFields(
        { name: '📚 Collection', value: `**${collectionName}**`, inline: true },
        { name: '🎨 NFT', value: nftName, inline: true },
    );

    // Price
    if (event.price > 0n) {
        embed.addFields({ name: '💰 Price', value: event.priceFormatted, inline: true });
    }

    // Quantity for ERC-1155
    if (event.quantity > 1) {
        embed.addFields({ name: '📦 Quantity', value: event.quantity.toString(), inline: true });
    }

    // Marketplace
    if (event.marketplace !== 'unknown') {
        embed.addFields({ name: '🏪 Via', value: marketplaceLabel, inline: true });
    }

    // Token standard
    embed.addFields({ name: '📋 Standard', value: event.tokenStandard, inline: true });

    // Wallet info — show label if available
    const walletDisplay = event.walletLabel
        ? `**${event.walletLabel}** (\`${shortenAddress(event.trackedWallet)}\`)`
        : `\`${shortenAddress(event.trackedWallet)}\``;
    embed.addFields({ name: '👛 Tracked Wallet', value: walletDisplay, inline: false });

    // From/To
    if (event.type === 'buy' || event.type === 'mint') {
        embed.addFields({ name: '📥 Bought by', value: `\`${shortenAddress(event.to)}\``, inline: true });
    } else if (event.type === 'sell') {
        embed.addFields(
            { name: '📤 Sold by', value: `\`${shortenAddress(event.from)}\``, inline: true },
            { name: '📥 Bought by', value: `\`${shortenAddress(event.to)}\``, inline: true },
        );
    }

    // Contract
    embed.addFields({ name: '📍 Contract', value: `\`${shortenAddress(event.contractAddress)}\``, inline: true });

    // Links
    const explorerUrl = getExplorerTxUrl(event.chain, event.txHash);
    const nftUrl = getExplorerNFTUrl(event.chain, event.contractAddress, event.tokenId);
    embed.addFields({ name: '🔗 Links', value: `[Etherscan](${explorerUrl}) • [OpenSea](${nftUrl})`, inline: false });

    // Speed indicator
    const delayMs = Date.now() - event.timestamp;
    const delaySec = Math.max(0, Math.round(delayMs / 1000));
    embed.setFooter({ text: `⚡ Alert sent ${delaySec}s after transaction` });

    return embed;
}

/**
 * Format a trade result as a Discord embed
 */
export function formatTradeResult(result: TradeResult, event: NFTEvent): EmbedBuilder {
    if (result.success) {
        const embed = new EmbedBuilder()
            .setTitle('✅ Copy-Buy Successful!')
            .setColor(Colors.Green)
            .addFields(
                { name: '🎨 Contract', value: `\`${shortenAddress(event.contractAddress)}\``, inline: true },
                { name: '🔢 Token ID', value: event.tokenId, inline: true },
            );

        if (result.actualPrice) {
            embed.addFields({ name: '💰 Price Paid', value: formatPrice(result.actualPrice, event.chain), inline: true });
        }
        if (result.gasUsed) {
            embed.addFields({ name: '⛽ Gas Used', value: result.gasUsed.toString(), inline: true });
        }
        if (result.txHash) {
            embed.addFields({ name: '🔗 Transaction', value: `[View](${getExplorerTxUrl(event.chain, result.txHash)})`, inline: false });
        }

        return embed;
    } else {
        return new EmbedBuilder()
            .setTitle('❌ Copy-Buy Failed')
            .setColor(Colors.Red)
            .addFields({ name: '⚠️ Error', value: result.error || 'Unknown error' })
            .setDescription('The NFT may have been sold or the price changed.');
    }
}

/**
 * Format wallet list as a Discord embed
 */
export function formatWalletList(wallets: string[], limit: number, labels: Record<string, string> = {}): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle(`👛 Your Tracked Wallets (${wallets.length}/${limit})`)
        .setColor(Colors.Blue);

    if (wallets.length === 0) {
        embed.setDescription('📭 No wallets tracked.\n\nUse `/track` to add one.');
    } else {
        embed.setDescription(
            wallets.map((w, i) => {
                const label = labels[w.toLowerCase()];
                return label
                    ? `${i + 1}. **${label}**\n    \`${w}\``
                    : `${i + 1}. \`${w}\``;
            }).join('\n')
        );
    }

    return embed;
}

// ── Helpers ──────────────────────────────────────────────

function getEventEmoji(type: string): string {
    switch (type) {
        case 'mint': return '🆕';
        case 'buy': return '💰';
        case 'sell': return '📤';
        case 'transfer': return '↔️';
        default: return '📦';
    }
}

function getEventColor(type: string): number {
    switch (type) {
        case 'mint': return Colors.Purple;
        case 'buy': return Colors.Green;
        case 'sell': return Colors.Orange;
        case 'transfer': return Colors.Blue;
        default: return Colors.Grey;
    }
}

function getChainEmoji(chain: Chain): string {
    switch (chain) {
        case 'ethereum': return '⟠';
        case 'solana': return '◎';
        default: return '🔗';
    }
}

function formatEventType(type: string): string {
    switch (type) {
        case 'mint': return 'NFT Minted';
        case 'buy': return 'NFT Bought';
        case 'sell': return 'NFT Sold';
        case 'transfer': return 'NFT Transferred';
        default: return 'NFT Event';
    }
}

function formatMarketplace(marketplace: Marketplace): string {
    switch (marketplace) {
        case 'opensea': return 'OpenSea';
        case 'blur': return 'Blur';
        case 'looksrare': return 'LooksRare';
        case 'x2y2': return 'X2Y2';
        case 'magiceden': return 'Magic Eden';
        case 'tensor': return 'Tensor';
        case 'rarible': return 'Rarible';
        default: return 'Unknown';
    }
}

function shortenAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatPrice(price: bigint, chain: Chain): string {
    const decimals = chain === 'solana' ? 9 : 18;
    const divisor = BigInt(10 ** decimals);
    const whole = price / divisor;
    const fraction = price % divisor;
    const currency = chain === 'solana' ? 'SOL' : 'ETH';
    return `${whole}.${fraction.toString().padStart(decimals, '0').slice(0, 4)} ${currency}`;
}

function getExplorerTxUrl(chain: Chain, txHash: string): string {
    switch (chain) {
        case 'ethereum': return `https://etherscan.io/tx/${txHash}`;
        case 'solana': return `https://solscan.io/tx/${txHash}`;
        default: return `#`;
    }
}

function getExplorerNFTUrl(chain: Chain, contract: string, tokenId: string): string {
    switch (chain) {
        case 'ethereum': return `https://opensea.io/assets/ethereum/${contract}/${tokenId}`;
        case 'solana': return `https://magiceden.io/item-details/${contract}`;
        default: return `#`;
    }
}
