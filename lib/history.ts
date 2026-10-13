/** Immutable document history. UI selection and viewport never enter the stack. */
export class DocumentHistory<T> {
  past: T[] = [];
  future: T[] = [];
  private key: string | undefined;
  private last = 0;
  private transaction = false;
  private recorded = false;
  private limit: number;
  constructor(limit = 60) {
    this.limit = limit;
  }
  reset() {
    this.past = [];
    this.future = [];
    this.key = undefined;
    this.transaction = false;
    this.recorded = false;
  }
  begin() {
    this.transaction = true;
    this.recorded = false;
    this.key = undefined;
  }
  end() {
    this.transaction = false;
    this.recorded = false;
    this.key = undefined;
  }
  record(before: T, after: T, group?: string, now = Date.now()) {
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    const merge = this.transaction
      ? this.recorded
      : !!group && group === this.key && now - this.last < 800;
    if (!merge) this.past = [...this.past.slice(-(this.limit - 1)), before];
    this.recorded = true;
    this.future = [];
    this.key = group;
    this.last = now;
    return true;
  }
  undo(current: T) {
    const value = this.past.pop();
    if (value === undefined) return null;
    this.future.push(current);
    this.end();
    return value;
  }
  redo(current: T) {
    const value = this.future.pop();
    if (value === undefined) return null;
    this.past.push(current);
    this.end();
    return value;
  }
}
