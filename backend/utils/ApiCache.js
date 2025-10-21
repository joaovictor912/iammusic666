class ApiCache {
  constructor(ttl = 60 * 60 * 1000, maxSize = 500) {
    this.cache = new Map();
    this.order = []; // Para LRU
    this.ttl = ttl;
    this.maxSize = maxSize;
    this._stats = { hits: 0, misses: 0 }; // renomeado para evitar colisão com o método stats()
  }

  set(key, value) {
    if (typeof key !== 'string') throw new Error('Key must be string');
    this.del(key); // Evict se existir
    this.cache.set(key, { value, t: Date.now() });
    this.order.push(key);
    if (this.order.length > this.maxSize) {
      const oldKey = this.order.shift();
      this.cache.delete(oldKey);
    }
  }

  get(key) {
    const e = this.cache.get(key);
    if (!e) {
      this._stats.misses++;
      return null;
    }
    if (Date.now() - e.t > this.ttl) {
      this.del(key);
      this._stats.misses++;
      return null;
    }
    // LRU: Move para fim
    this.order = this.order.filter(k => k !== key);
    this.order.push(key);
    this._stats.hits++;
    return e.value;
  }

  del(key) {
    this.cache.delete(key);
    this.order = this.order.filter(k => k !== key);
  }

  stats() {
    return { ...this._stats, size: this.cache.size, ttl: this.ttl };
  }

  clear() {
    this.cache.clear();
    this.order = [];
    this._stats = { hits: 0, misses: 0 };
  }
}
module.exports = ApiCache;