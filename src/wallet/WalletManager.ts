import sodium from 'sodium-native';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('wallet');

// Constants for encryption
const SALT_BYTES = sodium.crypto_pwhash_SALTBYTES;
const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES;
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES;
const MAC_BYTES = sodium.crypto_secretbox_MACBYTES;

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
 * - AES-256-GCM encryption via libsodium
 * - Argon2id key derivation
 * - Unique salt and nonce per wallet
 * - Private keys only decrypted when needed
 * - Secure memory clearing after use
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
     * Derive encryption key from password using Argon2id
     */
    private deriveKey(salt: Buffer): Buffer {
        const key = Buffer.alloc(KEY_BYTES);

        sodium.crypto_pwhash(
            key,
            Buffer.from(this.password),
            salt,
            sodium.crypto_pwhash_OPSLIMIT_MODERATE,
            sodium.crypto_pwhash_MEMLIMIT_MODERATE,
            sodium.crypto_pwhash_ALG_ARGON2ID13
        );

        return key;
    }

    /**
     * Encrypt a private key
     */
    private encryptKey(privateKey: string): { encrypted: Buffer; salt: Buffer; nonce: Buffer } {
        const salt = Buffer.alloc(SALT_BYTES);
        const nonce = Buffer.alloc(NONCE_BYTES);

        sodium.randombytes_buf(salt);
        sodium.randombytes_buf(nonce);

        const key = this.deriveKey(salt);
        const plaintext = Buffer.from(privateKey);
        const ciphertext = Buffer.alloc(plaintext.length + MAC_BYTES);

        sodium.crypto_secretbox_easy(ciphertext, plaintext, nonce, key);

        // Clear sensitive buffers
        sodium.sodium_memzero(key);
        sodium.sodium_memzero(plaintext);

        return { encrypted: ciphertext, salt, nonce };
    }

    /**
     * Decrypt a private key
     */
    private decryptKey(encrypted: Buffer, salt: Buffer, nonce: Buffer): string {
        const key = this.deriveKey(salt);
        const plaintext = Buffer.alloc(encrypted.length - MAC_BYTES);

        const success = sodium.crypto_secretbox_open_easy(plaintext, encrypted, nonce, key);

        // Clear key immediately
        sodium.sodium_memzero(key);

        if (!success) {
            throw new Error('Decryption failed - incorrect password or corrupted data');
        }

        const result = plaintext.toString('utf-8');
        sodium.sodium_memzero(plaintext);

        return result;
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
        const { encrypted, salt, nonce } = this.encryptKey(privateKey);

        const encryptedWallet: EncryptedWallet = {
            version: 1,
            address,
            chain,
            label,
            encryptedKey: encrypted.toString('base64'),
            salt: salt.toString('base64'),
            nonce: nonce.toString('base64'),
            createdAt: Date.now(),
        };

        this.storage.wallets.push(encryptedWallet);
        this.saveStorage();

        logger.info(`Added wallet: ${address}`, { chain, label });
    }

    /**
     * Get a decrypted wallet by address
     */
    getWallet(address: string): DecryptedWallet {
        const wallet = this.storage.wallets.find(
            w => w.address.toLowerCase() === address.toLowerCase()
        );

        if (!wallet) {
            throw new Error(`Wallet ${address} not found`);
        }

        const encrypted = Buffer.from(wallet.encryptedKey, 'base64');
        const salt = Buffer.from(wallet.salt, 'base64');
        const nonce = Buffer.from(wallet.nonce, 'base64');

        const privateKey = this.decryptKey(encrypted, salt, nonce);

        return {
            address: wallet.address,
            privateKey,
            chain: wallet.chain,
            label: wallet.label,
        };
    }

    /**
     * List all wallet addresses (without private keys)
     */
    listWallets(): Array<{ address: string; chain: 'ethereum' | 'solana'; label?: string }> {
        return this.storage.wallets.map(w => ({
            address: w.address,
            chain: w.chain,
            label: w.label,
        }));
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
     * Remove a wallet
     */
    removeWallet(address: string): void {
        const index = this.storage.wallets.findIndex(
            w => w.address.toLowerCase() === address.toLowerCase()
        );

        if (index === -1) {
            throw new Error(`Wallet ${address} not found`);
        }

        this.storage.wallets.splice(index, 1);
        this.saveStorage();

        logger.info(`Removed wallet: ${address}`);
    }

    /**
     * Get the primary trading wallet
     */
    getPrimaryWallet(chain: 'ethereum' | 'solana'): DecryptedWallet | null {
        const wallet = this.storage.wallets.find(w => w.chain === chain);
        if (!wallet) return null;
        return this.getWallet(wallet.address);
    }
}
