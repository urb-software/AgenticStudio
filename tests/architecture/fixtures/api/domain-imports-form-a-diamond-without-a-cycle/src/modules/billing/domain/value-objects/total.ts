import type { Net } from './net.js';
import type { Tax } from './tax.js';

export interface Total {
  readonly net: Net;
  readonly tax: Tax;
}
