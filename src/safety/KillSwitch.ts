import { EventEmitter } from 'events';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { KillSwitchState } from '../types/index.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('killswitch');

/**
 * KillSwitch - Emergency stop for all trading activity
 * 
 * When triggered:
 * - Blocks all new trade executions
 * - Cancels pending confirmation requests
 * - Continues monitoring (notifications only)
 */
export class KillSwitch extends EventEmitter {
    private state: KillSwitchState;
    private persistPath: string | null = null;

    constructor(persistPath?: string) {
        super();
        this.state = { triggered: false };
        this.persistPath = persistPath || null;

        // Load persisted state if available
        if (persistPath) {
            this.loadState();
        }
    }

    /**
     * Check if kill switch is triggered
     */
    isTriggered(): boolean {
        return this.state.triggered;
    }

    /**
     * Trigger the kill switch
     */
    trigger(triggeredBy: string, reason?: string): void {
        logger.warn('Kill switch TRIGGERED', { triggeredBy, reason });

        this.state = {
            triggered: true,
            triggeredAt: Date.now(),
            triggeredBy,
            reason,
        };

        this.saveState();
        this.emit('triggered', this.state);
    }

    /**
     * Reset the kill switch
     */
    reset(resetBy: string): void {
        if (!this.state.triggered) {
            logger.debug('Kill switch already inactive');
            return;
        }

        logger.info('Kill switch RESET', { resetBy });

        const previousState = { ...this.state };
        this.state = { triggered: false };

        this.saveState();
        this.emit('reset', { previousState, resetBy });
    }

    /**
     * Get current state
     */
    getState(): KillSwitchState {
        return { ...this.state };
    }

    /**
     * Load persisted state
     */
    private loadState(): void {
        if (!this.persistPath || !existsSync(this.persistPath)) {
            return;
        }

        try {
            const data = readFileSync(this.persistPath, 'utf-8');
            this.state = JSON.parse(data);

            if (this.state.triggered) {
                logger.warn('Kill switch was active from previous session', {
                    triggeredAt: new Date(this.state.triggeredAt!).toISOString(),
                    reason: this.state.reason,
                });
            }
        } catch (error) {
            logger.error('Failed to load kill switch state', { error });
        }
    }

    /**
     * Save state to disk
     */
    private saveState(): void {
        if (!this.persistPath) return;

        try {
            const dir = dirname(this.persistPath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            writeFileSync(this.persistPath, JSON.stringify(this.state, null, 2));
        } catch (error) {
            logger.error('Failed to save kill switch state', { error });
        }
    }
}
