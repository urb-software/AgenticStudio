export function classifyAddress(address: string): string {
  return address.startsWith('10.') ? 'private' : 'public';
}
