export class StartCommandExit extends Error {
  constructor(readonly exitCode: number) {
    super(`start command exited with code ${exitCode}`);
    this.name = "StartCommandExit";
  }
}
