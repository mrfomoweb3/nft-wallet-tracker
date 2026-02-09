import { NFTEvent } from '../types/index.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('spam-filter');

// Known spam/airdrop contracts (regularly updated)
const KNOWN_SPAM_CONTRACTS = new Set([
    // Add known spam contract addresses here (lowercase)
    '0x0000000000000000000000000000000000000000',
]);

// Spam indicators in contract names
const SPAM_KEYWORDS = [
    'airdrop',
    'claim',
    'free mint',
    'suspicious',
    '$',
    'visit',
    '.com',
    '.xyz',
];

/**
 * SpamFilter - Filters out spam NFTs and zero-value transfers
 */
export class SpamFilter {
    private spamContracts: Set<string>;
    private allowedContracts: Set<string>;

    constructor() {
        this.spamContracts = new Set(KNOWN_SPAM_CONTRACTS);
        this.allowedContracts = new Set();
    }

    /**
     * Check if an event is spam
     */
    isSpam(event: NFTEvent): boolean {
        const contractLower = event.contractAddress.toLowerCase();

        // Allowed contracts bypass spam check
        if (this.allowedContracts.has(contractLower)) {
            return false;
        }

        // Known spam contract
        if (this.spamContracts.has(contractLower)) {
            logger.debug('Blocked known spam contract', { contract: contractLower });
            return true;
        }

        // Zero-value transfers that aren't mints are suspicious
        if (event.price === 0n && event.type === 'transfer') {
            logger.debug('Filtered zero-value transfer', { contract: contractLower });
            return true;
        }

        // Check metadata for spam indicators
        if (event.metadata) {
            const name = (event.metadata.name || '').toLowerCase();
            const collection = (event.metadata.collection || '').toLowerCase();

            for (const keyword of SPAM_KEYWORDS) {
                if (name.includes(keyword) || collection.includes(keyword)) {
                    logger.debug('Filtered spam keyword', { keyword, name, collection });
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Add a contract to the spam list
     */
    addSpamContract(address: string): void {
        this.spamContracts.add(address.toLowerCase());
        logger.info('Added spam contract', { address });
    }

    /**
     * Remove a contract from the spam list
     */
    removeSpamContract(address: string): void {
        this.spamContracts.delete(address.toLowerCase());
        logger.info('Removed spam contract', { address });
    }

    /**
     * Add a contract to the allowed list (bypass spam check)
     */
    addAllowedContract(address: string): void {
        this.allowedContracts.add(address.toLowerCase());
        logger.info('Added allowed contract', { address });
    }

    /**
     * Get spam statistics
     */
    getStats(): { spamContracts: number; allowedContracts: number } {
        return {
            spamContracts: this.spamContracts.size,
            allowedContracts: this.allowedContracts.size,
        };
    }
}
