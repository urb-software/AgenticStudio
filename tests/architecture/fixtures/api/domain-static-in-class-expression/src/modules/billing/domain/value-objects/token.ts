export const Token = class {
  private constructor(readonly value: string) {}

  static parse(raw: string): string {
    return raw.trim();
  }
};
