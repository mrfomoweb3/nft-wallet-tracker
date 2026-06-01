import { config as dotenvConfig } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { Config, validateConfig } from './schema.js';

// Load environment variables
dotenvConfig();

/**
 * ConfigManager - Handles loading, validation, and access to configuration
 */
class ConfigManager {
    private config: Config | null = null;
    private configPath: string | null = null;

    /**
     * Load configuration from environment variables and optional config file
     */
    load(configFilePath?: string): Config {
        // Start with environment variables
        const envConfig = this.loadFromEnv();

        // Optionally merge with config file
        let fileConfig = {};
        if (configFilePath && existsSync(configFilePath)) {
            this.configPath = configFilePath;
            const fileContent = readFileSync(configFilePath, 'utf-8');
            fileConfig = JSON.parse(fileContent);
        }

        // Merge configs (env takes precedence)
        const mergedConfig = this.mergeConfigs(fileConfig, envConfig);

        // Validate and store
        this.config = validateConfig(mergedConfig);
        return this.config;
    }

    /**
     * Load configuration from environment variables
     */
    private loadFromEnv(): Partial<Config> {
        const config: Record<string, unknown> = {};

        // Tracked wallets (comma-separated)
        if (process.env.TRACKED_WALLETS) {
            config.trackedWallets = process.env.TRACKED_WALLETS.split(',').map(w => w.trim());
        }

        // Ethereum config
        if (process.env.ETH_RPC_URL) {
            config.ethereum = {
                enabled: process.env.ETH_ENABLED !== 'false',
                rpcUrl: process.env.ETH_RPC_URL,
                wsUrl: process.env.ETH_WS_URL || process.env.ETH_RPC_URL.replace('https', 'wss'),
                privateRpc: process.env.ETH_PRIVATE_RPC,
                chainId: parseInt(process.env.ETH_CHAIN_ID || '1', 10),
            };
        }

        // Solana config
        if (process.env.SOL_RPC_URL) {
            config.solana = {
                enabled: process.env.SOL_ENABLED !== 'false',
                rpcUrl: process.env.SOL_RPC_URL,
                wsUrl: process.env.SOL_WS_URL || process.env.SOL_RPC_URL.replace('https', 'wss'),
                commitment: (process.env.SOL_COMMITMENT as 'confirmed') || 'confirmed',
            };
        }

        // Trading config
        config.trading = {
            enabled: process.env.TRADING_ENABLED === 'true',
            requireConfirmation: process.env.REQUIRE_CONFIRMATION !== 'false',
            maxSpendPerTx: parseFloat(process.env.MAX_SPEND_PER_TX || '0.5'),
            maxDailySpend: parseFloat(process.env.MAX_DAILY_SPEND || '2.0'),
            slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || '0.05'),
            priorityFeeMultiplier: parseFloat(process.env.PRIORITY_FEE_MULTIPLIER || '1.5'),
        };

        // Telegram config
        if (process.env.TELEGRAM_BOT_TOKEN) {
            config.telegram = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID || '',
                allowedUserIds: process.env.TELEGRAM_ALLOWED_USERS
                    ? process.env.TELEGRAM_ALLOWED_USERS.split(',').map(id => parseInt(id.trim(), 10))
                    : undefined,
            };
        }

        // Discord config
        if (process.env.DISCORD_BOT_TOKEN) {
            config.discord = {
                botToken: process.env.DISCORD_BOT_TOKEN,
                clientId: process.env.DISCORD_CLIENT_ID || '',
                guildId: process.env.DISCORD_GUILD_ID || undefined,
                notificationChannelId: process.env.DISCORD_NOTIFICATION_CHANNEL_ID || undefined,
                notificationRoleId: process.env.DISCORD_NOTIFICATION_ROLE_ID || undefined,
            };
        }

        // Safety config
        config.safety = {
            killSwitchEnabled: process.env.KILL_SWITCH_ENABLED !== 'false',
            readOnlyMode: process.env.READ_ONLY_MODE !== 'false',
            logAllTransactions: process.env.LOG_ALL_TRANSACTIONS !== 'false',
            rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '60', 10),
        };

        // Logging config
        config.logging = {
            level: (process.env.LOG_LEVEL as 'info') || 'info',
            file: process.env.LOG_FILE,
            console: process.env.LOG_CONSOLE !== 'false',
        };

        // Redis
        config.redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

        // Wallet encryption
        config.walletEncryptionPassword = process.env.WALLET_ENCRYPTION_PASSWORD || '';

        return config as Partial<Config>;
    }

    /**
     * Deep merge two configuration objects
     */
    private mergeConfigs(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
        const result = { ...base };

        for (const [key, value] of Object.entries(override)) {
            if (value !== undefined && value !== null && value !== '') {
                if (typeof value === 'object' && !Array.isArray(value)) {
                    result[key] = this.mergeConfigs(
                        (base[key] as Record<string, unknown>) || {},
                        value as Record<string, unknown>
                    );
                } else {
                    result[key] = value;
                }
            }
        }

        return result;
    }

    /**
     * Get the current configuration
     */
    get(): Config {
        if (!this.config) {
            throw new Error('Configuration not loaded. Call load() first.');
        }
        return this.config;
    }

    /**
     * Reload configuration from disk
     */
    reload(): Config {
        return this.load(this.configPath || undefined);
    }

    /**
     * Check if a specific chain is enabled
     */
    isChainEnabled(chain: 'ethereum' | 'solana'): boolean {
        const cfg = this.get();
        return cfg[chain]?.enabled ?? false;
    }

    /**
     * Check if trading is enabled
     */
    isTradingEnabled(): boolean {
        const cfg = this.get();
        return cfg.trading.enabled && !cfg.safety.readOnlyMode;
    }

    /**
     * Check if read-only mode is active
     */
    isReadOnly(): boolean {
        return this.get().safety.readOnlyMode;
    }
}

// Export singleton instance
export const configManager = new ConfigManager();

// Re-export types
export * from './schema.js';
