// Only merge adjacent compatible events. Button/key transitions are barriers:
// a pointer move after a click must never be moved to before the click.
class InputQueue {
  constructor() { this.items = []; this.coalesced = 0; this.maximum = 0; }
  push(message) {
    const last = this.items.at(-1);
    if (last?.kind === 'resize' && message.kind === 'resize') this.items[this.items.length - 1] = message;
    else if (last?.kind === 'text' && message.kind === 'text' && last.text.length + message.text.length <= 65536) last.text += message.text;
    else if (last?.kind === 'input' && message.kind === 'input' && last.event.type === message.event.type &&
      last.event.button === message.event.button && JSON.stringify(last.event.modifiers) === JSON.stringify(message.event.modifiers) &&
      message.event.type === 'mouseMove') this.items[this.items.length - 1] = message;
    else if (last?.kind === 'input' && message.kind === 'input' && last.event.type === 'mouseWheel' && message.event.type === 'mouseWheel' &&
      last.event.x === message.event.x && last.event.y === message.event.y &&
      last.event.deltaX * message.event.deltaX >= 0 && last.event.deltaY * message.event.deltaY >= 0 && JSON.stringify(last.event.modifiers) === JSON.stringify(message.event.modifiers)) {
      last.event.deltaX += message.event.deltaX; last.event.deltaY += message.event.deltaY;
    } else { this.items.push(message); this.maximum = Math.max(this.maximum, this.items.length); return; }
    this.coalesced++;
  }
  shift() { return this.items.shift(); }
  get length() { return this.items.length; }
}
module.exports = { InputQueue };
