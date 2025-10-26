class ApiError extends Error {
  constructor(message, statusCode = 500, source = undefined) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.source = source;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }
}
const express = require('express');
const cors = require('cors');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();
const ApiCache = require('./utils/ApiCache');
const RateLimiter = require('./utils/RateLimiter');
const app = express();
const port = process.env.PORT || 5000;

if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
  throw new Error('Missing required env vars: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET');
}
if (!process.env.LASTFM_API_KEY) {
  console.warn('Aviso: LASTFM_API_KEY ausente — funcionalidades de fallback Last.fm estarão limitadas.');
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://127.0.0.1:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:5000';
const MAX_CANDIDATES = 150;

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

const lastfmCache = new ApiCache(60 * 60 * 1000, 300);
const spotifyCache = new ApiCache(60 * 60 * 1000, 300);
const lastfmLimiter = new RateLimiter(2, 20);
const spotifyLimiter = new RateLimiter(5, 20);

const artistGenresCache = new Map();

const getArtistsGenres = async (artistIds = [], api) => {
  const ids = Array.from(new Set((artistIds || []).filter(Boolean)));
  const result = {};
  if (!ids.length) return result;
 
  const toFetch = [];
  ids.forEach(id => {
    if (artistGenresCache.has(id)) result[id] = artistGenresCache.get(id);
    else toFetch.push(id);
  });
 
  if (toFetch.length === 0) return result;
 
  const BATCH_SIZE = 50;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    try {
      const d = await spotifyLimiter.execute(() => api.getArtists(batch));
      const artists = (d.body && d.body.artists) ? d.body.artists : [];
      artists.forEach(a => {
        const genres = Array.isArray(a.genres) ? a.genres : [];
        artistGenresCache.set(a.id, genres);
        result[a.id] = genres;
      });
    } catch (e) {
      console.warn('Erro ao buscar artistas em lote:', e.message || e);
      // Fallback individual
      await Promise.all(batch.map(async (id) => {
        try {
          const ind = await spotifyLimiter.execute(() => api.getArtist(id));
          const g = (ind.body && ind.body.genres) ? ind.body.genres : [];
          artistGenresCache.set(id, g);
          result[id] = g;
        } catch (ie) {
          console.warn(`Erro ao buscar artista ${id}:`, ie.message || ie);
          result[id] = [];
        }
      }));
    }
  }
  return result;
};

const createApiInstance = (req) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('Token de acesso não fornecido.');
  // não logar token parcial em produção — apenas indicar presença
  console.debug('Token recebido (presente):', !!token);
  const api = new SpotifyWebApi({ clientId: process.env.SPOTIFY_CLIENT_ID });
  api.setAccessToken(token);
  return api;
};

const authApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: `${BACKEND_URL}/callback`,
});

app.get('/auth', (req, res) => {
  const scopes = ['user-read-private', 'user-read-email', 'playlist-modify-public', 'playlist-modify-private', 'user-top-read'];
  res.redirect(authApi.createAuthorizeURL(scopes));
});

app.get('/callback', async (req, res) => {
  try {
    const data = await authApi.authorizationCodeGrant(req.query.code);
    const { access_token, refresh_token, expires_in } = data.body;
    res.redirect(`${FRONTEND_URL}?access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${expires_in}`);
  } catch (err) {
    console.error('Erro no callback:', err.body?.error?.description || err.body || err.message);
    res.redirect(`${FRONTEND_URL}/?error=token_fail`);
  }
});

