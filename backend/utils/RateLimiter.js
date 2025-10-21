class RateLimiter {
  constructor(concurrency = 1, maxQueue = 50) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
    this._stats = { executed: 0, queued: 0, failures: 0 }; // renomeado para evitar colisão com método stats()
  }

  execute(fn) {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueue) {
        this._stats.failures++;
        return reject(new Error('RateLimiter queue full'));
      }
      this.queue.push({ fn, resolve, reject });
      this._stats.queued = this.queue.length;
      this._tryNext();
    });
  }

  _tryNext() {
    if (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this._stats.queued = this.queue.length;
      this.active++;
      Promise.resolve()
        .then(() => item.fn())
        .then(result => {
          this.active--;
          this._stats.executed++;
          item.resolve(result);
          this._tryNext();
        })
        .catch(err => {
          this.active--;
          this._stats.failures++;
          item.reject(err);
          this._tryNext();
        });
    }
  }

  stats() {
    return {
      ...this._stats,
      active: this.active,
      queue: this.queue.length,
      concurrency: this.concurrency,
      maxQueue: this.maxQueue
    };
  }

  abort() {  // Novo: cancela fila
    this.queue.forEach(({ reject }) => reject(new Error('Aborted')));
    this.queue = [];
    this.processing = false;
  }
}

module.exports = RateLimiter;