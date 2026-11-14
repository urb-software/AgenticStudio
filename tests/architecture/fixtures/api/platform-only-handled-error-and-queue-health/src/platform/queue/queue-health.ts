export abstract class QueueHealth {
  abstract isAvailable(): Promise<boolean>;
}
