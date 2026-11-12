import type { Config } from './types.gen';

export type Middleware = (config: Config) => Config;
