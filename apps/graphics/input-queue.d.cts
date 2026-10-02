export class InputQueue {
  items: any[];
  coalesced: number;
  maximum: number;
  push(message: any): void;
  shift(): any;
  readonly length: number;
}
