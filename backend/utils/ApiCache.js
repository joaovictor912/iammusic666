class ApiCache {
  constructor(ttl = 60 * 60 * 1000, maxSize = 500) {
    this.cache = new Map();
    this.order = []; // Para LRU
    this.priorities = new Map(); // Para priorização
    this.ttl = ttl;
    this.maxSize = maxSize;
    this._stats = { hits: 0, misses: 0 }; // renomeado para evitar colisão com o método stats()
    
    // Prioridades por tipo de dados
    this.defaultPriorities = {
      'spotify_features': 1,    // Alta prioridade
      'lastfm_tags': 2,         // Média prioridade  
      'artist_info': 3,         // Baixa prioridade
      'album_info': 3,
      'track_info': 2,
      'similar_artists': 2
    };
  }

  set(key, value, priority = null) {
    if (typeof key !== 'string') throw new Error('Key must be string');
    this.del(key); // Evict se existir
    
    // Determinar prioridade automaticamente baseada na chave
    if (priority === null) {
      priority = this.detectPriority(key);
    }
    
    this.cache.set(key, { value, t: Date.now(), priority });
    this.priorities.set(key, priority);
    this.order.push(key);
    
    if (this.order.length > this.maxSize) {
      this.evictLowPriority();
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
    this.priorities.delete(key);
    this.order = this.order.filter(k => k !== key);
  }

  detectPriority(key) {
    // Detectar prioridade baseada no padrão da chave
    if (key.includes('spotify_features') || key.includes('audio_features')) return 1;
    if (key.includes('lastfm_tags') || key.includes('lastfm_similar')) return 2;
    if (key.includes('artist_info') || key.includes('album_info')) return 3;
    if (key.includes('track_info')) return 2;
    return 3; // Prioridade baixa por padrão
  }

  evictLowPriority() {
    // Encontrar item com menor prioridade para evict
    let lowestPriority = 3;
    let oldestKey = null;
    let oldestTime = Date.now();
    
    for (const [key, entry] of this.cache.entries()) {
      const priority = this.priorities.get(key) || 3;
      
      if (priority > lowestPriority) {
        lowestPriority = priority;
        oldestKey = key;
        oldestTime = entry.t;
      } else if (priority === lowestPriority && entry.t < oldestTime) {
        oldestKey = key;
        oldestTime = entry.t;
      }
    }
    
    if (oldestKey) {
      this.del(oldestKey);
    } else {
      // Fallback para LRU tradicional
      const oldKey = this.order.shift();
      this.cache.delete(oldKey);
      this.priorities.delete(oldKey);
    }
  }

  stats() {
    const priorityStats = {};
    for (const [key, priority] of this.priorities.entries()) {
      priorityStats[priority] = (priorityStats[priority] || 0) + 1;
    }
    
    return { 
      ...this._stats, 
      size: this.cache.size, 
      ttl: this.ttl,
      priorityDistribution: priorityStats
    };
  }

  clear() {
    this.cache.clear();
    this.order = [];
    this.priorities.clear();
    this._stats = { hits: 0, misses: 0 };
  }
}
module.exports = ApiCache;