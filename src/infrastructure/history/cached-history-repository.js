function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export class CachedHistoryRepository {
  constructor({ loadMonth }) {
    if (typeof loadMonth !== 'function') throw new TypeError('loadMonth is required');
    this.loadMonth = loadMonth;
    this.cache = new Map();
    this.requests = new Map();
  }

  async getMonth(userId, monthKey) {
    const key = `${userId || 'current'}:${monthKey}`;
    if (this.cache.has(key)) return clone(this.cache.get(key));
    if (!this.requests.has(key)) {
      const request = Promise.resolve(this.loadMonth(userId, monthKey))
        .then((value) => {
          this.cache.set(key, value);
          return value;
        })
        .finally(() => this.requests.delete(key));
      this.requests.set(key, request);
    }
    return clone(await this.requests.get(key));
  }

  clear() {
    this.cache.clear();
  }
}
