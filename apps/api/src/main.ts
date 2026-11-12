import { createApp } from './app.js';
import { loadConfig } from './platform/config/config.js';

// Fail fast: an invalid environment stops the process before Nest starts.
const config = loadConfig(process.env);
const app = await createApp(config);
// SIGINT/SIGTERM run the shutdown hooks, which disconnect the database client.
app.enableShutdownHooks();
await app.listen(config.apiPort);
