import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = Symbol('IS_PUBLIC');

/**
 * Opts a route out of the session guard. Every route is protected unless marked;
 * keep the public surface to health and login (security.md §8).
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
