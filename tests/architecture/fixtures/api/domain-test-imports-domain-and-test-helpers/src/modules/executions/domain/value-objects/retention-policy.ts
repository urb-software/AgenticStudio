export class RetentionPolicy {
  constructor(readonly days: number) {}

  keepsFor(ageInDays: number): boolean {
    return ageInDays <= this.days;
  }
}
