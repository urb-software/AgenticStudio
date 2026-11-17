function classifyAddress(address: string): string {
  return address.startsWith('10.') ? 'private' : 'public';
}

export class RemoteAddress {
  static classify(address: string): string {
    return classifyAddress(address);
  }
}
