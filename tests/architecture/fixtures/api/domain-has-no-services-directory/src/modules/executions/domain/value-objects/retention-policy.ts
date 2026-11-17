export class RetentionPolicy {
  private constructor(readonly days: number) {}

  static of(days: number): RetentionPolicy {
    return new RetentionPolicy(days);
  }

  keepsFor(ageInDays: number): boolean {
    return ageInDays <= this.days;
  }
}