app.post('/search', async (req, res) => {
  try {
    const api = createApiInstance(req);
    const { query } = req.body;
    const searchData = await spotifyLimiter.execute(() => api.searchTracks(query, { limit: 1 }));
    const track = searchData.body.tracks.items[0];
    if (!track) return res.status(404).json({ error: 'No track found' });
    res.json({ id: track.id, name: track.name, artist: track.artists[0].name, albumImages: track.album.images, previewUrl: track.preview_url });
  } catch (err) {
    console.error('Erro em /search:', err.body || err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/search-suggestions', async (req, res) => {
  try {
    const api = createApiInstance(req);
    const { query } = req.body;
    const searchData = await spotifyLimiter.execute(() => api.searchTracks(query, { limit: 8 }));
    const tracks = searchData.body.tracks.items.map(track => ({
      id: track.id, name: track.name, artist: track.artists.map(a => a.name).join(', '),
      albumImages: track.album.images, previewUrl: track.preview_url
    }));
    res.json({ tracks });
  } catch (err) {
    console.error('Erro em /search-suggestions:', err.body || err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

const analyzeMusicalSentiment = (trackFeatures, culturalContext = null) => {
  const sentiment = {
    emotional: trackFeatures.valence < 0.3 ? 'melancholic' :
               trackFeatures.valence > 0.7 ? 'uplifting' : 'neutral',
    social: trackFeatures.danceability > 0.7 ? 'party' :
           trackFeatures.danceability < 0.3 ? 'intimate' : 'social',
    cultural: null,
    nostalgic: false,
    intensity: trackFeatures.energy > 0.7 ? 'high' :
              trackFeatures.energy < 0.3 ? 'low' : 'medium'
  };
  if (culturalContext) {
    const { culturalEra } = culturalContext;
    sentiment.cultural = culturalEra;
    if (culturalEra === '90s' || culturalEra === '80s') {
      sentiment.nostalgic = trackFeatures.acousticness > 0.4 || trackFeatures.instrumentalness > 0.3;
    }
  }
  if (trackFeatures.speechiness > 0.6) sentiment.rap = true;
  if (trackFeatures.acousticness > 0.7) sentiment.acoustic = true;
  if (trackFeatures.instrumentalness > 0.5) sentiment.instrumental = true;
  return sentiment;
};

const validatePlaylistQuality = (playlist, seedTracks, culturalContext) => {
  const metrics = {
    coherence: calculateCoherence(playlist),
    diversity: calculateDiversity(playlist),
    flow: calculateFlow(playlist),
    culturalConsistency: validateCulturalConsistency(playlist, seedTracks, culturalContext)
  };
  const overallScore = Object.values(metrics).reduce((a, b) => a + b, 0) / 4;
  return {
    score: Math.round(overallScore),
    metrics,
    recommendations: generateQualityRecommendations(metrics)
  };
};

const calculateCoherence = (playlist) => {
  if (playlist.length < 2) return 100;
  let totalSimilarity = 0;
  let comparisons = 0;
  for (let i = 0; i < playlist.length - 1; i++) {
    for (let j = i + 1; j < playlist.length; j++) {
      const track1 = playlist[i];
      const track2 = playlist[j];
      const genreSimilarity = calculateGenreSimilarity(track1, track2);
      const eraSimilarity = calculateEraSimilarity(track1, track2);
      totalSimilarity += (genreSimilarity + eraSimilarity) / 2;
      comparisons++;
    }
  }
  return Math.round(totalSimilarity / comparisons);
};

const calculateDiversity = (playlist) => {
  const uniqueArtists = new Set(playlist.map(t => t.artist)).size;
  const uniqueGenres = new Set(playlist.map(t => t.genre || 'unknown')).size;
  const uniqueEras = new Set(playlist.map(t => t.era || 'unknown')).size;
  const artistDiversity = Math.min(100, (uniqueArtists / playlist.length) * 100);
  const genreDiversity = Math.min(100, uniqueGenres * 10);
  const eraDiversity = Math.min(100, uniqueEras * 15);
  return Math.round((artistDiversity + genreDiversity + eraDiversity) / 3);
};

const calculateFlow = (playlist) => {
  if (playlist.length < 3) return 100;
  let flowScore = 0;
  for (let i = 1; i < playlist.length - 1; i++) {
    const prev = playlist[i - 1];
    const curr = playlist[i];
    const next = playlist[i + 1];
    const energyFlow = Math.abs((curr.energy || 0.5) - (prev.energy || 0.5)) < 0.3;
    const tempoFlow = Math.abs((curr.tempo || 120) - (prev.tempo || 120)) < 30;
    if (energyFlow && tempoFlow) flowScore += 100;
    else if (energyFlow || tempoFlow) flowScore += 70;
    else flowScore += 40;
  }
  return Math.round(flowScore / (playlist.length - 2));
};

const validateCulturalConsistency = (playlist, seedTracks, culturalContext) => {
  if (!culturalContext) return 80;
  const { timeRange } = culturalContext;
  let consistentTracks = 0;
  playlist.forEach(track => {
    const trackYear = track.year || new Date().getFullYear();
    const isInRange = trackYear >= (timeRange[0] - 2) && trackYear <= (timeRange[1] + 2);
    if (isInRange) consistentTracks++;
  });
  return Math.round((consistentTracks / playlist.length) * 100);
};

const generateQualityRecommendations = (metrics) => {
  const recommendations = [];
  if (metrics.coherence < 70) recommendations.push("Considere adicionar mais músicas com características similares");
  if (metrics.diversity < 60) recommendations.push("A playlist poderia ter mais diversidade de artistas e gêneros");
  if (metrics.flow < 70) recommendations.push("As transições entre músicas poderiam ser mais suaves");
  if (metrics.culturalConsistency < 80) recommendations.push("Algumas músicas estão fora do contexto temporal esperado");
  return recommendations;
};

const calculateGenreSimilarity = (track1, track2) => {
  const genres1 = track1.genres || [];
  const genres2 = track2.genres || [];
  if (genres1.length === 0 || genres2.length === 0) return 50;
  const intersection = genres1.filter(g => genres2.includes(g));
  const union = [...new Set([...genres1, ...genres2])];
  return (intersection.length / union.length) * 100;
};

const calculateEraSimilarity = (track1, track2) => {
  const era1 = track1.era || 'unknown';
  const era2 = track2.era || 'unknown';
  if (era1 === era2) return 100;
  if (era1 === 'unknown' || era2 === 'unknown') return 50;
  const eraOrder = ['80s', '90s', '2000s', '2010s', '2020s'];
  const index1 = eraOrder.indexOf(era1);
  const index2 = eraOrder.indexOf(era2);
  if (index1 === -1 || index2 === -1) return 50;
  const distance = Math.abs(index1 - index2);
  return Math.max(0, 100 - (distance * 25));
};

// Alvos de vibe para guiar Spotify Recommendations sem usar a API de audio-features diretamente
const moodToTargets = (mood) => {
  const base = {
    melancholic: { energy: 0.35, danceability: 0.45, valence: 0.25, tempo: 95, acousticness: 0.5 },
    party:       { energy: 0.85, danceability: 0.85, valence: 0.60, tempo: 130, acousticness: 0.15 },
    chill:       { energy: 0.35, danceability: 0.45, valence: 0.45, tempo: 90, acousticness: 0.60 },
    upbeat:      { energy: 0.75, danceability: 0.75, valence: 0.65, tempo: 125, acousticness: 0.20 },
    neutral:     { energy: 0.55, danceability: 0.55, valence: 0.55, tempo: 110, acousticness: 0.30 }
  };
  return base[mood] || base.neutral;
};

const applyTargetParams = (opts, targets) => {
  // Adiciona target_* e pequenas faixas min/max para dar forma à distribuição
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const addRange = (key, t, delta = 0.18) => {
    const minK = `min_${key}`; const maxK = `max_${key}`; const targetK = `target_${key}`;
    opts[targetK] = key === 'tempo' ? t : clamp01(t);
    if (key === 'tempo') {
      opts[minK] = Math.max(70, t - 20);
      opts[maxK] = Math.min(180, t + 20);
    } else {
      opts[minK] = clamp01(t - delta);
      opts[maxK] = clamp01(t + delta);
    }
  };
  addRange('energy', targets.energy);
  addRange('danceability', targets.danceability);
  addRange('valence', targets.valence);
  addRange('tempo', targets.tempo, 0); // usa janela fixa de BPM
  addRange('acousticness', targets.acousticness, 0.22);
  return opts;
};

/**
 * NOVA FUNÇÃO: Detecta subgrupos de vibe usando APENAS metadados (sem Audio Features)
 * Usa Last.fm tags e análise de release dates para agrupar
 */
const detectVibeSubgroupsByMetadata = async (seedTracks, lastfmApiKey, playlistVibe) => {
  if (!lastfmApiKey || seedTracks.length < 2) {
    // Retornar grupo único se não temos Last.fm ou poucas seeds
    return [{
      tracks: seedTracks,
      mood: playlistVibe.mood,
      label: playlistVibe.mood.charAt(0).toUpperCase() + playlistVibe.mood.slice(1),
      description: playlistVibe.description,
      weight: 1.0,
      avgVibe: null
    }];
  }

  console.log('  📊 Analisando tags do Last.fm para cada seed...');
  
  // Buscar tags para cada seed
  const trackVibes = await Promise.all(seedTracks.map(async (track) => {
    try {
      const vibe = await inferVibe(track, lastfmApiKey, 'track');
      return {
        track,
        mood: vibe.mood,
        tags: vibe.tags || [],
        confidence: vibe.confidence || 0,
        profile: vibe.profile || {}
      };
    } catch (err) {
      console.warn(`    ⚠️  Erro ao analisar ${track.name}:`, err.message);
      return {
        track,
        mood: 'neutral',
        tags: [],
        confidence: 0,
        profile: {}
      };
    }
  }));

  // Agrupar por mood similar
  const moodGroups = {};
  trackVibes.forEach(tv => {
    const mood = tv.mood;
    if (!moodGroups[mood]) {
      moodGroups[mood] = [];
    }
    moodGroups[mood].push(tv);
  });

  // Se todas as tracks têm a mesma vibe, retornar grupo único
  if (Object.keys(moodGroups).length === 1) {
    const mood = Object.keys(moodGroups)[0];
    return [{
      tracks: seedTracks,
      mood: mood,
      label: mood.charAt(0).toUpperCase() + mood.slice(1),
      description: playlistVibe.description,
      weight: 1.0,
      avgVibe: null
    }];
  }

  // Criar subgrupos para cada mood detectado
  const subgroups = Object.entries(moodGroups)
    .filter(([_, tracks]) => tracks.length > 0)
    .map(([mood, trackVibes]) => {
      const tracks = trackVibes.map(tv => tv.track);
      const weight = tracks.length / seedTracks.length;
      
      // Gerar label descritivo
      const commonTags = findCommonTags(trackVibes.map(tv => tv.tags));
      let label = mood.charAt(0).toUpperCase() + mood.slice(1);
      
      if (commonTags.includes('acoustic')) label += ' Acoustic';
      else if (commonTags.includes('electronic')) label += ' Electronic';
      else if (commonTags.includes('rock')) label += ' Rock';
      
      // Gerar descrição
      const descriptions = {
        'melancholic': 'sad and emotional tracks',
        'party': 'upbeat and energetic tracks',
        'chill': 'relaxed and mellow tracks',
        'upbeat': 'positive and energetic tracks',
        'neutral': 'balanced tracks'
      };
      
      return {
        tracks,
        mood,
        label,
        description: descriptions[mood] || 'mixed vibe',
        weight,
        avgVibe: null,
        tags: commonTags
      };
    })
    .sort((a, b) => b.weight - a.weight); // Ordenar por peso (maior primeiro)

  console.log(`  ✅ ${subgroups.length} subgrupos distintos detectados`);
  
  return subgroups;
};

/**
 * Encontra tags comuns entre múltiplas tracks
 */
const findCommonTags = (tagArrays) => {
  if (tagArrays.length === 0) return [];
  
  const tagCounts = {};
  tagArrays.forEach(tags => {
    tags.forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  
  // Retornar tags que aparecem em pelo menos 50% das tracks
  const threshold = Math.ceil(tagArrays.length * 0.5);
  return Object.entries(tagCounts)
    .filter(([_, count]) => count >= threshold)
    .map(([tag, _]) => tag);
};

const inferVibe = async (input, lastfmApiKey, type = 'track', extra = {}) => {
  const allTags = [];
  let topSeedGenres = extra.topSeedGenres || [], topSeedDecades = extra.topSeedDecades || [];
  if (type === 'playlist') {
    const seedTracks = Array.isArray(input) ? input : [];
    const tagPromises = seedTracks.slice(0, 3).map(track => getLastfmTags(track, lastfmApiKey));
    const tagsArrays = await Promise.all(tagPromises);
    tagsArrays.forEach(tags => allTags.push(...tags));
  } else {
    allTags.push(...await getLastfmTags(input, lastfmApiKey));
  }
  const tagCounts = {};
  allTags.forEach(tag => tagCounts[tag] = (tagCounts[tag] || 0) + 1);
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
  console.log('Top tags do Last.fm:', topTags);
  let mood = 'neutral', subMood = null;
  if (topTags.some(t => ['sad', 'melancholy', 'depressing', 'emotional'].includes(t))) {
    mood = 'melancholic';
    subMood = topTags.includes('dark') ? 'dark' : 'intimate';
  } else if (topTags.some(t => ['party', 'dance', 'club', 'energetic'].includes(t))) {
    mood = 'party';
    subMood = topTags.includes('electronic') ? 'energetic' : 'groovy';
  } else if (topTags.some(t => ['chill', 'relaxing', 'mellow', 'ambient'].includes(t))) {
    mood = 'chill';
  }
  const era = topSeedDecades[0] || '2000s';
  const profile = {
    isAcoustic: topTags.includes('acoustic'),
    isFast: topTags.includes('fast') || topTags.includes('energetic'),
    isLoud: topTags.includes('heavy') || topTags.includes('loud'),
    isVocal: !topTags.includes('instrumental'),
    isInstrumental: topTags.includes('instrumental')
  };
  const confidence = Math.min(90, Math.max(20, Object.values(tagCounts).reduce((s, v) => s + v, 0) * 15));
  return {
    mood, subMood, era, genres: topSeedGenres.slice(0, 3), tags: topTags,
    description: `${mood}${subMood ? ` (${subMood})` : ''} ${era} ${topSeedGenres.slice(0,2).join('/')} vibe`,
    profile, confidence
  };
};

const detectCulturalEra = (seedTracks, topSeedGenres, topSeedDecades) => {
  const years = seedTracks
    .map(t => {
      const date = t.album?.release_date;
      if (!date) return null;
      const y = parseInt(date.substring(0, 4));
      return Number.isNaN(y) ? null : y;
    })
    .filter(y => y && y > 1950);
  if (years.length === 0) {
    return {
      culturalEra: 'contemporary',
      eraKeywords: ['contemporary'],
      avgYear: new Date().getFullYear(),
      yearSpread: 0,
      isFocusedEra: true,
      searchContext: `${(topSeedGenres || []).slice(0,3).join('+')} contemporary`,
      timeRange: [new Date().getFullYear(), new Date().getFullYear()]
    };
  }
  const avgYear = Math.round(years.reduce((sum, y) => sum + y, 0) / years.length);
  const yearSpread = Math.max(...years) - Math.min(...years);
  let culturalEra = null, eraKeywords = [];
  if (avgYear >= 2020) {
    culturalEra = '2020s'; eraKeywords = ['hyperpop', 'bedroom pop', 'alt', 'tiktok era'];
  } else if (avgYear >= 2015 && avgYear < 2020) {
    culturalEra = 'late-2010s'; eraKeywords = ['streaming era', 'soundcloud', 'trap', 'indie'];
  } else if (avgYear >= 2010 && avgYear < 2015) {
    culturalEra = 'early-2010s'; eraKeywords = ['edm boom', 'dubstep', 'indie folk', 'tumblr era'];
  } else if (avgYear >= 2004 && avgYear < 2010) {
    culturalEra = 'mid-2000s'; eraKeywords = ['pop-rap crossover', 'urban radio', 'ringtone era', 'crunk', 'timbaland'];
  } else if (avgYear >= 1998 && avgYear < 2004) {
    culturalEra = 'late-90s-early-2000s'; eraKeywords = ['teen pop', 'nu metal', 'post-grunge', 'trl era'];
  } else if (avgYear >= 1990 && avgYear < 1998) {
    culturalEra = '90s'; eraKeywords = ['grunge', 'hip hop golden age', 'britpop', 'r&b'];
  } else if (avgYear >= 1980 && avgYear < 1990) {
    culturalEra = '80s'; eraKeywords = ['synth pop', 'new wave', 'mtv era', 'hair metal'];
  } else {
    culturalEra = 'classic'; eraKeywords = ['classic rock', 'disco', 'funk', 'soul'];
  }
  const isFocusedEra = yearSpread <= 5;
  const genreMix = (topSeedGenres || []).slice(0,3).join('+');
  return {
    culturalEra, eraKeywords, avgYear, yearSpread, isFocusedEra,
    searchContext: `${genreMix} ${culturalEra}`,
    timeRange: [Math.min(...years), Math.max(...years)]
  };
};

// Removido cálculo baseado em Audio Features (Spotify) — mantemos apenas abordagem por metadados/Last.fm

/**
 * NOVA FUNÇÃO: Calcula similaridade com múltiplos subgrupos de vibe
 * VERSÃO SEM AUDIO FEATURES - usa apenas metadados e Last.fm
 */
const calculateMultiVibeGroupSimilarity = async (track, vibeSubgroups, playlistVibe, lastfmApiKey) => {
  if (!vibeSubgroups || vibeSubgroups.length === 0 || vibeSubgroups.length === 1) {
    // Grupo único - retornar score base alto
    return 85;
  }

  if (!lastfmApiKey) {
    // Sem Last.fm, retornar score neutro
    return 75;
  }

  try {
    // Inferir vibe da track candidata usando Last.fm
    const trackVibe = await inferVibe(track, lastfmApiKey, 'track');
    
    // Calcular similaridade com cada subgrupo
    const subgroupScores = vibeSubgroups.map(subgroup => {
      const subgroupMood = subgroup.mood;
      
      // Score base por mood matching
      let moodScore = 50;
      if (trackVibe.mood === subgroupMood) {
        moodScore = 100; // Match perfeito
      } else {
        // Compatibilidade entre moods
        const compatibility = {
          'melancholic': { 'chill': 80, 'neutral': 70 },
          'party': { 'upbeat': 90, 'neutral': 70 },
          'chill': { 'melancholic': 80, 'neutral': 75, 'upbeat': 60 },
          'upbeat': { 'party': 90, 'neutral': 75 },
          'neutral': { 'melancholic': 70, 'party': 70, 'chill': 75, 'upbeat': 75 }
        };
        
        moodScore = compatibility[trackVibe.mood]?.[subgroupMood] || 50;
      }
      
      // Bonus por tags em comum
      const trackTags = trackVibe.tags || [];
      const subgroupTags = subgroup.tags || [];
      const commonTags = trackTags.filter(tag => subgroupTags.includes(tag));
      const tagBonus = Math.min(20, commonTags.length * 5);
      
      const totalScore = Math.min(100, moodScore + tagBonus);
      
      // Ponderar pelo peso do subgrupo
      const weightedScore = totalScore * subgroup.weight;
      
      return {
        score: weightedScore,
        mood: subgroupMood,
        label: subgroup.label
      };
    });
    
    // Retornar a MELHOR pontuação
    const bestMatch = subgroupScores.reduce((best, current) => 
      current.score > best.score ? current : best
    );
    
    return Math.round(bestMatch.score);
    
  } catch (err) {
    console.warn('    ⚠️  Erro ao calcular similaridade multi-vibe:', err.message);
    return 75; // Score neutro em caso de erro
  }
};

// Helper: Retorna o melhor subgrupo (label/mood) para um track via Last.fm/metadata
const getBestSubgroupMatch = async (track, vibeSubgroups, lastfmApiKey) => {
  if (!vibeSubgroups || vibeSubgroups.length === 0) return { mood: 'neutral', label: 'Mixed', score: 75 };
  if (!lastfmApiKey) return { mood: vibeSubgroups[0].mood, label: vibeSubgroups[0].label, score: 75 };
  const trackVibe = await inferVibe(track, lastfmApiKey, 'track');
  const scored = vibeSubgroups.map(subgroup => {
    let moodScore = 50;
    if (trackVibe.mood === subgroup.mood) moodScore = 100;
    else {
      const compatibility = {
        'melancholic': { 'chill': 80, 'neutral': 70 },
        'party': { 'upbeat': 90, 'neutral': 70 },
        'chill': { 'melancholic': 80, 'neutral': 75, 'upbeat': 60 },
        'upbeat': { 'party': 90, 'neutral': 75 },
        'neutral': { 'melancholic': 70, 'party': 70, 'chill': 75, 'upbeat': 75 }
      };
      moodScore = compatibility[trackVibe.mood]?.[subgroup.mood] || 50;
    }
    const commonTags = (trackVibe.tags || []).filter(tag => (subgroup.tags || []).includes(tag));
    const tagBonus = Math.min(20, commonTags.length * 5);
    const total = Math.min(100, moodScore + tagBonus) * (subgroup.weight || 1);
    return { label: subgroup.label, mood: subgroup.mood, score: total };
  });
  return scored.sort((a,b) => b.score - a.score)[0];
};

const isVibeMatch = (candFeatures, playlistVibe) => {
  const { mood, subMood, profile } = playlistVibe;
  if (mood === 'melancholic' || subMood === 'sad-trap') {
    if (candFeatures.valence > 0.6) return false;
    if (candFeatures.energy > 0.8) return false;
  }
  if (mood === 'party') {
    if (candFeatures.danceability < 0.35) return false;
    if (candFeatures.energy < 0.45) return false;
  }
  if (mood === 'chill' || subMood === 'mellow') {
    if (candFeatures.energy > 0.75) return false;
    if (candFeatures.loudness > -3) return false;
  }
  if (subMood === 'acoustic' || profile.isAcoustic) {
    if (candFeatures.acousticness < 0.2) return false;
  }
  return true;
};

const isVibeMatchByMetadata = async (track, playlistVibe, lastfmApiKey) => {
  const trackVibe = await inferVibe(track, lastfmApiKey, 'track');
  if (trackVibe.confidence < 30) return true;
  if (trackVibe.mood === playlistVibe.mood) return true;
  const compatible = {
    melancholic: ['chill', 'neutral', 'party'],
    party: ['upbeat', 'neutral', 'chill'],
    chill: ['melancholic', 'neutral', 'party'],
    upbeat: ['party', 'neutral', 'chill'],
    neutral: ['melancholic', 'party', 'chill', 'upbeat'],
    aggressive: ['party', 'neutral', 'upbeat']
  };
  return compatible[playlistVibe.mood]?.includes(trackVibe.mood) || false;
};

const classifyCandidateByProximity = (track, seedTracks, topArtistIds, relatedArtistSet = new Set()) => {
  const trackArtistIds = (track.artists || []).map(a => a.id).filter(Boolean);
  if (seedTracks.some(s => s.artists.some(sa => trackArtistIds.includes(sa.id)))) {
    return { circle: 1, weight: 1.30 };
  }
  if (trackArtistIds.some(id => topArtistIds.includes(id))) {
    return { circle: 2, weight: 1.15 };
  }
  if (trackArtistIds.some(id => relatedArtistSet.has(id))) {
    return { circle: 3, weight: 1.08 };
  }
  return { circle: 4, weight: 1.0 };
};

const getRelatedArtistsViaLastfm = async (seedTracks, lastfmApiKey, api) => {
  const relatedMap = new Map();
  for (const seedTrack of seedTracks) {
    const seedArtistName = seedTrack.artists[0].name;
    const seedArtistId = seedTrack.artists[0].id;
    try {
      const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(seedArtistName)}&api_key=${lastfmApiKey}&format=json&limit=20`;
      const data = await lastfmLimiter.execute(() => fetch(url).then(res => res.json()));
      const similarArtists = (data.similarartists?.artist || [])
        .filter(a => parseFloat(a.match) > 0.4)
        .slice(0, 15);
      const relatedIds = [];
      const searchPromises = similarArtists.map(async (simArtist) => {
        try {
          const searchData = await spotifyLimiter.execute(() => api.searchArtists(simArtist.name, { limit: 1 }));
          const spotifyArtist = searchData.body.artists.items[0];
          if (spotifyArtist && spotifyArtist.id !== seedArtistId) {
            relatedIds.push(spotifyArtist.id);
          }
        } catch (e) {
          console.warn(`Erro ao buscar ${simArtist.name} no Spotify:`, e.message);
        }
      });
      await Promise.all(searchPromises);
      relatedMap.set(seedArtistId, relatedIds);
      console.log(`✓ ${seedArtistName}: ${relatedIds.length} relacionados via Last.fm`);
    } catch (e) {
      console.warn(`Erro Last.fm para ${seedArtistName}:`, e.message);
      relatedMap.set(seedArtistId, []);
    }
  }
  return relatedMap;
};

const exploreArtistNetworkViaLastfm = async (seedTracks, topSeedGenres, lastfmApiKey, api, depth = 2) => {
  const network = new Map();
  const queue = seedTracks.map(t => ({
    name: t.artists[0].name,
    spotifyId: t.artists[0].id,
    level: 0
  }));
  const visited = new Set(seedTracks.map(t => t.artists[0].name.toLowerCase()));
  console.log(`Explorando rede via Last.fm (profundidade: ${depth})...`);
  while (queue.length > 0) {
    const { name, spotifyId, level } = queue.shift();
    if (level > depth) continue;
    try {
      let artistInfo = { genres: [], popularity: 50 };
      if (spotifyId) {
        try {
          const artistData = await spotifyLimiter.execute(() => api.getArtist(spotifyId));
          artistInfo = {
            genres: artistData.body.genres || [],
            popularity: artistData.body.popularity || 50
          };
        } catch (e) {
          console.warn(`Spotify ID ${spotifyId} inválido, usando busca por nome`);
          const searchData = await spotifyLimiter.execute(() => api.searchArtists(name, { limit: 1 }));
          const foundArtist = searchData.body.artists.items[0];
          if (foundArtist) {
            artistInfo = {
              genres: foundArtist.genres || [],
              popularity: foundArtist.popularity || 50
            };
          }
        }
      }
      network.set(name, {
        spotifyId,
        genres: artistInfo.genres,
        popularity: artistInfo.popularity,
        level
      });
      const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(name)}&api_key=${lastfmApiKey}&format=json&limit=20`;
      const data = await lastfmLimiter.execute(() => fetch(url).then(res => res.json()));
      const similarArtists = (data.similarartists?.artist || [])
        .filter(a => parseFloat(a.match) > 0.4);
      const seedGenresSet = new Set(topSeedGenres);
      const searchPromises = similarArtists.slice(0, level === 0 ? 10 : 5).map(async (simArtist) => {
        const simName = simArtist.name;
        const simNameLower = simName.toLowerCase();
        if (visited.has(simNameLower)) return;
        try {
          const searchData = await spotifyLimiter.execute(() => api.searchArtists(simName, { limit: 1 }));
          const spotifyArtist = searchData.body.artists.items[0];
          if (spotifyArtist) {
            const hasGenreOverlap = spotifyArtist.genres.some(g =>
              seedGenresSet.has(g) || seedGenresSet.has('unknown')
            );
            const isNiche = spotifyArtist.popularity < 65;
            if ((hasGenreOverlap || seedGenresSet.has('unknown')) && level < depth) {
              visited.add(simNameLower);
              queue.push({
                name: simName,
                spotifyId: spotifyArtist.id,
                level: level + 1
              });
            }
          }
        } catch (e) {
          console.warn(`Erro ao buscar ${simName}:`, e.message);
        }
      });
      await Promise.all(searchPromises);
    } catch (e) {
      console.warn(`Erro ao explorar ${name}:`, e.message);
    }
  }
  console.log(`✓ Rede explorada: ${network.size} artistas`);
  const nicheCount = Array.from(network.values()).filter(a => a.popularity < 55).length;
  console.log(` - ${nicheCount} artistas nicho (popularidade < 55)`);
  return network;
};

const getLastfmSimilarArtists = async (artistName, lastfmApiKey) => {
  return lastfmLimiter.execute(async () => {
    const cacheKey = `lastfm_similar_${artistName}`;
    const cached = lastfmCache.get(cacheKey);
    if (cached) return cached;
    const result = await fetch(`http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistName)}&api_key=${lastfmApiKey}&format=json`);
    const data = await result.json();
    const names = (data.similarartists?.artist || []).map(a => a.name).slice(0, 50);
    lastfmCache.set(cacheKey, names);
    return names;
  });
};

const getLastfmTags = async (track, lastfmApiKey) => {
  try {
    const artistName = track.artists?.[0]?.name || track.artist || '';
    const trackName = track.name || track.title || '';
    if (!artistName || !trackName || !lastfmApiKey) return [];
    const cacheKey = `tags:${artistName.toLowerCase()}:${trackName.toLowerCase()}`;
    const cached = lastfmCache.get(cacheKey);
    if (cached) return cached;
    const url = `http://ws.audioscrobbler.com/2.0/?method=track.gettoptags&artist=${encodeURIComponent(artistName)}&track=${encodeURIComponent(trackName)}&api_key=${lastfmApiKey}&format=json`;
    const res = await lastfmLimiter.execute(() => fetch(url));
    const data = await res.json();
    const tags = (data.toptags?.tag || []).map(t => String(t.name).toLowerCase()).slice(0, 10);
    lastfmCache.set(cacheKey, tags);
    return tags;
  } catch (e) {
    return [];
  }
};

const chunkArray = (arr, size) => {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
};

const decadeFromReleaseDate = (dateStr) => {
  if (!dateStr) return 'Unknown';
  const year = parseInt(dateStr.substring(0, 4));
  if (isNaN(year) || year < 0) return 'Unknown';
  const decade = Math.floor(year / 10) * 10;
  return `${decade}s`;
};

const getArtistDeepCuts = async (artistId, api, playlistVibe, vibeSubgroups, lastfmApiKey) => {
  try {
    const albumsData = await spotifyLimiter.execute(() =>
      api.getArtistAlbums(artistId, { limit: 20, include_groups: 'album,single' })
    );
    const albums = albumsData.body.items;
    const randomAlbums = albums.sort(() => Math.random() - 0.5).slice(0, 2);
    const deepCuts = [];
   
    // Coletar TODOS os track IDs primeiro
    const allTrackIds = [];
    const albumTrackMap = new Map();
   
    for (const album of randomAlbums) {
      const tracksData = await spotifyLimiter.execute(() =>
        api.getAlbumTracks(album.id, { limit: 10 })
      );
      const tracks = tracksData.body.items;
      const middleTracks = tracks.slice(
        Math.floor(tracks.length * 0.4),
        Math.floor(tracks.length * 0.6)
      );
     
      middleTracks.forEach(t => {
        allTrackIds.push(t.id);
        albumTrackMap.set(t.id, { track: t, album });
      });
    }
   
    // Avaliar por metadados/Last.fm
    for (const trackId of allTrackIds) {
      const { track, album } = albumTrackMap.get(trackId);
      let accept = true;
      let simScore = 75;
      if (lastfmApiKey && vibeSubgroups && vibeSubgroups.length > 1) {
        simScore = await calculateMultiVibeGroupSimilarity(track, vibeSubgroups, playlistVibe, lastfmApiKey);
        accept = simScore >= 70;
      } else if (lastfmApiKey) {
        accept = await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey);
        simScore = accept ? 70 : 0;
      }
      if (accept) {
        deepCuts.push({
          ...track,
          similarity: simScore,
          album: { images: album.images, release_date: album.release_date },
          artists: [{ id: artistId, name: album.artists?.[0]?.name || 'Unknown' }]
        });
      }
      if (deepCuts.length >= 6) break;
    }
    return deepCuts.slice(0, 6);
  } catch (e) {
    console.warn(`Erro ao buscar deep cuts de ${artistId}:`, e.message);
    return [];
  }
};

const getArtistsFromSameEra = async (seedTracks, culturalContext, lastfmApiKey, api) => {
  const allSimilarArtists = new Map();
  const similarPromises = seedTracks.slice(0, 4).map(async (seedTrack) => {
    const artistName = seedTrack.artists[0].name;
    try {
      const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistName)}&api_key=${lastfmApiKey}&format=json&limit=30`;
      const data = await lastfmLimiter.execute(() => fetch(url).then(res => res.json()));
      const similarArtists = (data.similarartists?.artist || [])
        .filter(a => parseFloat(a.match) > 0.4);
      similarArtists.forEach(simArtist => {
        const existing = allSimilarArtists.get(simArtist.name) || { match: 0, sources: [] };
        existing.match = Math.max(existing.match, parseFloat(simArtist.match));
        existing.sources.push(artistName);
        allSimilarArtists.set(simArtist.name, existing);
      });
    } catch (e) {
      console.warn(`Erro Last.fm para ${artistName}:`, e.message);
    }
  });
  await Promise.all(similarPromises);
  const minOverlap = Math.max(1, Math.ceil(seedTracks.length * 0.4));
  const filteredSimilar = Array.from(allSimilarArtists.entries())
    .filter(([name, data]) => data.sources.length >= minOverlap)
    .sort((a, b) => {
      if (b[1].sources.length !== a[1].sources.length) {
        return b[1].sources.length - a[1].sources.length;
      }
      return b[1].match - a[1].match;
    })
    .slice(0, 20);
  console.log(`Artistas consolidados (overlap >= ${minOverlap}): ${filteredSimilar.length}`);
  const { timeRange } = culturalContext;
  const spotifyPromises = filteredSimilar.map(async ([simArtistName, data]) => {
    try {
      const searchData = await spotifyLimiter.execute(() => api.searchArtists(simArtistName, { limit: 1 }));
      const spotifyArtist = searchData.body.artists.items[0];
      if (!spotifyArtist) return null;
      let topTracksData;
      try {
        topTracksData = await spotifyLimiter.execute(() => api.getArtistTopTracks(spotifyArtist.id, 'US'));
      } catch (e) {
        topTracksData = await spotifyLimiter.execute(() => api.getArtistTopTracks(spotifyArtist.id));
      }
      const topTracks = topTracksData.body.tracks;
      const eraRelevantTracks = topTracks.filter(track => {
        const releaseDate = track.album?.release_date;
        if (!releaseDate) return false;
        const year = parseInt(releaseDate.substring(0, 4));
        return year >= (timeRange[0] - 2) && year <= (timeRange[1] + 2);
      });
      if (eraRelevantTracks.length >= 2) {
        return {
          id: spotifyArtist.id,
          spotifyId: spotifyArtist.id,
          name: spotifyArtist.name,
          popularity: spotifyArtist.popularity,
          genres: spotifyArtist.genres,
          eraTracksCount: eraRelevantTracks.length,
          overlapCount: data.sources.length,
          relevantTracks: eraRelevantTracks.map(t => ({
            id: t.id,
            name: t.name,
            year: parseInt(t.album.release_date.substring(0, 4))
          }))
        };
      }
      return null;
    } catch (e) {
      console.warn(`Erro ao verificar ${simArtistName}:`, e.message);
      return null;
    }
  });
  const results = await Promise.all(spotifyPromises);
  const validArtists = results.filter(r => r !== null);
  console.log(`✓ Artistas da mesma era encontrados: ${validArtists.length}`);
  return validArtists;
};

const getTracksFromEraContext = async (eraArtist, culturalContext, playlistVibe, api, topTracksCache, vibeSubgroups, lastfmApiKey) => {
  const { timeRange } = culturalContext;
  const tracks = [];
  try {
    let topTracksData;
    const cacheKey = eraArtist.spotifyId || eraArtist.id;
    if (topTracksCache.has(cacheKey)) {
      topTracksData = topTracksCache.get(cacheKey);
      console.log(` [CACHE HIT] ${eraArtist.name}`);
    } else {
      try {
        topTracksData = await spotifyLimiter.execute(() => api.getArtistTopTracks(cacheKey, 'US'));
      } catch (e) {
        topTracksData = await spotifyLimiter.execute(() => api.getArtistTopTracks(cacheKey));
      }
      topTracksCache.set(cacheKey, topTracksData);
    }
    const topTracks = topTracksData.body.tracks;
    const eraRelevantTracks = topTracks.filter(track => {
      const releaseDate = track.album?.release_date;
      if (!releaseDate) return false;
      const year = parseInt(releaseDate.substring(0, 4));
      return year >= (timeRange[0] - 2) && year <= (timeRange[1] + 2);
    });
    const maxTracks = (eraArtist.overlapCount >= 2) ? 3 : 2;
    for (const track of eraRelevantTracks.slice(0, maxTracks)) {
      let simScore = 85;
      if (lastfmApiKey && vibeSubgroups && vibeSubgroups.length > 1) {
        simScore = await calculateMultiVibeGroupSimilarity(track, vibeSubgroups, playlistVibe, lastfmApiKey);
      } else if (lastfmApiKey) {
        const ok = await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey);
        if (!ok) continue;
        simScore = 80;
      }
      tracks.push({
        ...track,
        similarity: simScore,
        _circle: 2,
        _source: 'era-context',
        _eraYear: parseInt(track.album.release_date?.substring(0, 4))
      });
    }
  } catch (e) {
    console.warn(`Erro em getTracksFromEraContext para ${eraArtist.name}:`, e.message);
  }
  return tracks;
};

if (typeof fetch === 'undefined') {
  global.fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

const estimateFeaturesFromTags = (tags = []) => {
  let energy = 0.5, danceability = 0.5, valence = 0.5;
  let acousticness = 0.05, tempo = 120, loudness = -8;
  let speechiness = 0.05, instrumentalness = 0.0;
  const tagSet = new Set(tags);
  if (tagSet.has('energetic') || tagSet.has('party') || tagSet.has('dance')) { energy += 0.25; danceability += 0.25; tempo += 15; }
  if (tagSet.has('upbeat') || tagSet.has('happy')) { energy += 0.15; valence += 0.15; }
  if (tagSet.has('chill') || tagSet.has('relaxing') || tagSet.has('mellow')) { energy -= 0.25; acousticness += 0.4; valence -= 0.05; tempo -= 15; }
  if (tagSet.has('acoustic') || tagSet.has('singer-songwriter')) { acousticness += 0.45; energy -= 0.15; }
  if (tagSet.has('ambient') || tagSet.has('instrumental')) { instrumentalness += 0.6; energy -= 0.3; acousticness += 0.1; }
  if (tagSet.has('rock') || tagSet.has('metal') || tagSet.has('heavy')) { energy += 0.2; loudness = -4; valence -= 0.05; }
  if (tagSet.has('hip-hop') || tagSet.has('rap')) { speechiness += 0.12; tempo += 10; energy += 0.1; }
  if (tagSet.has('electronic') || tagSet.has('edm')) { danceability += 0.15; energy += 0.15; tempo += 10; }
  energy = clamp(energy);
  danceability = clamp(danceability);
  valence = clamp(valence);
  acousticness = clamp(acousticness);
  speechiness = clamp(speechiness);
  instrumentalness = clamp(instrumentalness);
  tempo = Math.round(Math.max(60, Math.min(180, tempo)));
  loudness = Math.round(Math.max(-60, Math.min(0, loudness)));
  return { danceability, energy, valence, acousticness, tempo, loudness, speechiness, instrumentalness };
};

const getEstimatedFeaturesForTrack = async (track, lastfmApiKey) => {
  if (!lastfmApiKey || !track) return null;
  try {
    const tags = await getLastfmTags(track, lastfmApiKey);
    if (!tags || tags.length === 0) return null;
    const est = estimateFeaturesFromTags(tags);
    return { id: track.id || null, ...est };
  } catch (e) {
    return null;
  }
};

app.post('/analyze', async (req, res) => {
  const topTracksCache = new Map();
  try {
    const api = createApiInstance(req);
    let { trackIds } = req.body;
    if (!trackIds || !trackIds.length) {
      return res.status(400).json({ error: 'Nenhuma música fornecida.' });
    }
    const uniqueTrackIds = Array.from(new Set(trackIds.filter(id => id && id.trim())));
    if (uniqueTrackIds.length === 0) {
      return res.status(400).json({ error: 'Nenhuma música válida fornecida após remoção de duplicatas.' });
    }
    if (uniqueTrackIds.length < trackIds.length) {
      console.log(`Duplicatas removidas: ${trackIds.length} → ${uniqueTrackIds.length} IDs únicos.`);
    }
    console.log('Track IDs únicos recebidos:', uniqueTrackIds);
    console.log("--- INICIANDO ALGORITMO APRIMORADO ---");
    console.log('Validando token...');
    const meData = await spotifyLimiter.execute(() => api.getMe());
    console.log('Token válido. Usuário:', meData.body.display_name);
    console.log('Buscando seed tracks...');
    const seedTracksData = await spotifyLimiter.execute(() => api.getTracks(uniqueTrackIds));
    let seedTracks = seedTracksData.body.tracks.filter(t => t);
    console.log('Seed tracks obtidas:', seedTracks.length, 'tracks válidas');
    let candidateTracks = [];
    const uriSeen = new Set(seedTracks.map(t => t.uri));
    const seedArtistIds = Array.from(new Set(seedTracks.flatMap(t => (t.artists || []).map(a => a.id).filter(Boolean))));
    let relatedArtistSet = new Set();
    const lastfmApiKey = process.env.LASTFM_API_KEY;
    if (seedArtistIds.length > 0 && lastfmApiKey) {
      try {
        const relatedMap = await getRelatedArtistsViaLastfm(seedTracks, lastfmApiKey, api);
        Object.values(relatedMap).forEach(list => list.forEach(id => relatedArtistSet.add(id)));
        seedArtistIds.forEach(id => relatedArtistSet.delete(id));
        console.log(`Related artists coletados: ${relatedArtistSet.size}`);
      } catch (e) {
        console.warn('Falha ao montar related artists:', e.message || e);
        relatedArtistSet = new Set();
      }
    }
    console.log('Análise precoce de gêneros das seeds...');
    const seedGenresMap = await getArtistsGenres(seedArtistIds, api);
    const seedGenreCounts = {};
    seedTracks.forEach(track => {
      (track.artists || []).forEach(a => {
        const gs = (seedGenresMap[a.id] || []);
        if (gs.length === 0) {
          seedGenreCounts['unknown'] = (seedGenreCounts['unknown'] || 0) + 1;
        } else {
          gs.forEach(g => seedGenreCounts[g] = (seedGenreCounts[g] || 0) + 1);
        }
      });
    });
    const topSeedGenres = Object.entries(seedGenreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([g]) => g);
    console.log('Top gêneros das seeds:', topSeedGenres);
    const artistNetwork = await exploreArtistNetworkViaLastfm(seedTracks, topSeedGenres, lastfmApiKey, api, 2);
    const nicheArtistIds = Array.from(artistNetwork.values())
      .filter(data => data.popularity < 55 && data.level > 0 && data.spotifyId)
      .map(data => data.spotifyId);
    console.log(`Artistas nicho identificados: ${nicheArtistIds.length}`);
    const seedDecadeCounts = {};
    seedTracks.forEach(track => {
      const dec = decadeFromReleaseDate(track.album?.release_date);
      seedDecadeCounts[dec] = (seedDecadeCounts[dec] || 0) + 1;
    });
    const topSeedDecades = Object.entries(seedDecadeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([d]) => d);
    // Audio features desativado: não calcular avgVibe por Spotify; seguimos apenas com metadados/Last.fm
    console.log('Inferindo vibe por metadados...');
    const playlistVibe = await inferVibe(seedTracks, lastfmApiKey, 'playlist', { topSeedGenres, topSeedDecades });
    console.log('Vibe inferida:', playlistVibe);
    
    // === DETECÇÃO DE SUBGRUPOS POR METADADOS (sem Audio Features) ===
    console.log('\n🎵 === DETECTANDO SUBGRUPOS DE VIBE POR METADADOS ===');
    let vibeSubgroups = await detectVibeSubgroupsByMetadata(seedTracks, lastfmApiKey, playlistVibe);
    console.log(`✅ ${vibeSubgroups.length} subgrupo(s) detectado(s):`);
    vibeSubgroups.forEach((sg, i) => {
      console.log(`  ${i + 1}. ${sg.label} (${sg.tracks.length} tracks)`);
      console.log(`     Mood: ${sg.mood}`);
      console.log(`     Tracks: ${sg.tracks.map(t => t.name).join(', ')}`);
    });
    
    const culturalContext = detectCulturalEra(seedTracks, topSeedGenres, topSeedDecades);
    console.log('Contexto cultural detectado:', culturalContext);
    console.log('Obtendo top artists...');
    let topArtistIds = [];
    let useTopArtists = true;
    try {
      const topArtistsData = await spotifyLimiter.execute(() => api.getMyTopArtists({ limit: 5, time_range: 'medium_term' }));
      const topArtists = topArtistsData.body.items;
      const topArtistGenreMap = await getArtistsGenres(topArtists.map(a => a.id), api);
      const topArtistGenres = new Set();
      topArtists.forEach(artist => {
        (topArtistGenreMap[artist.id] || []).forEach(g => topArtistGenres.add(g));
      });
      const genreOverlap = Array.from(topArtistGenres).filter(g => topSeedGenres.includes(g)).length;
      if (genreOverlap === 0) {
        console.log('Top artists do usuário sem overlap de gênero com seeds. Pulando para evitar mismatch.');
        useTopArtists = false;
      } else {
        topArtistIds = topArtists.map(a => a.id).filter(id => id);
        console.log('Top artists do usuário (com overlap):', topArtistIds);
      }
    } catch (topErr) {
      console.warn('Erro ao obter top artists:', topErr.message);
      useTopArtists = false;
    }
    // Fase de recomendações do Spotify removida a pedido do usuário
    // Nenhuma track adicionada via Spotify Recommendations
    console.log("Fase Last.fm: Minerando artistas similares por comportamento de usuário...");
    let lastfmUsed = false;
    const lastfmArtistCandidates = new Set();
    if (lastfmApiKey) {
      const similarPromises = seedTracks.slice(0, 3).map(async (seedTrack) => {
        const artistName = seedTrack.artists[0].name;
        const similar = await getLastfmSimilarArtists(artistName, lastfmApiKey);
        console.log(`${artistName} → Similar: ${similar.slice(0, 5).join(', ')}`);
        const searchPromises = similar.slice(0, 10).map(async (simArtistName) => {
          try {
            const searchData = await spotifyLimiter.execute(() => api.searchArtists(simArtistName, { limit: 1 }));
            const artist = searchData.body.artists.items[0];
            if (artist && artist.popularity < 65) {
              lastfmArtistCandidates.add(artist.id);
            }
          } catch (e) {}
        });
        await Promise.all(searchPromises);
      });
      await Promise.all(similarPromises);
      console.log(`Artistas Last.fm identificados: ${lastfmArtistCandidates.size}`);
      const deepCutPromises = Array.from(lastfmArtistCandidates).slice(0, 8).map(async (lfArtistId) => {
        const deepCuts = await getArtistDeepCuts(lfArtistId, api, playlistVibe, vibeSubgroups, lastfmApiKey);
        for (const track of deepCuts) {
          if (!uriSeen.has(track.uri) && candidateTracks.length < MAX_CANDIDATES) {
            let simScore = 80;
            if (lastfmApiKey && vibeSubgroups.length > 1) {
              simScore = await calculateMultiVibeGroupSimilarity(track, vibeSubgroups, playlistVibe, lastfmApiKey);
            } else if (lastfmApiKey) {
              if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) continue;
              simScore = 75;
            }
            const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
            simScore = Math.min(100, Math.round(simScore * classification.weight));
            candidateTracks.push({ ...track, similarity: simScore, _circle: classification.circle, _source: 'lastfm' });
            uriSeen.add(track.uri);
          }
        }
      });
      await Promise.all(deepCutPromises);
      lastfmUsed = true;
    }
    console.log("Fase 2: Buscando similares via Last.fm tracks e deep cuts...");
    if (lastfmApiKey) {
      const lastfmPromises = seedTracks.slice(0, 3).map(async (seedTrack) => {
        try {
          const seedArtistId = seedTrack.artists[0].id;
          const deepCuts = await getArtistDeepCuts(seedArtistId, api, playlistVibe, vibeSubgroups, lastfmApiKey);
          // Avaliação via metadados
          for (const track of deepCuts) {
            if (!uriSeen.has(track.uri) && candidateTracks.length < MAX_CANDIDATES) {
              let simScore = 95;
              if (lastfmApiKey && vibeSubgroups.length > 1) {
                simScore = await calculateMultiVibeGroupSimilarity(track, vibeSubgroups, playlistVibe, lastfmApiKey);
              } else if (lastfmApiKey) {
                if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) continue;
                simScore = 90;
              }
              const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
              simScore = Math.min(100, Math.round(simScore * classification.weight));
              candidateTracks.push({ ...track, similarity: simScore, _circle: classification.circle, _source: 'deep-cut' });
              uriSeen.add(track.uri);
            }
          }
          const url = `http://ws.audioscrobbler.com/2.0/?method=track.getsimilar&artist=${encodeURIComponent(seedTrack.artists[0].name)}&track=${encodeURIComponent(seedTrack.name)}&api_key=${lastfmApiKey}&format=json&limit=10`;
          const lfRes = await lastfmLimiter.execute(() => fetch(url));
          if (lfRes.ok) {
            const data = await lfRes.json();
            const similarTracks = (data.similartracks?.track || []).filter(t => parseFloat(t.match) > 0.3).slice(0, 7);
            for (const simTrack of similarTracks) {
              try {
                const searchData = await spotifyLimiter.execute(() => api.searchTracks(`${simTrack.name} ${simTrack.artist.name}`, { limit: 1, market: 'US' }));
                const matchTrack = searchData.body.tracks.items[0];
                if (matchTrack && !uriSeen.has(matchTrack.uri) && candidateTracks.length < MAX_CANDIDATES) {
                  let similarityScore = Math.round(parseFloat(simTrack.match) * 100);
                  // NÃO usar Audio Features - usar Last.fm
                  if (lastfmApiKey && vibeSubgroups.length > 1) {
                    const vibeSim = await calculateMultiVibeGroupSimilarity(matchTrack, vibeSubgroups, playlistVibe, lastfmApiKey);
                    similarityScore = Math.round(0.6 * vibeSim + 0.4 * similarityScore);
                  } else if (lastfmApiKey) {
                    if (!(await isVibeMatchByMetadata(matchTrack, playlistVibe, lastfmApiKey))) continue;
                    similarityScore = Math.round(similarityScore * 0.8);
                  }
                  const classification = classifyCandidateByProximity(matchTrack, seedTracks, topArtistIds, relatedArtistSet);
                  similarityScore = Math.min(100, Math.round(similarityScore * classification.weight));
                  candidateTracks.push({ ...matchTrack, similarity: similarityScore, _circle: classification.circle, _source: 'lastfm' });
                  uriSeen.add(matchTrack.uri);
                }
              } catch (searchErr) {
                console.warn(`Erro na busca por similar track:`, searchErr.message);
              }
            }
            lastfmUsed = true;
          }
        } catch (error) {
          console.warn(`Aviso: Falha ao processar seed "${seedTrack.name}". Erro: ${error.message}`);
        }
      });
      await Promise.all(lastfmPromises);
      console.log(`Last.fm usado: ${lastfmUsed}. Total de candidatos: ${candidateTracks.length}`);
    }
    console.log('Minerando deep cuts de artistas nicho...');
    const nichePromises = nicheArtistIds.slice(0, 10).map(async (nicheId) => {
      const deepCuts = await getArtistDeepCuts(nicheId, api, playlistVibe, vibeSubgroups, lastfmApiKey);
      // Avaliar com metadados
      for (const track of deepCuts) {
        if (!uriSeen.has(track.uri) && candidateTracks.length < MAX_CANDIDATES) {
          let simScore = 75;
          if (lastfmApiKey && vibeSubgroups.length > 1) {
            simScore = await calculateMultiVibeGroupSimilarity(track, vibeSubgroups, playlistVibe, lastfmApiKey);
          } else if (lastfmApiKey) {
            if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) continue;
            simScore = 70;
          }
          const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
          simScore = Math.min(100, Math.round(simScore * classification.weight));
          candidateTracks.push({ ...track, similarity: simScore, _circle: 3, _source: 'deep-cut' });
          uriSeen.add(track.uri);
        }
      }
    });
    await Promise.all(nichePromises);
    if (candidateTracks.length < 10 && useTopArtists && topArtistIds.length > 0) {
      console.log('Adicionando deep cuts de top artists do usuário...');
      const topDeepPromises = topArtistIds.slice(0, 3).map(async (artistId) => {
        try {
          const deepCuts = await getArtistDeepCuts(artistId, api, playlistVibe, vibeSubgroups, lastfmApiKey);
          // Avaliar com metadados
          for (const track of deepCuts) {
            if (!uriSeen.has(track.uri) && candidateTracks.length < MAX_CANDIDATES) {
              let simScore = 80;
              if (lastfmApiKey && vibeSubgroups.length > 1) {
                simScore = await calculateMultiVibeGroupSimilarity(track, vibeSubgroups, playlistVibe, lastfmApiKey);
              } else if (lastfmApiKey) {
                if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) continue;
                simScore = 75;
              }
              const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
              simScore = Math.min(100, Math.round(simScore * classification.weight));
              candidateTracks.push({ ...track, similarity: simScore, _circle: classification.circle, _source: 'deep-cut' });
              uriSeen.add(track.uri);
            }
          }
        } catch (userTopErr) {
          console.warn(`Erro em deep cuts de top artist ${artistId}:`, userTopErr.message);
        }
      });
      await Promise.all(topDeepPromises);
    } else if (candidateTracks.length < 10 && !useTopArtists) {
      console.log('Pulando top tracks de user por mismatch de gênero. Considerando mais related artists.');
    }
    // Fase Mineração de Contexto Cultural (parallel)
    console.log("\n=== FASE: MINERAÇÃO DE CONTEXTO CULTURAL ===");
    const eraArtists = await getArtistsFromSameEra(seedTracks, culturalContext, lastfmApiKey, api);
    const sortedEraArtists = eraArtists
      .sort((a, b) => {
        if (b.overlapCount !== a.overlapCount) return b.overlapCount - a.overlapCount;
        if (a.popularity !== b.popularity) return a.popularity - b.popularity;
        return b.eraTracksCount - a.eraTracksCount;
      })
      .slice(0, 10);
    const eraPromises = sortedEraArtists.map(async (eraArtist) => {
      const eraTracks = await getTracksFromEraContext(
        eraArtist,
        culturalContext,
        playlistVibe,
        api,
        topTracksCache,
        vibeSubgroups,
        lastfmApiKey
      );
      eraTracks.forEach(track => {
        if (!uriSeen.has(track.uri) && candidateTracks.length < MAX_CANDIDATES) {
          candidateTracks.push(track);
          uriSeen.add(track.uri);
        }
      });
      console.log(` ${eraArtist.name}: ${eraTracks.length} tracks adicionadas`);
      return eraTracks.length;
    });
    await Promise.all(eraPromises);
    // Fix: Dedup por URI
    const uniqueCandidates = new Map();
    candidateTracks.forEach(track => {
      if (!uniqueCandidates.has(track.uri)) uniqueCandidates.set(track.uri, track);
    });
    candidateTracks = Array.from(uniqueCandidates.values()).slice(0, MAX_CANDIDATES);
    console.log(`Deduplicação por URI concluída: ${candidateTracks.length} tracks únicas.`);
    console.log("Analisando gêneros e décadas dos candidatos e seeds...");
    const poolForAnalysis = [
      ...seedTracks,
      ...candidateTracks.slice(0, 100)
    ];
    const artistIds = [];
    poolForAnalysis.forEach(t => {
      (t.artists || []).forEach(a => {
        if (a && a.id) artistIds.push(a.id);
      });
    });
    const artistGenresMap = await getArtistsGenres(artistIds, api);
    const genreCounts = {};
    const decadeCounts = {};
    poolForAnalysis.forEach(track => {
      const trackGenreSet = new Set();
      (track.artists || []).forEach(a => {
        const g = artistGenresMap[a.id] || [];
        g.forEach(genre => trackGenreSet.add(genre));
      });
      if (trackGenreSet.size === 0) {
        trackGenreSet.add('unknown');
      }
      trackGenreSet.forEach(g => {
        genreCounts[g] = (genreCounts[g] || 0) + 1;
      });
      const releaseDate = track.album?.release_date;
      const dec = decadeFromReleaseDate(releaseDate);
      decadeCounts[dec] = (decadeCounts[dec] || 0) + 1;
    });
    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([genre, count]) => ({ genre, count }));
    const genreDistribution = topGenres;
    const decadeDistribution = Object.entries(decadeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([decade, count]) => ({ decade, count }));
    console.log('Análise de gêneros/décadas concluída:', { genres: genreDistribution.length, decades: decadeDistribution.length });
    if (topSeedGenres.length > 0 || topSeedDecades.length > 0) {
      candidateTracks = candidateTracks.map(track => {
        const candArtistIds = (track.artists || []).map(a => a.id).filter(Boolean);
        let candGenres = new Set();
        candArtistIds.forEach(id => {
          (artistGenresMap[id] || []).forEach(g => candGenres.add(g));
        });
        if (candGenres.size === 0) candGenres.add('unknown');
        const genreMatches = Array.from(candGenres).filter(g => topSeedGenres.includes(g)).length;
        const genreMultiplier = genreMatches > 0 ? Math.min(1 + 0.06 * genreMatches, 1.18) : 0.70;
        const candDec = decadeFromReleaseDate(track.album?.release_date);
        const decadeMatch = topSeedDecades.includes(candDec);
        let decadeMultiplier = 1.0;
        if (candDec === 'Unknown') decadeMultiplier = 0.97;
        else decadeMultiplier = decadeMatch ? (playlistVibe.era.includes(candDec) ? 1.15 : 1.08) : 0.92;
        const proximityMultiplier = (() => {
          if (track._circle === 1) return 1.10;
          if (track._circle === 2) return 1.06;
          if (track._circle === 3) return 1.03;
          return 1.00;
        })();
        const combinedMultiplier = genreMultiplier * decadeMultiplier * proximityMultiplier;
        const newSim = Math.min(100, Math.round((track.similarity || 0) * combinedMultiplier));
        return { ...track, similarity: newSim, _context: { genreMatches, candDecade: candDec, genreMultiplier, decadeMultiplier, combinedMultiplier } };
      }).filter(track => track.similarity > 50);
      console.log('Filtro de contexto aplicado. Exemplo dos top 5 candidatos após ajuste:', candidateTracks.slice(0, 5).map(t => ({ id: t.id, sim: t.similarity, ctx: t._context })));
    } else {
      console.log('Sem dados suficientes de seeds para filtro de contexto. Pulando etapa.');
    }
  console.log("Fase 3: Montando playlist final com seções de vibe...");
    if (candidateTracks.length === 0) {
      throw new Error('Nenhum candidato encontrado. Verifique seeds e API keys.');
    }
    candidateTracks.forEach(track => {
      const proximity = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
      const variabilityFactor = 1 + (Math.random() - 0.5) * 0.3;
      track.finalScore = (track.similarity * proximity.weight) * variabilityFactor;
      track.circle = proximity.circle;
    });
    candidateTracks.sort((a, b) => b.finalScore - a.finalScore);
    // Seções por subgrupo de vibe
    const targetSize = Math.min(100, 70 + seedTracks.length) - seedTracks.length;
    // Anotar melhor subgrupo para cada candidato
    const subgroupAnnotated = [];
    for (const t of candidateTracks) {
      const best = await getBestSubgroupMatch(t, vibeSubgroups, lastfmApiKey);
      subgroupAnnotated.push({ ...t, _bestSubgroup: best });
    }
    // Calcular cotas por subgrupo
    const totalWeight = vibeSubgroups.reduce((s, sg) => s + (sg.weight || 0), 0) || 1;
    const quotas = vibeSubgroups.map(sg => ({
      mood: sg.mood,
      label: sg.label,
      desired: Math.max(2, Math.round(((sg.weight || (1/ vibeSubgroups.length)) / totalWeight) * targetSize)),
      picked: []
    }));
    // Distribuir tracks por melhor subgrupo, respeitando cotas e score
    subgroupAnnotated.sort((a,b) => b.finalScore - a.finalScore);
    for (const trk of subgroupAnnotated) {
      const idx = quotas.findIndex(q => q.mood === trk._bestSubgroup.mood);
      if (idx === -1) continue;
      if (quotas[idx].picked.length < quotas[idx].desired) {
        quotas[idx].picked.push(trk);
      }
    }
    // Coletar seleção e completar se faltar
    let finalSelection = quotas.flatMap(q => q.picked);
    if (finalSelection.length < targetSize) {
      const remaining = subgroupAnnotated.filter(t => !finalSelection.some(f => f.uri === t.uri));
      finalSelection = finalSelection.concat(remaining.slice(0, targetSize - finalSelection.length));
    }
    // Ordenar por seções (mood)
    const sectioned = [];
    quotas.forEach(q => {
      const section = q.picked.sort((a,b) => b.finalScore - a.finalScore);
      sectioned.push(...section);
    });
    // Se ainda faltar, append o restante mantendo ordem por score
    const selectedUris = new Set(sectioned.map(t => t.uri));
    const filler = finalSelection.filter(t => !selectedUris.has(t.uri)).sort((a,b) => b.finalScore - a.finalScore);
    finalSelection = [...sectioned, ...filler].slice(0, targetSize);
    // Mapear seeds para seu subgrupo (se houver)
    const seedSubgroupById = new Map();
    vibeSubgroups.forEach(sg => (sg.tracks || []).forEach(t => seedSubgroupById.set(t.id, { label: sg.label, mood: sg.mood })));

    const finalPlaylist = [
      ...seedTracks.map(t => ({ ...t, similarity: 100 })),
      ...finalSelection
    ].map(track => ({
      id: track.id,
      name: track.name,
      artist: (track.artists || []).map(a => a.name).join(', '),
      albumImages: track.album?.images || [],
      similarity: Math.round(track.similarity || 0),
      uri: track.uri,
      subgroupLabel: (track._bestSubgroup?.label) || seedSubgroupById.get(track.id)?.label || null,
      subgroupMood: (track._bestSubgroup?.mood) || seedSubgroupById.get(track.id)?.mood || null
    }));
    const avgSimilarity = finalPlaylist.reduce((sum, t) => sum + t.similarity, 0) / finalPlaylist.length;
    const qualityValidation = validatePlaylistQuality(finalPlaylist, seedTracks, culturalContext);
    
    // Preparar informação dos subgrupos de vibe para a resposta
    const vibeSubgroupsInfo = vibeSubgroups.map(sg => ({
      label: sg.label,
      mood: sg.mood,
      description: sg.description,
      tags: sg.tags || [],
      trackCount: (sg.tracks || []).length,
      trackNames: (sg.tracks || []).map(t => t.name),
      weight: sg.weight
    }));
    
    const responseData = {
      similarities: finalPlaylist,
      avgSimilarity: Math.round(avgSimilarity),
      featuresAvailable: false,
  recommendationsAvailable: false,
      genreDistribution,
      decadeDistribution,
      inferredVibe: playlistVibe,
      culturalContext,
      qualityValidation,
      vibeSubgroups: vibeSubgroupsInfo
    };
    console.log(lastfmCache.stats());
    console.log(lastfmLimiter.stats());
    console.log(spotifyLimiter.stats());
    res.json(responseData);
  } catch (err) {
    console.error('ERRO GERAL em /analyze:', {
      message: err.message,
      statusCode: err.statusCode,
      body: err.body,
      fullErr: err
    });
    res.status(err.statusCode || 500).json({ error: err.message, debug: process.env.NODE_ENV === 'development' ? err.body?.error?.description : undefined });
  }
});

