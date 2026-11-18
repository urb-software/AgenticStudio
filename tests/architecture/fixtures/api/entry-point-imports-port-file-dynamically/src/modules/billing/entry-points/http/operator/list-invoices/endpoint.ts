export class ListInvoicesEndpoint {
  async token(): Promise<symbol> {
    const { CLOCK } = await import('../../../../application/ports/clock.js');
    return CLOCK;
  }
}
