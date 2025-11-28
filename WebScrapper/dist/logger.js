const levelOrder = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
const envLevel = process.env.LOG_LEVEL || 'info';
export const logger = {
    debug: (...args) => {
        if (levelOrder[envLevel] <= levelOrder.debug)
            console.debug('[DEBUG]', ...args);
    },
    info: (...args) => {
        if (levelOrder[envLevel] <= levelOrder.info)
            console.info('[INFO]', ...args);
    },
    warn: (...args) => {
        if (levelOrder[envLevel] <= levelOrder.warn)
            console.warn('[WARN]', ...args);
    },
    error: (...args) => {
        if (levelOrder[envLevel] <= levelOrder.error)
            console.error('[ERROR]', ...args);
    },
};
