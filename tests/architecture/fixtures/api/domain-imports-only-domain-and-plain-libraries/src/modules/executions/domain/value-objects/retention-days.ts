export class RetentionDays {
  static readonly DEFAULT = 7;

  private constructor(readonly value: number) {}

  static of(value: number): RetentionDays {
    return new RetentionDays(value);
  }
}
