#!/usr/bin/env node
import { runCrawl } from './runCrawl.js';
import { logger } from '../logger.js';
function parseArgs(argv) {
    const args = argv.slice(2);
    let clientId = null;
    let domain = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--client-id' && args[i + 1]) {
            clientId = args[i + 1];
            i += 1;
            continue;
        }
        if (arg === '--domain' && args[i + 1]) {
            domain = args[i + 1];
            i += 1;
            continue;
        }
        let match = arg.match(/^--client-id=(.+)$/);
        if (match) {
            clientId = match[1];
            continue;
        }
        match = arg.match(/^--domain=(.+)$/);
        if (match) {
            domain = match[1];
            continue;
        }
    }
    // 🔹 Fallback: se non ho trovato le flag, prova a leggere come posizionali
    if (!clientId && args.length >= 1 && !args[0].startsWith('-')) {
        clientId = args[0];
    }
    if (!domain && args.length >= 2 && !args[1].startsWith('-')) {
        domain = args[1];
    }
    return { clientId, domain };
}
async function main() {
    try {
        const { clientId, domain } = parseArgs(process.argv);
        if (!clientId || !domain) {
            console.error('Usage: npm run crawl -- --client-id <uuid> --domain example.com');
            process.exit(1);
        }
        await runCrawl(clientId, domain);
    }
    catch (err) {
        logger.error('Fatal error in crawler CLI', err);
        process.exit(1);
    }
}
main();
