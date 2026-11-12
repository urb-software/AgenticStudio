import { API_BASE } from '@/platform/api/client';

export function apiUrl(path: string): string {
  return API_BASE + path;
}
