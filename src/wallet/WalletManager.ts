import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('wallet');

// Constants for encryption (AES-256-GCM)
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const NONCE_BYTES = 16; // IV for AES-GCM


/**
 * Encrypted wallet data structure
 */
interface EncryptedWallet {
    version: number;
    address: string;
    chain: 'ethereum' | 'solana';
    label?: string;
    encryptedKey: string; // Base64 encoded
    salt: string; // Base64 encoded
    nonce: string; // Base64 encoded
    authTag: string; // Base64 encoded
    createdAt: number;
}

/**
 * Wallet manager storage structure
 */
interface WalletStorage {
    wallets: EncryptedWallet[];
}

/**
 * Decrypted wallet (in memory only, never persisted)
 */
export interface DecryptedWallet {
    address: string;
    privateKey: string;
    chain: 'ethereum' | 'solana';
    label?: string;
}

/**
 * WalletManager - Handles secure wallet storage and encryption
 * 
 * Security features:
 * - AES-256-GCM encryption via Node.js built-in crypto
 * - scrypt key derivation 
 * - Unique salt and nonce per wallet
 * - Private keys only decrypted when needed
 */
export class WalletManager {
    private storagePath: string;
    private password: string;
    private storage: WalletStorage;

    constructor(storagePath: string, password: string) {
        if (!password || password.length < 16) {
            throw new Error('Wallet encryption password must be at least 16 characters');
        }

        this.storagePath = storagePath;
        this.password = password;
        this.storage = { wallets: [] };

        this.loadStorage();
    }

    /**
     * Load wallet storage from disk
     */
    private loadStorage(): void {
        if (existsSync(this.storagePath)) {
            try {
                const data = readFileSync(this.storagePath, 'utf-8');
                this.storage = JSON.parse(data);
                logger.info(`Loaded ${this.storage.wallets.length} encrypted wallets`);
            } catch (error) {
                logger.error('Failed to load wallet storage', { error });
                this.storage = { wallets: [] };
            }
        } else {
            logger.info('No existing wallet storage found, starting fresh');
        }
    }

    /**
     * Save wallet storage to disk
     */
    private saveStorage(): void {
        const dir = dirname(this.storagePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        writeFileSync(this.storagePath, JSON.stringify(this.storage, null, 2));
        logger.debug('Wallet storage saved');
    }

    /**
     * Derive encryption key from password using scrypt
     */
    private deriveKey(salt: Buffer): Buffer {
        return scryptSync(this.password, salt, KEY_BYTES);
    }

    /**
     * Encrypt a private key
     */
    private encryptKey(privateKey: string): { encrypted: Buffer; salt: Buffer; nonce: Buffer; authTag: Buffer } {
        const salt = randomBytes(SALT_BYTES);
        const nonce = randomBytes(NONCE_BYTES);

        const key = this.deriveKey(salt);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);

        const encrypted = Buffer.concat([
            cipher.update(privateKey, 'utf-8'),
            cipher.final()
        ]);

        const authTag = cipher.getAuthTag();

        return { encrypted, salt, nonce, authTag };
    }

    /**
     * Decrypt a private key
     */
    private decryptKey(encrypted: Buffer, salt: Buffer, nonce: Buffer, authTag: Buffer): string {
        const key = this.deriveKey(salt);
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(authTag);

        try {
            const decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ]);
            return decrypted.toString('utf-8');
        } catch {
            throw new Error('Decryption failed - incorrect password or corrupted data');
        }
    }

    /**
     * Add a new wallet
     */
    addWallet(
        privateKey: string,
        address: string,
        chain: 'ethereum' | 'solana',
        label?: string
    ): void {
        // Check if wallet already exists
        if (this.storage.wallets.some(w => w.address.toLowerCase() === address.toLowerCase())) {
            throw new Error(`Wallet ${address} already exists`);
        }

        // Encrypt the private key
        const { encrypted, salt, nonce, authTag } = this.encryptKey(privateKey);

        // Store the encrypted wallet
        const wallet: EncryptedWallet = {
            version: 2, // Updated version for new crypto format
            address,
            chain,
            label,
            encryptedKey: encrypted.toString('base64'),
            salt: salt.toString('base64'),
            nonce: nonce.toString('base64'),
            authTag: authTag.toString('base64'),
            createdAt: Date.now(),
        };

        this.storage.wallets.push(wallet);
        this.saveStorage();

        logger.info(`Wallet added: ${address}`, { chain, label });
    }

    /**
     * Get a decrypted wallet by address
     */
    getWallet(address: string): DecryptedWallet | null {
        const wallet = this.storage.wallets.find(
            w => w.address.toLowerCase() === address.toLowerCase()
        );

        if (!wallet) {
            return null;
        }

        const encrypted = Buffer.from(wallet.encryptedKey, 'base64');
        const salt = Buffer.from(wallet.salt, 'base64');
        const nonce = Buffer.from(wallet.nonce, 'base64');
        const authTag = Buffer.from(wallet.authTag || '', 'base64');

        const privateKey = this.decryptKey(encrypted, salt, nonce, authTag);

        return {
            address: wallet.address,
            privateKey,
            chain: wallet.chain,
            label: wallet.label,
        };
    }

    /**
     * Get all wallet addresses (without decrypting)
     */
    getAddresses(): string[] {
        return this.storage.wallets.map(w => w.address);
    }

    /**
     * Get wallet info (without private key)
     */
    getWalletInfo(address: string): Omit<EncryptedWallet, 'encryptedKey' | 'salt' | 'nonce' | 'authTag'> | null {
        const wallet = this.storage.wallets.find(
            w => w.address.toLowerCase() === address.toLowerCase()
        );

        if (!wallet) {
            return null;
        }

        return {
            version: wallet.version,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            createdAt: wallet.createdAt,
        };
    }

    /**
     * Remove a wallet
     */
    removeWallet(address: string): boolean {
        const initialLength = this.storage.wallets.length;
        this.storage.wallets = this.storage.wallets.filter(
            w => w.address.toLowerCase() !== address.toLowerCase()
        );

        if (this.storage.wallets.length < initialLength) {
            this.saveStorage();
            logger.info(`Wallet removed: ${address}`);
            return true;
        }

        return false;
    }

    /**
     * Check if a wallet exists
     */
    hasWallet(address: string): boolean {
        return this.storage.wallets.some(
            w => w.address.toLowerCase() === address.toLowerCase()
        );
    }

    /**
     * Get wallet count
     */
    getWalletCount(): number {
        return this.storage.wallets.length;
    }

    /**
     * Update wallet label
     */
    updateLabel(address: string, label: string): boolean {
        const wallet = this.storage.wallets.find(
            w => w.address.toLowerCase() === address.toLowerCase()
        );

        if (wallet) {
            wallet.label = label;
            this.saveStorage();
            return true;
        }

        return false;
    }

    /**
     * Get the first available wallet for a chain
     */
    getDefaultWallet(chain: 'ethereum' | 'solana'): DecryptedWallet | null {
        const wallet = this.storage.wallets.find(w => w.chain === chain);

        if (!wallet) {
            return null;
        }

        return this.getWallet(wallet.address);
    }

    /**
     * Alias for getDefaultWallet - used by TradeExecutor
     */
    getPrimaryWallet(chain: 'ethereum' | 'solana'): DecryptedWallet | null {
        return this.getDefaultWallet(chain);
    }
}
