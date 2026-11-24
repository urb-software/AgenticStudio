import { buildController } from './bootstrap.js';
import { ConfigError, loadConfig } from './config.js';
import { JsonLineLogger } from './logger.js';

const logger = new JsonLineLogger();

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  // The message names settings, never their values.
  process.stderr.write(`${error instanceof ConfigError ? error.message : 'Invalid settings.'}\n`);
  process.exit(1);
}

const { controller, runtime } = await buildController(config, logger);
logger.event('controller_started', { outcome: config.runtime });

let stopping = false;
const shutDown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.event('controller_stopping', { outcome: signal });
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutDown(signal);
    void controller.stop();
  });
}

await controller.run();
await runtime.runtime.close();
logger.event('controller_stopped');
process.exit(0);
