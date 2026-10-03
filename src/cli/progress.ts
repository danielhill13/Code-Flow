/** How often a non-terminal (a CI log, a pipe) gets a progress line. */
const LOG_INTERVAL_MS = 30_000;

/**
 * One status line for long-running work. On a terminal it is rewritten in place; elsewhere it
 * prints at most every 30 seconds, so a slow step never looks the same as a hung one.
 */
export class Progress {
  readonly #stream: NodeJS.WriteStream;
  #onScreen = false;
  #lastLogged: number | null = null;

  constructor(stream: NodeJS.WriteStream = process.stdout) {
    this.#stream = stream;
  }

  /** Text must be plain: colour codes would break the in-place rewrite. */
  update(text: string): void {
    if (this.#stream.isTTY) {
      const width = this.#stream.columns || 80;
      this.#stream.write(`\r\x1b[2K${text.slice(0, width - 1)}`);
      this.#onScreen = true;
    } else if (this.#lastLogged === null || Date.now() - this.#lastLogged >= LOG_INTERVAL_MS) {
      this.#stream.write(`${text}\n`);
      this.#lastLogged = Date.now();
    }
  }

  /** Removes the line, so ordinary output can follow. */
  clear(): void {
    if (!this.#onScreen) return;
    this.#stream.write("\r\x1b[2K");
    this.#onScreen = false;
  }
}
