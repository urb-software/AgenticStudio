export const classifyAddress = (address: string): string =>
  address.startsWith('10.') ? 'private' : 'public';
