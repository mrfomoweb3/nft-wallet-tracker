import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('retry');

export interface RetryOptions {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    retryableErrors?: (error: Error) => boolean;
    onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryableErrors' | 'onRetry'>> = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
};

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with exponential backoff retry logic
 */
export async function retry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let lastError: Error | null = null;
    let delay = opts.initialDelayMs;

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            // Check if error is retryable
            if (opts.retryableErrors && !opts.retryableErrors(lastError)) {
                throw lastError;
            }

            // Log retry
            logger.warn(`Attempt ${attempt}/${opts.maxAttempts} failed`, {
                error: lastError.message,
                nextRetryIn: attempt < opts.maxAttempts ? delay : 'N/A',
            });

            // Call retry callback
            if (opts.onRetry) {
                opts.onRetry(lastError, attempt);
            }

            // If this was the last attempt, throw
            if (attempt === opts.maxAttempts) {
                throw lastError;
            }

            // Wait before retrying
            await sleep(delay);

            // Increase delay with exponential backoff
            delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
        }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError ?? new Error('Retry failed');
}

/**
 * Common retryable error checkers
 */
export const retryableErrors = {
    // Network errors
    isNetworkError: (error: Error): boolean => {
        const networkErrors = [
            'ECONNRESET',
            'ECONNREFUSED',
            'ETIMEDOUT',
            'ENOTFOUND',
            'network',
            'timeout',
            'socket hang up',
        ];
        return networkErrors.some(e =>
            error.message.toLowerCase().includes(e.toLowerCase())
        );
    },

    // Rate limit errors
    isRateLimitError: (error: Error): boolean => {
        return (
            error.message.includes('429') ||
            error.message.toLowerCase().includes('rate limit') ||
            error.message.toLowerCase().includes('too many requests')
        );
    },

    // Combined checker
    isTransientError: (error: Error): boolean => {
        return (
            retryableErrors.isNetworkError(error) ||
            retryableErrors.isRateLimitError(error)
        );
    },
};

/**
 * Debounce function execution
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
    fn: T,
    delayMs: number
): (...args: Parameters<T>) => void {
    let timeoutId: NodeJS.Timeout | null = null;

    return (...args: Parameters<T>) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => fn(...args), delayMs);
    };
}

/**
 * Throttle function execution
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
    fn: T,
    limitMs: number
): (...args: Parameters<T>) => void {
    let lastRun = 0;
    let timeoutId: NodeJS.Timeout | null = null;

    return (...args: Parameters<T>) => {
        const now = Date.now();
        const timeSinceLastRun = now - lastRun;

        if (timeSinceLastRun >= limitMs) {
            lastRun = now;
            fn(...args);
        } else if (!timeoutId) {
            timeoutId = setTimeout(() => {
                lastRun = Date.now();
                timeoutId = null;
                fn(...args);
            }, limitMs - timeSinceLastRun);
        }
    };
}
