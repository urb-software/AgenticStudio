import { PROVIDERS } from '@agentic-studio/contracts/providers';
import { parse } from 'yaml';
import { helper } from './helper.js';

export const check = (text: string) => helper(parse(text), PROVIDERS);
