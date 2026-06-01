import { z } from 'zod';

// Ethereum address validation
const ethAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

// Solana address validation (base58, 32-44 chars)
const solAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana address');

// Wallet address that can be either ETH or SOL
const walletAddressSchema = z.union([ethAddressSchema, solAddressSchema]);

// Chain configuration
const ethereumConfigSchema = z.object({
    enabled: z.boolean().default(true),
    rpcUrl: z.string().url(),
    wsUrl: z.string().url(),
    privateRpc: z.string().url().optional(),
    chainId: z.number().default(1),
});

const solanaConfigSchema = z.object({
    enabled: z.boolean().default(false),
    rpcUrl: z.string().url(),
    wsUrl: z.string().url(),
    commitment: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
});

// Trading configuration
const tradingConfigSchema = z.object({
    enabled: z.boolean().default(false),
    requireConfirmation: z.boolean().default(true),
    maxSpendPerTx: z.number().positive().default(0.5),
    maxDailySpend: z.number().positive().default(2.0),
    slippageTolerance: z.number().min(0).max(1).default(0.05),
    priorityFeeMultiplier: z.number().min(1).max(10).default(1.5),
});

// Telegram configuration
const telegramConfigSchema = z.object({
    botToken: z.string().min(1),
    chatId: z.string().min(1),
    allowedUserIds: z.array(z.number()).optional(),
});

// Discord configuration
const discordConfigSchema = z.object({
    botToken: z.string().min(1),
    clientId: z.string().min(1),
    guildId: z.string().optional(),
    notificationChannelId: z.string().optional(),
    notificationRoleId: z.string().optional(),
});

// Safety configuration
const safetyConfigSchema = z.object({
    killSwitchEnabled: z.boolean().default(true),
    readOnlyMode: z.boolean().default(true),
    logAllTransactions: z.boolean().default(true),
    rateLimitPerMinute: z.number().positive().default(60),
});

// Logging configuration
const loggingConfigSchema = z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    file: z.string().optional(),
    console: z.boolean().default(true),
});

// Main configuration schema
export const configSchema = z.object({
    // Wallets to track
    trackedWallets: z.array(walletAddressSchema).default([]),

    // Chain settings
    ethereum: ethereumConfigSchema.optional(),
    solana: solanaConfigSchema.optional(),

    // Trading
    trading: tradingConfigSchema.default({}),

    // Notifications
    telegram: telegramConfigSchema,
    discord: discordConfigSchema.optional(),

    // Safety
    safety: safetyConfigSchema.default({}),

    // Logging
    logging: loggingConfigSchema.default({}),

    // Redis for job queue
    redisUrl: z.string().default('redis://localhost:6379'),

    // Wallet encryption password
    walletEncryptionPassword: z.string().min(16),
});

// Export types derived from schema
export type Config = z.infer<typeof configSchema>;
export type EthereumConfig = z.infer<typeof ethereumConfigSchema>;
export type SolanaConfig = z.infer<typeof solanaConfigSchema>;
export type TradingConfig = z.infer<typeof tradingConfigSchema>;
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;
export type DiscordConfig = z.infer<typeof discordConfigSchema>;
export type SafetyConfig = z.infer<typeof safetyConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

// Validation helpers
export function validateConfig(config: unknown): Config {
    return configSchema.parse(config);
}

export function isEthAddress(address: string): boolean {
    return ethAddressSchema.safeParse(address).success;
}

export function isSolAddress(address: string): boolean {
    return solAddressSchema.safeParse(address).success;
}
