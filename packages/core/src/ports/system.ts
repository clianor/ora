export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  createSessionId(): string;
  createCallId(): string;
}
