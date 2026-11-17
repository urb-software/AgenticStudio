class Run {
  private constructor(readonly state: string) {}

  static start(): Run {
    return new Run('queued');
  }
}

export { Run };
