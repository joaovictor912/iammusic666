class VibeClusterer {
  constructor() {
    this.cache = new Map(); // Cache para otimização
    this.distanceCache = new Map(); // Cache específico para distâncias euclidianas
    this.featureWeights = {
      danceability: 1.2,
      energy: 1.5,
      valence: 1.3,
      acousticness: 1.0,
      speechiness: 0.8,
      tempo: 0.7,
      loudness: 0.6,
      instrumentalness: 0.9
    };
  }

  /**
   * Detecta subgrupos de vibe nas seeds com otimizações
   */
  async detectSubgroups(seedTracks, api) {
    if (seedTracks.length < 3) {
      return await this.createSingleGroup(seedTracks, api);
    }

    console.log(`\n🔍 DETECTANDO SUBGRUPOS em ${seedTracks.length} seeds...`);

    // Buscar features de todas as seeds em batch
    const seedIds = seedTracks.map(t => t.id);
    const featMap = await fetchAudioFeaturesMap(api, seedIds);

    // Preparar vetores de features com features dinâmicas
    const relevantFeatures = this.selectRelevantFeatures(featMap);
    const featureVectors = seedTracks.map(track => {
      const feat = featMap.get(track.id);
      if (!feat) return null;

      return {
        track,
        features: feat,
        vector: this.normalizeFeatures(feat, relevantFeatures)
      };
    }).filter(v => v);

    if (featureVectors.length < 3) {
      return await this.createSingleGroup(seedTracks, api);
    }

    // Determinar número ideal de clusters com silhueta
    const k = this.determineOptimalKWithSilhouette(featureVectors);
    console.log(`📊 Número ideal de clusters com análise de silhueta: ${k}`);

    if (k === 1) {
      return await this.createSingleGroup(seedTracks, api);
    }

    // Executar K-means++ com cache
    const clusters = this.kMeans(featureVectors, k);

    // Validar qualidade dos clusters com métricas avançadas
    const validatedClusters = this.validateClustersEnhanced(clusters);

    // Criar subgrupos com análise detalhada
    const subgroups = await this.createSubgroups(validatedClusters, api);

    console.log(` ${subgroups.length} subgrupos detectados:`);
    subgroups.forEach((sg, i) => {
      console.log(`  ${i + 1}. ${sg.label} (${sg.tracks.length} tracks) - ${sg.description}`);
      console.log(`     Tracks: ${sg.tracks.map(t => t.name).join(', ')}`);
      console.log(`     Coesão interna: ${sg.cohesion.toFixed(2)}`);
    });

    return subgroups;
  }

  /**
   * Seleciona features relevantes baseado na variância
   */
  selectRelevantFeatures(featMap) {
    const features = Array.from(featMap.values());
    if (features.length === 0) return null;

    const variances = {};
    const keys = ['danceability', 'energy', 'valence', 'acousticness', 
                 'speechiness', 'tempo', 'loudness', 'instrumentalness'];

    keys.forEach(key => {
      const values = features.map(f => f[key]);
      variances[key] = this.calculateVariance(values);
    });

    // Selecionar features com variância significativa
    return keys.filter(key => variances[key] > 0.01);
  }

  /**
   * Calcula variância de um array de números
   */
  calculateVariance(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Normaliza features com pesos dinâmicos
   */
  normalizeFeatures(feat, relevantFeatures = null) {
    if (!feat) return null;

    // Função helper para limitar valores
    const boundValue = (val, min = 0, max = 1) => 
      Math.max(min, Math.min(max, val));

    const normalized = [
      boundValue(feat.danceability) * this.featureWeights.danceability,
      boundValue(feat.energy) * this.featureWeights.energy,
      boundValue(feat.valence) * this.featureWeights.valence,
      boundValue(feat.acousticness) * this.featureWeights.acousticness,
      boundValue(feat.speechiness) * this.featureWeights.speechiness,
      boundValue(feat.tempo / 200) * this.featureWeights.tempo,
      boundValue((feat.loudness + 60) / 60) * this.featureWeights.loudness,
      boundValue(feat.instrumentalness) * this.featureWeights.instrumentalness
    ];

    // Se temos features relevantes, filtrar
    if (relevantFeatures) {
      const featureNames = ['danceability', 'energy', 'valence', 'acousticness', 
                          'speechiness', 'tempo', 'loudness', 'instrumentalness'];
      return normalized.filter((_, i) => relevantFeatures.includes(featureNames[i]));
    }

    return normalized;
  }

  /**
   * Determina número ideal de clusters usando método da Silhueta
   */
  determineOptimalKWithSilhouette(vectors) {
    const n = vectors.length;

    // Heurísticas baseadas no tamanho
    if (n < 3) return 1;
    if (n <= 4) return 2;
    if (n <= 7) return Math.min(3, Math.floor(n / 2));

    // Para 8+ tracks, usar método da Silhueta
    const maxK = Math.min(4, Math.floor(n / 2));
    let bestK = 1;
    let bestSilhouette = -1;

    for (let k = 2; k <= maxK; k++) {
      const clusters = this.kMeans(vectors, k, 10);
      const silhouetteScore = this.calculateSilhouetteScore(clusters);
      
      if (silhouetteScore > bestSilhouette) {
        bestSilhouette = silhouetteScore;
        bestK = k;
      }
    }

    return bestK;
  }

  /**
   * Calcula score de Silhueta para avaliar qualidade dos clusters
   */
  calculateSilhouetteScore(clusters) {
    let totalSilhouette = 0;
    let totalPoints = 0;

    clusters.forEach((cluster, i) => {
      cluster.forEach(point => {
        // Distância média dentro do cluster (a)
        const a = this.calculateAverageDistance(point, cluster);

        // Distância média para o cluster mais próximo (b)
        let minB = Infinity;
        clusters.forEach((otherCluster, j) => {
          if (i !== j) {
            const b = this.calculateAverageDistance(point, otherCluster);
            minB = Math.min(minB, b);
          }
        });

        // Calcular score de silhueta para o ponto
        const silhouette = (minB - a) / Math.max(a, minB);
        totalSilhouette += silhouette;
        totalPoints++;
      });
    });

    return totalPoints > 0 ? totalSilhouette / totalPoints : 0;
  }

  /**
   * Calcula distância média de um ponto para todos os pontos em um cluster
   */
  calculateAverageDistance(point, cluster) {
    if (cluster.length <= 1) return 0;

    const totalDist = cluster.reduce((sum, other) => {
      if (point === other) return sum;
      return sum + this.euclideanDistance(point.vector, other.vector);
    }, 0);

    return totalDist / (cluster.length - 1);
  }

  /**
   * K-means clustering otimizado com cache
   */
  kMeans(vectors, k, maxIterations = 20) {
    if (k >= vectors.length) {
      return vectors.map(v => [v]);
    }

    // Inicialização K-means++ com cache
    let centroids = this.initializeCentroidsKMeansPlusPlus(vectors, k);
    let previousClusters = null;
    let iteration = 0;
    let converged = false;

    while (!converged && iteration < maxIterations) {
      // Atribuir pontos aos centroids mais próximos
      const clusters = Array.from({ length: k }, () => []);
      
      vectors.forEach(item => {
        let minDist = Infinity;
        let closestCluster = 0;

        centroids.forEach((centroid, i) => {
          const dist = this.getCachedDistance(item.vector, centroid);
          if (dist < minDist) {
            minDist = dist;
            closestCluster = i;
          }
        });

        clusters[closestCluster].push(item);
      });

      // Remover clusters vazios
      const nonEmptyClusters = clusters.filter(c => c.length > 0);

      // Verificar convergência
      converged = previousClusters && this.clustersEqual(previousClusters, nonEmptyClusters);
      
      if (converged) {
        return this.refineClusters(nonEmptyClusters);
      }

      previousClusters = nonEmptyClusters;

      // Recalcular centroids com otimização
      centroids = this.calculateNewCentroids(nonEmptyClusters);
      iteration++;
    }

    return this.refineClusters(previousClusters || []);
  }

  /**
   * Calcula novos centroids de forma otimizada
   */
  calculateNewCentroids(clusters) {
    return clusters.map(cluster => {
      const dim = cluster[0].vector.length;
      const centroid = new Array(dim).fill(0);

      // Soma vetorial otimizada
      cluster.forEach(item => {
        for (let i = 0; i < dim; i++) {
          centroid[i] += item.vector[i];
        }
      });

      // Média vetorial
      for (let i = 0; i < dim; i++) {
        centroid[i] /= cluster.length;
      }

      return centroid;
    });
  }

  /**
   * Refina clusters aplicando técnicas de pós-processamento
   */
  refineClusters(clusters) {
    // Remover outliers
    const refinedClusters = clusters.map(cluster => {
      if (cluster.length <= 3) return cluster;

      const centroid = this.calculateNewCentroids([cluster])[0];
      const distances = cluster.map(point => ({
        point,
        dist: this.euclideanDistance(point.vector, centroid)
      }));

      // Calcular limiar para outliers (método IQR)
      const sortedDists = distances.map(d => d.dist).sort((a, b) => a - b);
      const q1 = sortedDists[Math.floor(sortedDists.length * 0.25)];
      const q3 = sortedDists[Math.floor(sortedDists.length * 0.75)];
      const iqr = q3 - q1;
      const threshold = q3 + (1.5 * iqr);

      return distances
        .filter(d => d.dist <= threshold)
        .map(d => d.point);
    });

    return refinedClusters;
  }

  /**
   * Valida clusters com métricas avançadas
   */
  validateClustersEnhanced(clusters) {
    if (clusters.length === 1) return clusters;

    // Calcular métricas para cada cluster
    const clusterMetrics = clusters.map(cluster => {
      const centroid = this.calculateNewCentroids([cluster])[0];
      const distances = cluster.map(point => 
        this.euclideanDistance(point.vector, centroid)
      );

      return {
        cluster,
        size: cluster.length,
        cohesion: 1 / (1 + this.calculateVariance(distances)),
        separation: this.calculateClusterSeparation(cluster, clusters)
      };
    });

    // Filtrar clusters com base nas métricas
    const validClusters = clusterMetrics
      .filter(metrics => {
        const isValid = metrics.size >= 2 && 
                       metrics.cohesion > 0.4 &&
                       metrics.separation > 0.3;
        return isValid;
      })
      .map(metrics => metrics.cluster);

    if (validClusters.length === 0) {
      return [clusters.flat()];
    }

    return validClusters;
  }

  /**
   * Calcula separação de um cluster em relação aos outros
   */
  calculateClusterSeparation(cluster, allClusters) {
    if (allClusters.length <= 1) return 1;

    const centroid = this.calculateNewCentroids([cluster])[0];
    let minSeparation = Infinity;

    allClusters.forEach(otherCluster => {
      if (otherCluster === cluster) return;

      const otherCentroid = this.calculateNewCentroids([otherCluster])[0];
      const separation = this.euclideanDistance(centroid, otherCentroid);
      minSeparation = Math.min(minSeparation, separation);
    });

    return 1 / (1 + Math.exp(-minSeparation + 2));
  }

  /**
   * Distância euclidiana com cache
   */
  getCachedDistance(v1, v2) {
    const key = `${v1.join(',')}-${v2.join(',')}`;
    
    if (this.distanceCache.has(key)) {
      return this.distanceCache.get(key);
    }

    const dist = Math.sqrt(
      v1.reduce((sum, val, i) => sum + Math.pow(val - v2[i], 2), 0)
    );

    this.distanceCache.set(key, dist);
    return dist;
  }

  euclideanDistance(v1, v2) {
    return this.getCachedDistance(v1, v2);
  }

  /**
   * Criação de subgrupos aprimorada
   */
  async createSubgroups(clusters, api) {
    const subgroups = [];

    for (const cluster of clusters) {
      const tracks = cluster.map(item => item.track);
      const features = cluster.map(item => item.features);

      // Calcular avgVibe e métricas do subgrupo
      const avgVibe = this.calculateAverageVibe(features);
      const mood = this.detectMood(avgVibe);
      const characteristics = this.detectCharacteristics(avgVibe, features);
      
      // Calcular coesão do subgrupo
      const cohesion = this.calculateSubgroupCohesion(cluster);

      // Gerar label e descrição
      const label = this.generateLabel(mood, characteristics);
      const description = this.generateDescription(mood, characteristics, avgVibe);

      subgroups.push({
        tracks,
        avgVibe,
        mood,
        characteristics,
        label,
        description,
        size: tracks.length,
        weight: tracks.length / clusters.reduce((sum, c) => sum + c.length, 0),
        cohesion
      });
    }

    return subgroups;
  }

  /**
   * Calcula coesão de um subgrupo
   */
  calculateSubgroupCohesion(cluster) {
    if (cluster.length <= 1) return 1;

    const centroid = this.calculateNewCentroids([cluster])[0];
    const distances = cluster.map(point => 
      this.euclideanDistance(point.vector, centroid)
    );

    return 1 / (1 + this.calculateVariance(distances));
  }

  /**
   * Calcula média ponderada das características musicais
   */
  calculateAverageVibe(features) {
    const keys = ['danceability', 'energy', 'valence', 'acousticness', 
                 'tempo', 'loudness', 'speechiness', 'instrumentalness'];
    
    const weights = this.featureWeights;
    const avgVibe = {};

    keys.forEach(k => {
      const values = features.map(f => f[k] || 0);
      avgVibe[k] = values.reduce((sum, val, i) => 
        sum + (val * (weights[k] || 1))
      , 0) / features.length;
    });

    return avgVibe;
  }
}

module.exports = {
  VibeClusterer
};