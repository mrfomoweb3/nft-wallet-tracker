import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Chain, SpendingRecord } from '../types/index.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('spending');

interface SpendingEntry {
    date: string;
    chain: Chain;
    amount: string;
    txHash?: string;
    createdAt: number;
}

interface SpendingData {
    entries: SpendingEntry[];
}

/**
 * SpendingTracker - Tracks daily spending per chain for limit enforcement
 * Uses JSON file storage for simplicity and portability
 */
export class SpendingTracker {
    private dbPath: string;
    private data: SpendingData;

    constructor(dbPath: string) {
        this.dbPath = dbPath.replace('.db', '.json');
        this.data = this.load();
    }

    /**
     * Load data from JSON file
     */
    private load(): SpendingData {
        try {
            if (existsSync(this.dbPath)) {
                const content = readFileSync(this.dbPath, 'utf-8');
                return JSON.parse(content);
            }
        } catch (error) {
            logger.error('Failed to load spending data', { error });
        }
        return { entries: [] };
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
            writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
        } catch (error) {
            logger.error('Failed to save spending data', { error });
        }
    }

    /**
     * Record a spending transaction
     */
    recordSpend(chain: Chain, amount: bigint, txHash?: string): void {
        const date = this.getTodayDate();

        const entry: SpendingEntry = {
            date,
            chain,
            amount: amount.toString(),
            txHash,
            createdAt: Date.now(),
        };

        this.data.entries.push(entry);
        this.save();

        logger.info('Spending recorded', {
            date,
            chain,
            amount: amount.toString(),
            txHash,
        });
    }

    /**
     * Get total spending for today
     */
    getTodayTotal(chain: Chain): bigint {
        const date = this.getTodayDate();

        const total = this.data.entries
            .filter(e => e.date === date && e.chain === chain)
            .reduce((sum, e) => sum + BigInt(e.amount), 0n);

        return total;
    }

    /**
     * Get spending history for a date range
     */
    getSpendingHistory(
        chain: Chain,
        startDate: string,
        endDate: string
    ): SpendingRecord[] {
        const filtered = this.data.entries.filter(
            e => e.chain === chain && e.date >= startDate && e.date <= endDate
        );

        // Group by date
        const grouped = new Map<string, { total: bigint; count: number }>();
        for (const entry of filtered) {
            const existing = grouped.get(entry.date) || { total: 0n, count: 0 };
            grouped.set(entry.date, {
                total: existing.total + BigInt(entry.amount),
                count: existing.count + 1,
            });
        }

        return Array.from(grouped.entries()).map(([date, stats]) => ({
            date,
            chain,
            totalSpent: stats.total,
            transactions: stats.count,
        }));
    }

    /**
     * Check if spending is within daily limit
     */
    isWithinDailyLimit(chain: Chain, additionalAmount: bigint, maxDaily: bigint): boolean {
        const todayTotal = this.getTodayTotal(chain);
        return todayTotal + additionalAmount <= maxDaily;
    }

    /**
     * Get remaining daily budget
     */
    getRemainingBudget(chain: Chain, maxDaily: bigint): bigint {
        const todayTotal = this.getTodayTotal(chain);
        const remaining = maxDaily - todayTotal;
        return remaining > 0n ? remaining : 0n;
    }

    /**
     * Get today's date in YYYY-MM-DD format
     */
    private getTodayDate(): string {
        return new Date().toISOString().split('T')[0];
    }

    /**
     * Close (no-op for JSON storage, but keeps interface consistent)
     */
    close(): void {
        // No cleanup needed for JSON file storage
    }
}
