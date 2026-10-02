export class TileFrame {
  width: number; height: number; epoch: number; columns: number; rows: number;
  bitmap: Buffer; dirty: Set<number>;
  reset(width: number, height: number, tileWidth: number, tileHeight: number, bitmap: Buffer, epoch: number): void;
  update(source: Buffer, width: number, height: number, rect: {x:number;y:number;width:number;height:number}): boolean;
  drain(): {epoch:number;width:number;height:number;reset:boolean;tiles: {id:number;x:number;y:number;width:number;height:number;data:Buffer}[]};
}
