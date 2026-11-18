function classifyAddress(address: string): string {
  return address.startsWith('10.') ? 'private' : 'public';
}

export class RemoteAddress {
  private constructor(readonly range: string) {}

  static of(address: string): RemoteAddress {
    return new RemoteAddress(classifyAddress(address));
  }
}
