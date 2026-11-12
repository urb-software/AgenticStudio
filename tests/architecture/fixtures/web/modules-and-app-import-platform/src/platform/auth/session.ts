import { formatName } from '@/shared/lib/format';
import { getJson } from '../api/client';

export async function currentOperator(): Promise<string> {
  return formatName(String(await getJson('/auth/session')));
}
