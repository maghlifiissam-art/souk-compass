// Hard cap on outbound calls per run (Workers Free allows 50 subrequests per request).
export class Budget {
  constructor(max = 40) { this.max = max; this.used = 0; this.log = []; }
  spend(kind) {
    if (this.used >= this.max) throw new Error("call budget exhausted");
    this.used++; this.log.push(kind);
  }
}
