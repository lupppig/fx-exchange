declare module 'redlock' {
  import { Redis } from 'ioredis';

  export interface Options {
    driftFactor?: number;
    retryCount?: number;
    retryDelay?: number;
    retryJitter?: number;
  }

  export class Lock {
    readonly resources: string[];
    readonly value: string;
    readonly expiration: number;
    release(): Promise<void>;
  }

  export default class Redlock {
    constructor(clients: Redis[], options?: Options);
    acquire(resources: string[], ttl: number): Promise<Lock>;
    release(lock: Lock): Promise<void>;
    on(event: 'error' | 'clientError', callback: (err: any) => void): this;
  }
}
