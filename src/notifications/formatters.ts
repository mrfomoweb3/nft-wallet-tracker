import { NFTEvent, TradeResult, Chain, Marketplace } from '../types/index.js';

/**
 * Format an NFT event as a Telegram notification message
 */
export function formatNotification(event: NFTEvent): string {
    const emoji = getEventEmoji(event.type);
    const chainEmoji = getChainEmoji(event.chain);
    const marketplaceLabel = formatMarketplace(event.marketplace);

    // Header: action type + collection name
    const collectionName = event.metadata?.collection || 'Unknown Collection';
    const nftName = event.metadata?.name || `#${event.tokenId}`;

    const lines = [
        `${emoji} *${formatEventType(event.type).toUpperCase()}* ${chainEmoji}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📚 *${collectionName}*`,
        `🎨 ${nftName}`,
        '',
    ];

    // Price section
    if (event.price > 0n) {
        lines.push(`💰 *Price:* ${event.priceFormatted}`);
    }

    // Quantity for ERC-1155
    if (event.quantity > 1) {
        lines.push(`📦 *Quantity:* ${event.quantity}`);
    }

    // Marketplace
    if (event.marketplace !== 'unknown') {
        lines.push(`🏪 *Via:* ${marketplaceLabel}`);
    }

    // Token standard
    lines.push(`📋 *Standard:* ${event.tokenStandard}`);

    lines.push('');
    lines.push(`━━━━━━━━━━━━━━━━━━━━`);

    // Wallet info — show label if available
    const walletDisplay = event.walletLabel
        ? `*${event.walletLabel}* (\`${shortenAddress(event.trackedWallet)}\`)`
        : `\`${shortenAddress(event.trackedWallet)}\``;
    lines.push(`👛 *Tracked Wallet:* ${walletDisplay}`);

    // From/To
    if (event.type === 'buy' || event.type === 'mint') {
        lines.push(`📥 *Bought by:* \`${shortenAddress(event.to)}\``);
    } else if (event.type === 'sell') {
        lines.push(`📤 *Sold by:* \`${shortenAddress(event.from)}\``);
        lines.push(`📥 *Bought by:* \`${shortenAddress(event.to)}\``);
    }

    // Contract
    lines.push(`📍 *Contract:* \`${shortenAddress(event.contractAddress)}\``);

    // Links section
    lines.push('');
    lines.push(`🔗 [Etherscan](${getExplorerTxUrl(event.chain, event.txHash)}) • [OpenSea](${getExplorerNFTUrl(event.chain, event.contractAddress, event.tokenId)})`);

    // Speed indicator
    const delayMs = Date.now() - event.timestamp;
    const delaySec = Math.max(0, Math.round(delayMs / 1000));
    lines.push(`⚡ Alert sent ${delaySec}s after transaction`);

    return lines.join('\n');
}

/**
 * Format a trade result notification
 */
export function formatTradeResult(result: TradeResult, event: NFTEvent): string {
    if (result.success) {
        return [
            '✅ *Copy-Buy Successful!*',
            '',
            `🎨 *Contract:* \`${shortenAddress(event.contractAddress)}\``,
            `🔢 *Token ID:* ${event.tokenId}`,
            result.actualPrice ? `💰 *Price Paid:* ${formatPrice(result.actualPrice, event.chain)}` : '',
            result.gasUsed ? `⛽ *Gas Used:* ${result.gasUsed.toString()}` : '',
            '',
            result.txHash ? `🔗 [View Transaction](${getExplorerTxUrl(event.chain, result.txHash)})` : '',
        ].filter(Boolean).join('\n');
    } else {
        return [
            '❌ *Copy-Buy Failed*',
            '',
            `⚠️ *Error:* ${result.error || 'Unknown error'}`,
            '',
            'The NFT may have been sold or the price changed.',
        ].join('\n');
    }
}

/**
 * Format wallet list for display
 */
export function formatWalletList(wallets: string[], labels: Record<string, string> = {}): string {
    if (wallets.length === 0) {
        return '📭 No wallets being tracked.';
    }

    const lines = [
        '📋 *Tracked Wallets*',
        '',
        ...wallets.map((w, i) => {
            const label = labels[w.toLowerCase()];
            return label
                ? `${i + 1}. *${label}*\n    \`${w}\``
                : `${i + 1}. \`${w}\``;
        }),
        '',
        `Total: ${wallets.length} wallet(s)`,
    ];

    return lines.join('\n');
}

/**
 * Get emoji for event type
 */
function getEventEmoji(type: string): string {
    switch (type) {
        case 'mint': return '🆕';
        case 'buy': return '💰';
        case 'sell': return '📤';
        case 'transfer': return '↔️';
        default: return '📦';
    }
}

/**
 * Get emoji for chain
 */
function getChainEmoji(chain: Chain): string {
    switch (chain) {
        case 'ethereum': return '⟠';
        case 'solana': return '◎';
        default: return '🔗';
    }
}

/**
 * Format event type for display
 */
function formatEventType(type: string): string {
    switch (type) {
        case 'mint': return 'NFT Minted';
        case 'buy': return 'NFT Bought';
        case 'sell': return 'NFT Sold';
        case 'transfer': return 'NFT Transferred';
        default: return 'NFT Event';
    }
}

/**
 * Format marketplace name
 */
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

/**
 * Shorten address for display
 */
function shortenAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Format price with currency
 */
function formatPrice(price: bigint, chain: Chain): string {
    const decimals = chain === 'solana' ? 9 : 18;
    const divisor = BigInt(10 ** decimals);
    const whole = price / divisor;
    const fraction = price % divisor;
    const currency = chain === 'solana' ? 'SOL' : 'ETH';

    return `${whole}.${fraction.toString().padStart(decimals, '0').slice(0, 4)} ${currency}`;
}

/**
 * Get block explorer transaction URL
 */
function getExplorerTxUrl(chain: Chain, txHash: string): string {
    switch (chain) {
        case 'ethereum':
            return `https://etherscan.io/tx/${txHash}`;
        case 'solana':
            return `https://solscan.io/tx/${txHash}`;
        default:
            return `#`;
    }
}

/**
 * Get block explorer NFT URL
 */
function getExplorerNFTUrl(chain: Chain, contract: string, tokenId: string): string {
    switch (chain) {
        case 'ethereum':
            return `https://opensea.io/assets/ethereum/${contract}/${tokenId}`;
        case 'solana':
            return `https://magiceden.io/item-details/${contract}`;
        default:
            return `#`;
    }
}
