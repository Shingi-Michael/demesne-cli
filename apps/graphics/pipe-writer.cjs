// A pipe can fail asynchronously after write() returns. Keep its error listener
// installed through shutdown, and stop all later writes/callbacks once it closes.
class PipeWriter {
  constructor(stream, onClose) {
    this.stream = stream;
    this.onClose = onClose;
    this.closed = false;
    stream.on("error", (error) => this.close(error));
    stream.on("close", () => this.close());
    stream.on("finish", () => this.close());
  }
  write(data, done) {
    if (this.closed) return false;
    if (this.stream.destroyed || this.stream.writableEnded || this.stream.writable === false) {
      this.close();
      return false;
    }
    try {
      return this.stream.write(data, (error) => {
        if (error) this.close(error);
        else if (!this.closed) done?.();
      });
    } catch (error) {
      this.close(error);
      return false;
    }
  }
  close(error) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(error);
  }
}
function isDisconnect(error) {
  return !error || ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes(error.code);
}
module.exports = { PipeWriter, isDisconnect };
