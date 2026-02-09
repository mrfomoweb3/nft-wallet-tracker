import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { TransactionLog } from '../types/index.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('tx-logger');

interface TransactionData {
    transactions: TransactionLog[];
}

/**
 * TransactionLogger - Logs all trading transactions for audit trail
 * Uses JSON file storage for simplicity and portability
 */
export class TransactionLogger {
    private dbPath: string;
    private data: TransactionData;

    constructor(dbPath: string) {
        this.dbPath = dbPath.replace('.db', '.json');
        this.data = this.load();
    }

    /**
     * Load data from JSON file
     */
    private load(): TransactionData {
        try {
            if (existsSync(this.dbPath)) {
                const content = readFileSync(this.dbPath, 'utf-8');
                const parsed = JSON.parse(content);
                // Convert price strings back to bigint
                parsed.transactions = parsed.transactions.map((tx: Record<string, unknown>) => ({
                    ...tx,
                    price: BigInt(tx.price as string),
                    gasUsed: tx.gasUsed ? BigInt(tx.gasUsed as string) : undefined,
                }));
                return parsed;
            }
        } catch (error) {
            logger.error('Failed to load transaction data', { error });
        }
        return { transactions: [] };
    }

    /**
     * Save data to JSON file
     */
    private save(): void {
        try {
            const dir = dirname(this.dbPath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            // Convert bigint to string for JSON serialization
            const serializable = {
                transactions: this.data.transactions.map(tx => ({
                    ...tx,
                    price: tx.price.toString(),
                    gasUsed: tx.gasUsed?.toString(),
                })),
            };
            writeFileSync(this.dbPath, JSON.stringify(serializable, null, 2));
        } catch (error) {
            logger.error('Failed to save transaction data', { error });
        }
    }

    /**
     * Log a transaction
     */
    log(tx: TransactionLog): void {
        // Remove existing transaction with same id if exists
        this.data.transactions = this.data.transactions.filter(t => t.id !== tx.id);
        this.data.transactions.push(tx);
        this.save();

        logger.info('Transaction logged', {
            id: tx.id,
            type: tx.type,
            status: tx.status,
            txHash: tx.ourTxHash,
        });
    }

    /**
     * Update transaction status
     */
    updateStatus(id: string, status: 'pending' | 'confirmed' | 'failed', error?: string): void {
        const tx = this.data.transactions.find(t => t.id === id);
        if (tx) {
            tx.status = status;
            if (error) tx.error = error;
            this.save();
        }
    }

    /**
     * Get transaction by ID
     */
    getById(id: string): TransactionLog | null {
        return this.data.transactions.find(t => t.id === id) || null;
    }

    /**
     * Get recent transactions
     */
    getRecent(limit: number = 50): TransactionLog[] {
        return this.data.transactions
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }

    /**
     * Get transactions by status
     */
    getByStatus(status: 'pending' | 'confirmed' | 'failed'): TransactionLog[] {
        return this.data.transactions
            .filter(t => t.status === status)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Get transaction statistics
     */
    getStats(): {
        total: number;
        pending: number;
        confirmed: number;
        failed: number;
        totalSpent: bigint;
    } {
        const stats = {
            total: this.data.transactions.length,
            pending: 0,
            confirmed: 0,
            failed: 0,
            totalSpent: 0n,
        };

        for (const tx of this.data.transactions) {
            if (tx.status === 'pending') stats.pending++;
            else if (tx.status === 'confirmed') {
                stats.confirmed++;
                stats.totalSpent += tx.price;
            }
            else if (tx.status === 'failed') stats.failed++;
        }

        return stats;
    }

    /**
     * Close (no-op for JSON storage, but keeps interface consistent)
     */
    close(): void {
        // No cleanup needed for JSON file storage
    }
}
