import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('database');

export type SubscriptionTier = 'free' | 'premium';

export interface UserSettings {
    autoBuyEnabled: boolean;
    maxSpendPerTx: number;
    whaleAlertThreshold: number; // in ETH
    priceAlertPercent: number;
    snipeModeEnabled: boolean;
}

export interface PriceAlert {
    collection: string;
    changePercent: number;
    lastFloor: number;
    createdAt: number;
}

export interface User {
    id: number; // Telegram user ID
    username?: string;
    firstName?: string;
    tier: SubscriptionTier;
    wallets: string[];
    priceAlerts: PriceAlert[];
    settings: UserSettings;
    createdAt: number;
    lastActiveAt: number;
}

interface DatabaseData {
    users: Record<string, User>;
    version: number;
}

const DEFAULT_SETTINGS: UserSettings = {
    autoBuyEnabled: false,
    maxSpendPerTx: 0.5,
    whaleAlertThreshold: 1,
    priceAlertPercent: 10,
    snipeModeEnabled: false,
};

const WALLET_LIMITS: Record<SubscriptionTier, number> = {
    free: 1,
    premium: 100,
};

/**
 * UserDatabase - JSON-based multi-user storage
 */
export class UserDatabase {
    private dbPath: string;
    private data: DatabaseData;

    constructor(dbPath: string) {
        this.dbPath = dbPath;
        this.data = this.load();
    }

    private load(): DatabaseData {
        try {
            if (existsSync(this.dbPath)) {
                const content = readFileSync(this.dbPath, 'utf-8');
                return JSON.parse(content);
            }
        } catch (error) {
            logger.error('Failed to load user database', { error });
        }
        return { users: {}, version: 1 };
    }

    private save(): void {
        try {
            const dir = dirname(this.dbPath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
        } catch (error) {
            logger.error('Failed to save user database', { error });
        }
    }

    /**
     * Get or create user
     */
    getOrCreateUser(telegramId: number, username?: string, firstName?: string): User {
        const key = telegramId.toString();

        if (!this.data.users[key]) {
            this.data.users[key] = {
                id: telegramId,
                username,
                firstName,
                tier: 'free',
                wallets: [],
                priceAlerts: [],
                settings: { ...DEFAULT_SETTINGS },
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
            };
            this.save();
            logger.info('New user registered', { telegramId, username });
        } else {
            // Update last active
            this.data.users[key].lastActiveAt = Date.now();
            if (username) this.data.users[key].username = username;
            if (firstName) this.data.users[key].firstName = firstName;
        }

        return this.data.users[key];
    }

    /**
     * Get user by Telegram ID
     */
    getUser(telegramId: number): User | null {
        return this.data.users[telegramId.toString()] || null;
    }

    /**
     * Add wallet to user
     */
    addWallet(telegramId: number, wallet: string): { success: boolean; error?: string } {
        const user = this.getUser(telegramId);
        if (!user) return { success: false, error: 'User not found' };

        const normalizedWallet = wallet.toLowerCase();

        // Check if already tracking
        if (user.wallets.includes(normalizedWallet)) {
            return { success: false, error: 'Already tracking this wallet' };
        }

        // Check tier limit
        const limit = WALLET_LIMITS[user.tier];
        if (user.wallets.length >= limit) {
            return {
                success: false,
                error: `Wallet limit reached (${limit}). Upgrade to Premium for more!`
            };
        }

        user.wallets.push(normalizedWallet);
        this.save();
        logger.info('Wallet added', { telegramId, wallet: normalizedWallet });
        return { success: true };
    }

    /**
     * Remove wallet from user
     */
    removeWallet(telegramId: number, wallet: string): boolean {
        const user = this.getUser(telegramId);
        if (!user) return false;

        const normalizedWallet = wallet.toLowerCase();
        const index = user.wallets.indexOf(normalizedWallet);

        if (index === -1) return false;

        user.wallets.splice(index, 1);
        this.save();
        logger.info('Wallet removed', { telegramId, wallet: normalizedWallet });
        return true;
    }

    /**
     * Get all wallets for a user
     */
    getUserWallets(telegramId: number): string[] {
        const user = this.getUser(telegramId);
        return user?.wallets || [];
    }

    /**
     * Get all tracked wallets across all users
     */
    getAllTrackedWallets(): string[] {
        const wallets = new Set<string>();
        for (const user of Object.values(this.data.users)) {
            for (const wallet of user.wallets) {
                wallets.add(wallet);
            }
        }
        return Array.from(wallets);
    }

    /**
     * Find users tracking a specific wallet
     */
    getUsersTrackingWallet(wallet: string): User[] {
        const normalizedWallet = wallet.toLowerCase();
        return Object.values(this.data.users).filter(
            user => user.wallets.includes(normalizedWallet)
        );
    }

    /**
     * Upgrade user to premium
     */
    upgradeToPremium(telegramId: number): boolean {
        const user = this.getUser(telegramId);
        if (!user) return false;

        user.tier = 'premium';
        this.save();
        logger.info('User upgraded to premium', { telegramId });
        return true;
    }

    /**
     * Update user settings
     */
    updateSettings(telegramId: number, settings: Partial<UserSettings>): boolean {
        const user = this.getUser(telegramId);
        if (!user) return false;

        user.settings = { ...user.settings, ...settings };
        this.save();
        return true;
    }

    /**
     * Add price alert
     */
    addPriceAlert(telegramId: number, collection: string, changePercent: number): { success: boolean; error?: string } {
        const user = this.getUser(telegramId);
        if (!user) return { success: false, error: 'User not found' };

        if (user.tier !== 'premium') {
            return { success: false, error: 'Price alerts are a Premium feature. Use /upgrade' };
        }

        // Check if already has alert for this collection
        const existing = user.priceAlerts.find(a => a.collection.toLowerCase() === collection.toLowerCase());
        if (existing) {
            existing.changePercent = changePercent;
        } else {
            user.priceAlerts.push({
                collection: collection.toLowerCase(),
                changePercent,
                lastFloor: 0,
                createdAt: Date.now(),
            });
        }

        this.save();
        return { success: true };
    }

    /**
     * Remove price alert
     */
    removePriceAlert(telegramId: number, collection: string): boolean {
        const user = this.getUser(telegramId);
        if (!user) return false;

        const index = user.priceAlerts.findIndex(
            a => a.collection.toLowerCase() === collection.toLowerCase()
        );

        if (index === -1) return false;

        user.priceAlerts.splice(index, 1);
        this.save();
        return true;
    }

    /**
     * Get all users with price alerts
     */
    getUsersWithPriceAlerts(): User[] {
        return Object.values(this.data.users).filter(
            user => user.priceAlerts.length > 0
        );
    }

    /**
     * Get user count
     */
    getUserCount(): { total: number; free: number; premium: number } {
        const users = Object.values(this.data.users);
        return {
            total: users.length,
            free: users.filter(u => u.tier === 'free').length,
            premium: users.filter(u => u.tier === 'premium').length,
        };
    }

    /**
     * Get wallet limit for tier
     */
    getWalletLimit(tier: SubscriptionTier): number {
        return WALLET_LIMITS[tier];
    }
}
