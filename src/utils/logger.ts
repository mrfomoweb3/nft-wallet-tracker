import winston from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level}]: ${message}`;

    // Add stack trace for errors
    if (stack) {
        log += `\n${stack}`;
    }

    // Add metadata if present
    if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
    }

    return log;
});

// JSON format for file logging
const jsonFormat = printf(({ level, message, timestamp, ...meta }) => {
    return JSON.stringify({
        timestamp,
        level,
        message,
        ...meta,
    });
});

/**
 * Create and configure the logger
 */
function createLogger(options: {
    level?: string;
    file?: string;
    console?: boolean;
} = {}): winston.Logger {
    const {
        level = 'info',
        file,
        console: enableConsole = true,
    } = options;

    const transports: winston.transport[] = [];

    // Console transport with colors
    if (enableConsole) {
        transports.push(
            new winston.transports.Console({
                format: combine(
                    colorize({ all: true }),
                    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                    errors({ stack: true }),
                    logFormat
                ),
            })
        );
    }

    // File transport with JSON format
    if (file) {
        // Ensure log directory exists
        const logDir = dirname(file);
        if (!existsSync(logDir)) {
            mkdirSync(logDir, { recursive: true });
        }

        transports.push(
            new winston.transports.File({
                filename: file,
                format: combine(
                    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                    errors({ stack: true }),
                    jsonFormat
                ),
                maxsize: 10 * 1024 * 1024, // 10MB
                maxFiles: 5,
            })
        );

        // Separate error log
        transports.push(
            new winston.transports.File({
                filename: file.replace('.log', '.error.log'),
                level: 'error',
                format: combine(
                    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                    errors({ stack: true }),
                    jsonFormat
                ),
                maxsize: 10 * 1024 * 1024,
                maxFiles: 5,
            })
        );
    }

    return winston.createLogger({
        level,
        transports,
        exitOnError: false,
    });
}

// Default logger instance (will be reconfigured when config loads)
let logger = createLogger();

/**
 * Initialize logger with configuration
 */
export function initLogger(options: {
    level?: string;
    file?: string;
    console?: boolean;
}): winston.Logger {
    logger = createLogger(options);
    return logger;
}

/**
 * Get the current logger instance
 */
export function getLogger(): winston.Logger {
    return logger;
}

// Export default logger for convenience
export { logger };

// Child logger creator for modules
export function createModuleLogger(moduleName: string): winston.Logger {
    return logger.child({ module: moduleName });
}