app.post('/test-token', async (req, res) => {
  try {
    const api = createApiInstance(req);
    const meData = await spotifyLimiter.execute(() => api.getMe());
    res.json({ valid: true, user: meData.body.display_name });
  } catch (err) {
    console.error('Erro em /test-token:', err.body || err);
    res.status(err.statusCode || 500).json({ valid: false, error: err.message });
  }
});

app.post('/export-playlist', async (req, res) => {
  try {
    const api = createApiInstance(req);
    const { playlistName, trackUris } = req.body;
    const meData = await spotifyLimiter.execute(() => api.getMe());
    const playlistData = await spotifyLimiter.execute(() => api.createPlaylist(meData.body.id, playlistName, { public: false, description: 'Playlist gerada pelo Frequency Mixer' }));
    await spotifyLimiter.execute(() => api.addTracksToPlaylist(playlistData.body.id, trackUris));
    res.json({ success: true, playlistUrl: playlistData.body.external_urls.spotify });
  } catch (err) {
    console.error('Erro em /export-playlist:', err.body || err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/refresh_token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token é necessário.' });
  const tempApi = new SpotifyWebApi({ clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET, refreshToken });
  try {
    const data = await tempApi.refreshAccessToken();
    res.json({ accessToken: data.body['access_token'], expiresIn: data.body['expires_in'] });
  } catch (err) {
    console.error('Erro em /refresh_token:', err.body || err);
    res.status(403).json({ error: 'Falha ao renovar token.', details: err.body });
  }
});

class PlaylistFeedback {
  constructor() {
    this.userPreferences = new Map();
    this.successfulCombinations = [];
    this.trackRatings = new Map();
  }
  recordFeedback(playlistId, trackRatings, overallRating, playlistContext) {
    const feedback = {
      playlistId,
      trackRatings,
      overallRating,
      playlistContext,
      timestamp: Date.now()
    };
   
    this.successfulCombinations.push(feedback);
   
    const entries = (trackRatings instanceof Map)
      ? Array.from(trackRatings.entries())
      : Object.entries(trackRatings || {});
   
    for (const [trackId, rawRating] of entries) {
      const rating = Number(rawRating) || 0;
      const current = this.trackRatings.get(trackId) || { likes: 0, dislikes: 0 };
      if (rating >= 4) {
        this.trackRatings.set(trackId, { ...current, likes: current.likes + 1 });
      } else if (rating <= 2) {
        this.trackRatings.set(trackId, { ...current, dislikes: current.dislikes + 1 });
      } else {
        if (!this.trackRatings.has(trackId)) {
          this.trackRatings.set(trackId, current);
        }
      }
    }
   
    console.log(`Feedback registrado para playlist ${playlistId}: ${overallRating}/5`);
  }
  adjustWeights(context, trackFeatures) {
    const culturalEra = context && context.culturalEra;
    const baseWeights = {
      '2000s': { danceability: 2.0, energy: 1.8, valence: 1.5, acousticness: 1.2 },
      '2010s': { acousticness: 1.8, energy: 1.6, valence: 1.7, danceability: 1.5 },
      '2020s': { speechiness: 2.0, energy: 1.9, valence: 1.8, danceability: 1.6 }
    };
   
    return baseWeights[culturalEra] || baseWeights['2000s'];
  }
  getTrackScore(trackId) {
    const rating = this.trackRatings.get(trackId);
    if (!rating) return 1.0;
   
    const total = (rating.likes || 0) + (rating.dislikes || 0);
    if (total === 0) return 1.0;
   
    return 1.0 + ((rating.likes || 0) - (rating.dislikes || 0)) * 0.1;
  }
  stats() {
    const totalFeedbacks = this.successfulCombinations.length;
    const avgRating = totalFeedbacks ? (this.successfulCombinations.reduce((sum, f) => sum + (f.overallRating || 0), 0) / totalFeedbacks) : 0;
    return {
      totalFeedbacks,
      trackRatings: this.trackRatings.size,
      avgRating
    };
  }
}
const feedbackSystem = new PlaylistFeedback();

app.post('/playlist-feedback', async (req, res) => {
  try {
    const { playlistId, trackRatings, overallRating, playlistContext } = req.body;
   
    if (!playlistId || !trackRatings || overallRating === undefined) {
      return res.status(400).json({ error: 'Dados de feedback incompletos' });
    }
   
    feedbackSystem.recordFeedback(playlistId, trackRatings, overallRating, playlistContext);
   
    res.json({
      success: true,
      message: 'Feedback registrado com sucesso',
      stats: feedbackSystem.stats()
    }); 
  } catch (err) {
    console.error('Erro em /playlist-feedback:', err);
    res.status(500).json({ error: 'Erro ao processar feedback' });
  }
});

app.get('/feedback-stats', (req, res) => {
  try {
    res.json(feedbackSystem.stats());
  } catch (err) {
    res.status(500).json({ error: 'Erro ao obter estatísticas' });
  }
});

app.get('/health', async (req, res) => {
  try {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', message: err.message });
  }
});

app.listen(port, () => {
  console.log(`Backend rodando em http://127.0.0.1:${port}`);
});
