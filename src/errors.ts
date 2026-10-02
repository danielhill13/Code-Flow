/** A failure the user can fix. The CLI prints the message alone, without a stack trace. */
export class CodeflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeflowError";
  }
}
