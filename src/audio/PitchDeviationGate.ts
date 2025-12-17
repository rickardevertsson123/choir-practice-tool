export class PitchDeviationGate {
  private history: number[] = [];
  private readonly confirmFrames: number;
  private readonly spikeResetCents: number;

  constructor(confirmFrames = 2, spikeResetCents = 120) {
    this.confirmFrames = Math.max(1, confirmFrames);
    this.spikeResetCents = Math.max(50, spikeResetCents);
  }

  reset() {
    this.history = [];
  }

  /**
   * Call once per frame with the current distanceCents.
   * Returns the current history length (debug)
   */
  push(distanceCents: number): number {
    // Optional: if something insane happens, reset
    if (Math.abs(distanceCents) >= this.spikeResetCents) {
      this.history = [];
      return 0;
    }

    this.history.push(distanceCents);
    if (this.history.length > this.confirmFrames) this.history.shift();
    return this.history.length;
  }

  /**
   * True only if the last N frames all exceed threshold (same sign not required).
   * This kills 1-frame “blink” errors.
   */
  confirmed(thresholdCents: number): boolean {
    if (this.history.length < this.confirmFrames) return false;
    return this.history.every(v => Math.abs(v) >= thresholdCents);
  }

  /**
   * Confirmed AND consistent sign (useful if you want stable sharp/flat indication).
   */
  confirmedSameSign(thresholdCents: number): boolean {
    if (this.history.length < this.confirmFrames) return false;

    const signs = this.history
      .map(v => (Math.abs(v) >= thresholdCents ? Math.sign(v) : 0))
      .filter(s => s !== 0);

    if (signs.length < this.confirmFrames) return false;
    return signs.every(s => s === signs[0]);
  }
}
