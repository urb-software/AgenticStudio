import { GetRunHandler } from '../../get-run/handler.js';
import { CancelRunHandler } from '../handler.js';

export const both = [new GetRunHandler(), new CancelRunHandler()];
