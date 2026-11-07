
/**
 * Raw USB CDC-ACM debug/shell terminal, separate from ControlPort's JSON API.
 */

const MESHYQ_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x2fe3, usbProductId: 0x0004 }
];

export class TerminalPort {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readTask: Promise<void> | null = null;
  private closing = false;

  get connected(): boolean {
    return this.port !== null;
  }

  async connect(): Promise<void> {
    if (this.port) return;

    const port = await navigator.serial.requestPort({
      filters: MESHYQ_FILTERS
    });

    await port.open({ baudRate: 115200 });

    this.closing = false;
    this.port = port;
  }

  get readable(): ReadableStream<Uint8Array> | null {
    return this.port?.readable ?? null;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.port?.writable ?? null;
  }

  startReading(
    onText: (text: string) => void,
    onDisconnect: (error?: Error) => void
  ): void {
    if (!this.port?.readable || this.readTask) return;

    const port = this.port;
    const decoder = new TextDecoder();

    this.readTask = (async () => {
      let failure: Error | undefined;

      try {
        while (!this.closing && port.readable) {
          const reader = port.readable.getReader();
          this.reader = reader;

          try {
            while (!this.closing) {
              const { value, done } = await reader.read();

              if (done) break;

              if (value) {
                onText(decoder.decode(value, { stream: true }));
              }
            }
          } finally {
            reader.releaseLock();

            if (this.reader === reader) {
              this.reader = null;
            }
          }

          if (this.closing || !port.readable) break;
        }
      } catch (err) {
        if (!this.closing) {
          failure = err instanceof Error
            ? err
            : new Error(String(err));
        }
      } finally {
        const tail = decoder.decode();

        if (tail) onText(tail);

        this.readTask = null;

        if (!this.closing) {
          this.port = null;

          try {
            await port.close();
          } catch {
            // Port may already be disconnected.
          }

          onDisconnect(failure);
        }
      }
    })();
  }

  async send(text: string): Promise<void> {
    const stream = this.port?.writable;

    if (!stream) {
      throw new Error("Debug terminal is not connected.");
    }

    const writer = stream.getWriter();

    try {
      await writer.write(new TextEncoder().encode(text));
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    const port = this.port;

    if (!port) return;

    this.closing = true;

    try {
      if (this.reader) {
        await this.reader.cancel();
      }

      if (this.readTask) {
        await this.readTask;
      }

      await port.close();
    } finally {
      this.reader = null;
      this.readTask = null;
      this.port = null;
    }
  }
}
