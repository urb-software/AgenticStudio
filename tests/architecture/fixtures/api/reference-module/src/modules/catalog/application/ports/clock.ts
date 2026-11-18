// A port: an interface a handler needs from outside; its adapter is in infrastructure/adapters/.
export interface Clock {
  now(): number;
}
