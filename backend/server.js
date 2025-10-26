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
const MAX_CANDIDATES = 80;

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

const lastfmCache = new ApiCache(60 * 60 * 1000, 300);
const spotifyCache = new ApiCache(60 * 60 * 1000, 300);
const lastfmLimiter = new RateLimiter(2, 20);
const spotifyLimiter = new RateLimiter(5, 20);
const previewCache = new ApiCache(24 * 60 * 60 * 1000, 1000); // 24h cache para URLs de preview

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

// Detecta subgrupos de vibe a partir das seeds (apenas metadados/Last.fm)
const detectVibeSubgroupsByMetadata = async (seedTracks = [], lastfmApiKey) => {
  const groups = new Map();
  const allSeedArtists = new Set();
  for (const s of seedTracks) {
    const a = (s.artists || []).map(x => x.name);
    a.forEach(n => allSeedArtists.add(n));
  }
  for (const seed of seedTracks) {
    let mood = 'neutral', subMood = null, tags = [];
    try {
      const v = await inferVibe(seed, lastfmApiKey, 'track');
      mood = v.mood || 'neutral';
      subMood = v.subMood || null;
      tags = Array.isArray(v.tags) ? v.tags : [];
    } catch (_) {}

    const releaseYear = (() => {
      const d = seed.album?.release_date || seed.album?.releaseDate;
      if (!d) return null;
      const y = parseInt(String(d).substring(0,4));
      return Number.isNaN(y) ? null : y;
    })();

    const id = `${mood}${subMood ? ':'+subMood : ''}`;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        label: `${mood}${subMood ? ` (${subMood})` : ''}`,
        mood,
        subMood,
        seedIds: [],
        seedArtists: new Set(),
        tags: new Set(),
        minYear: releaseYear || null,
        maxYear: releaseYear || null,
        count: 0,
      });
    }
    const g = groups.get(id);
    g.count += 1;
    g.seedIds.push(seed.id);
    (seed.artists || []).forEach(a => a?.name && g.seedArtists.add(a.name));
    tags.forEach(t => g.tags.add(t));
    if (releaseYear) {
      g.minYear = (g.minYear === null) ? releaseYear : Math.min(g.minYear, releaseYear);
      g.maxYear = (g.maxYear === null) ? releaseYear : Math.max(g.maxYear, releaseYear);
    }
  }

  let vibeSubgroups = Array.from(groups.values());
  if (vibeSubgroups.length === 0) {
    // Fallback quando não há dados suficientes
    vibeSubgroups = [{ id: 'neutral', label: 'neutral', mood: 'neutral', subMood: null, seedIds: [], seedArtists: new Set(), tags: new Set(), minYear: null, maxYear: null, count: seedTracks.length || 1 }];
  }
  const total = vibeSubgroups.reduce((s,g)=> s + (g.count||0), 0) || 1;
  vibeSubgroups.forEach(g => { g.weight = Math.max(1, g.count) / total; });
  return vibeSubgroups;
};

// Atribui o melhor subgrupo de vibe para uma faixa candidata
const getBestSubgroupMatch = async (track, vibeSubgroups = [], lastfmApiKey) => {
  if (!vibeSubgroups.length) return { subgroupId: null, score: 0 };
  let tv = { mood: 'neutral', subMood: null, tags: [] };
  try {
    const v = await inferVibe(track, lastfmApiKey, 'track');
    tv = { mood: v.mood || 'neutral', subMood: v.subMood || null, tags: Array.isArray(v.tags) ? v.tags : [] };
  } catch (_) {}

  const trackYear = (() => {
    const d = track.album?.release_date || track.album?.releaseDate;
    if (!d) return null;
    const y = parseInt(String(d).substring(0,4));
    return Number.isNaN(y) ? null : y;
  })();
  const tArtistNames = new Set((track.artists || []).map(a => a.name).filter(Boolean));

  let best = { subgroupId: null, score: -Infinity };
  for (const g of vibeSubgroups) {
    let s = 0;
    if (tv.mood === g.mood) s += 50;
    if (tv.subMood && g.subMood && tv.subMood === g.subMood) s += 15;
    // Tags overlap
    const gTags = g.tags || new Set();
    const overlap = tv.tags.filter(t => gTags.has(t)).length;
    s += Math.min(20, overlap * 4);
    // Era closeness
    if (trackYear && g.minYear && g.maxYear) {
      if (trackYear >= g.minYear && trackYear <= g.maxYear) s += 10;
      else s += Math.max(0, 8 - Math.abs(trackYear - ((g.minYear+g.maxYear)/2)) / 5);
    }
    // Artist proximity to seed artists of the subgroup
    const seedArtists = g.seedArtists || new Set();
    for (const n of tArtistNames) { if (seedArtists.has(n)) { s += 10; break; } }
    // Small boost by subgroup weight (prevalence among seeds)
    s += Math.round((g.weight || 0) * 10);
    if (s > best.score) best = { subgroupId: g.id, score: s };
  }
  return best;
};

// Monta a playlist final em seções (quotas por subgrupo)
const assemblePlaylistBySections = (vibeSubgroups = [], candidates = [], targetSize = 30) => {
  if (!vibeSubgroups.length) return candidates.slice(0, targetSize);
  const byGroup = new Map();
  vibeSubgroups.forEach(g => byGroup.set(g.id, []));
  candidates.forEach(c => {
    const id = c._subgroupId || null;
    if (id && byGroup.has(id)) byGroup.get(id).push(c);
  });
  vibeSubgroups.forEach(g => byGroup.get(g.id).sort((a,b) => (b.finalScore||b.similarity||0) - (a.finalScore||a.similarity||0)));

  const totalW = vibeSubgroups.reduce((s,g)=> s + (g.weight || 0), 0) || 1;
  let quotas = vibeSubgroups.map(g => ({ id: g.id, n: Math.max(1, Math.round(targetSize * (g.weight || 0) / totalW)) }));
  let allocated = quotas.reduce((s,q)=> s+q.n, 0);
  // Ajusta quotas para somar exatamente targetSize
  while (allocated > targetSize) { const q = quotas.sort((a,b)=> b.n - a.n)[0]; if (q.n>1){ q.n--; allocated--; } else break; }
  while (allocated < targetSize) { const q = quotas.sort((a,b)=> (byGroup.get(b.id).length - b.n) - (byGroup.get(a.id).length - a.n))[0]; q.n++; allocated++; }

  const picked = new Set();
  const result = [];
  // Constrói por seções (ordem: grupos mais pesados primeiro)
  const ordered = [...vibeSubgroups].sort((a,b)=> (b.weight||0)-(a.weight||0));
  for (const g of ordered) {
    const q = quotas.find(x => x.id === g.id)?.n || 0;
    const pool = byGroup.get(g.id) || [];
    for (const t of pool) {
      if (result.length >= targetSize) break;
      if (picked.has(t.uri)) continue;
      result.push(t);
      picked.add(t.uri);
      if (result.filter(x => x._subgroupId === g.id).length >= q) break;
    }
  }
  // Preenche sobras com melhores candidatos globais ainda não usados
  if (result.length < targetSize) {
    const remaining = candidates
      .filter(t => !picked.has(t.uri))
      .sort((a,b)=> (b.finalScore||b.similarity||0) - (a.finalScore||a.similarity||0));
    for (const t of remaining) {
      if (result.length >= targetSize) break;
      result.push(t);
    }
  }
  return result.slice(0, targetSize);
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

const calculateEnhancedVibeSimilarity = (track, avgVibe, playlistVibe, culturalContext = null) => {
  // Simplified similarity calculation based on metadata only
  let baseScore = 85;
  
  if (culturalContext && culturalContext.isFocusedEra) {
    const trackYear = parseInt(track.album?.release_date?.substring(0, 4));
    if (trackYear && culturalContext.timeRange) {
      if (trackYear >= culturalContext.timeRange[0] && trackYear <= culturalContext.timeRange[1]) {
        baseScore += 10;
      }
    }
  }

  // Ajuste opcional por feedback do usuário, se houver ID disponível
  try {
    const id = track && (track.id || track.trackId);
    if (id && typeof feedbackSystem !== 'undefined' && feedbackSystem && typeof feedbackSystem.getTrackScore === 'function') {
      const feedbackScore = feedbackSystem.getTrackScore(id);
      if (typeof feedbackScore === 'number' && isFinite(feedbackScore)) {
        baseScore *= feedbackScore;
      }
    }
  } catch (_) { /* noop */ }

  return Math.min(100, baseScore);
};

const isVibeMatch = (track, playlistVibe) => {
  // Simplified vibe matching based only on metadata
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

const getArtistDeepCuts = async (artistId, api, playlistVibe, avgVibe) => {
  try {
    const albumsData = await spotifyLimiter.execute(() =>
      api.getArtistAlbums(artistId, { limit: 20, include_groups: 'album,single' })
    );
    const albums = albumsData.body.items;
    const randomAlbums = albums.sort(() => Math.random() - 0.5).slice(0, 2);
    const deepCuts = [];
   
    for (const album of randomAlbums) {
      const tracksData = await spotifyLimiter.execute(() =>
        api.getAlbumTracks(album.id, { limit: 10 })
      );
      const tracks = tracksData.body.items;
      const middleTracks = tracks.slice(
        Math.floor(tracks.length * 0.4),
        Math.floor(tracks.length * 0.6)
      );
     
      middleTracks.forEach(track => {
        deepCuts.push({
          ...track,
          album: { images: album.images, release_date: album.release_date },
          artists: [{ id: artistId, name: album.artists?.[0]?.name || 'Unknown' }]
        });
      });
    }
   
    return deepCuts.slice(0, 3);
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

const getTracksFromEraContext = async (eraArtist, culturalContext, playlistVibe, avgVibe, featuresAvailable, api, topTracksCache) => {
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
    if (featuresAvailable && eraRelevantTracks.length > 0) {
      const trackIds = eraRelevantTracks.slice(0, maxTracks).map(t => t.id);
      const featMap = await fetchAudioFeaturesMap(api, trackIds);
      eraRelevantTracks.slice(0, maxTracks).forEach((track) => {
        const feat = featMap.get(track.id);
        if (feat && isVibeMatch(feat, playlistVibe)) {
          tracks.push({
            ...track,
            similarity: 85,
            _circle: 2,
            _source: 'era-context',
            _eraYear: parseInt(track.album.release_date.substring(0, 4))
          });
        } else {
          tracks.push({
            ...track,
            similarity: 85,
            _circle: 2,
            _source: 'era-context'
          });
        }
      });
    } else {
      eraRelevantTracks.slice(0, maxTracks).forEach(track => {
        tracks.push({
          ...track,
          similarity: 85,
          _circle: 2,
          _source: 'era-context'
        });
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

// Removed audio features estimation functions as they are no longer needed
// Provide safe no-op stubs to avoid reference errors in legacy code paths.
const fetchAudioFeaturesMap = async () => new Map();
const getEstimatedFeaturesForTrack = async () => null;

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
    const seedIds = seedTracks.map(t => t.id);
    let avgVibe = {
      danceability: 0.5, energy: 0.5, valence: 0.5,
      acousticness: 0.5, tempo: 120, loudness: -10,
      speechiness: 0.1, instrumentalness: 0.1
    };
    let featuresAvailable = false;
    if (lastfmApiKey) {
      try {
        const estimated = [];
        for (const t of seedTracks.slice(0, 5)) {
          const ef = await getEstimatedFeaturesForTrack(t, lastfmApiKey);
          if (ef) estimated.push(ef);
        }
        if (estimated.length > 0) {
          const keys = ['danceability', 'energy', 'valence', 'acousticness', 'tempo', 'loudness', 'speechiness', 'instrumentalness'];
          keys.forEach(k => {
            avgVibe[k] = estimated.reduce((s, f) => s + (f[k] || 0), 0) / estimated.length;
          });
          featuresAvailable = true;
          console.log('AvgVibe estimado via Last.fm tags:', avgVibe);
        }
      } catch (e) {
        console.warn('Erro ao estimar avgVibe via Last.fm:', e.message);
      }
    }
    console.log('Inferindo vibe por metadados...');
    const playlistVibe = await inferVibe(seedTracks, lastfmApiKey, 'playlist', { topSeedGenres, topSeedDecades });
    console.log('Vibe inferida:', playlistVibe);
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
    let recTracks = [];
    console.log("Fase 1: Obtendo recomendações do Spotify...");
    try {
      const validSeeds = uniqueTrackIds.slice(0, 5).filter(id => id && id.length > 0);
      if (validSeeds.length === 0) throw new Error('Nenhum seed válido.');
      const recsOptions = {
        seed_tracks: validSeeds,
        limit: 30 + Math.floor(Math.random() * 20),
      };
      if (useTopArtists && topArtistIds.length > 0 && validSeeds.length < 4) {
        recsOptions.seed_artists = topArtistIds.slice(0, Math.min(2, 4 - validSeeds.length));
      }
      const recsData = await spotifyLimiter.execute(() => api.getRecommendations(recsOptions));
      recTracks = recsData.body.tracks.filter(t => !uriSeen.has(t.uri));
      console.log(`${recTracks.length} recomendações do Spotify adicionadas.`);
    } catch (recsErr) {
      if (recsErr.statusCode === 404 || recsErr.statusCode === 403) {
        console.warn('Recomendações do Spotify indisponíveis. Usando fallback.');
      } else {
        console.warn('Erro ao obter recomendações:', recsErr.message);
      }
      recTracks = [];
    }
    if (recTracks.length > 0) {
      for (const track of recTracks) {
        let simScore = 85;
        if (lastfmApiKey) {
          const estFeat = await getEstimatedFeaturesForTrack(track, lastfmApiKey);
          if (estFeat) {
            if (!isVibeMatch(estFeat, playlistVibe)) continue;
            simScore = calculateEnhancedVibeSimilarity(estFeat, avgVibe, playlistVibe, culturalContext);
          } else {
            if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) continue;
            simScore = 80;
          }
        }
        const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
        simScore = Math.min(100, Math.round(simScore * classification.weight));
        if (candidateTracks.length < MAX_CANDIDATES) {
          candidateTracks.push({ ...track, similarity: simScore, _circle: classification.circle, _source: 'spotify-rec' });
          uriSeen.add(track.uri);
        }
      }
    }
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
        const deepCuts = await getArtistDeepCuts(lfArtistId, api, playlistVibe, avgVibe, false);
        for (const track of deepCuts) {
          if (!uriSeen.has(track.uri) && candidateTracks.length < MAX_CANDIDATES) {
            let simScore = 75;
            if (lastfmApiKey) {
              if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) continue;
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
          const deepCuts = await getArtistDeepCuts(seedArtistId, api, playlistVibe, avgVibe, featuresAvailable);
          const deepIds = deepCuts.map(t => t.id).filter(Boolean);
          const deepFeatMap = featuresAvailable && deepIds.length > 0 ? await fetchAudioFeaturesMap(api, deepIds) : new Map();
          for (const track of deepCuts) {
            if (!uriSeen.has(track.uri) && candidateTracks.length < MAX_CANDIDATES) {
              let simScore = 95;
              if (featuresAvailable) {
                const candFeatures = deepFeatMap.get(track.id);
                if (candFeatures) simScore = calculateEnhancedVibeSimilarity(candFeatures, avgVibe, playlistVibe, culturalContext);
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
                  if (featuresAvailable) {
                    const featMap = await fetchAudioFeaturesMap(api, [matchTrack.id]);
                    const candFeatures = featMap.get(matchTrack.id);
                    if (candFeatures) {
                      if (!isVibeMatch(candFeatures, playlistVibe)) continue;
                      const vibeSim = calculateEnhancedVibeSimilarity(candFeatures, avgVibe, playlistVibe, culturalContext);
                      similarityScore = Math.round(0.6 * vibeSim + 0.4 * similarityScore);
                    }
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
      const deepCuts = await getArtistDeepCuts(nicheId, api, playlistVibe, avgVibe, false);
      for (const track of deepCuts) {
        if (!uriSeen.has(track.uri) && candidateTracks.length < MAX_CANDIDATES) {
          let simScore = 70;
          if (lastfmApiKey) {
            if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) continue;
          }
          const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
          simScore = Math.min(100, Math.round(simScore * classification.weight));
          candidateTracks.push({ ...track, similarity: simScore, _circle: 3, _source: 'deep-cut' });
          uriSeen.add(track.uri);
        }
      }
    });
    await Promise.all(nichePromises);
    if (candidateTracks.length < 10 && !useTopArtists) {
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
        avgVibe,
        featuresAvailable,
        api,
        topTracksCache
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
    console.log("Fase 3: Montando playlist final...");
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

    // Multi-vibe: detectar subgrupos a partir das seeds
    const vibeSubgroups = await detectVibeSubgroupsByMetadata(seedTracks, lastfmApiKey);
    const groupMap = new Map(vibeSubgroups.map(g => [g.id, g]));

    // Atribuir melhor subgrupo para cada candidato
    await Promise.all(candidateTracks.map(async (c) => {
      const best = await getBestSubgroupMatch(c, vibeSubgroups, lastfmApiKey);
      c._subgroupId = best.subgroupId;
      c._subgroupScore = best.score;
    }));

    const targetSize = Math.min(60, 40 + seedTracks.length) - seedTracks.length;
    const finalSelection = assemblePlaylistBySections(vibeSubgroups, candidateTracks, targetSize);

    // Anotar seeds com seus subgrupos
    const seedWithGroups = [];
    for (const s of seedTracks) {
      let mood='neutral', subMood=null;
      try { const v = await inferVibe(s, lastfmApiKey, 'track'); mood = v.mood||'neutral'; subMood = v.subMood||null; } catch(_) {}
      const id = `${mood}${subMood? ':'+subMood: ''}`;
      const g = groupMap.get(id) || vibeSubgroups[0];
      seedWithGroups.push({ ...s, _subgroupId: g?.id, _subgroupLabel: g?.label, _subgroupMood: g?.mood, similarity: 100 });
    }

    // Construir playlist final com anotações de subgrupo
    const finalPlaylist = [
      ...seedWithGroups,
      ...finalSelection.map(t => ({
        ...t,
        _subgroupLabel: groupMap.get(t._subgroupId)?.label,
        _subgroupMood: groupMap.get(t._subgroupId)?.mood
      }))
    ].map(track => ({
      id: track.id,
      name: track.name,
      artist: (track.artists || []).map(a => a.name).join(', '),
      albumImages: track.album?.images || [],
      similarity: Math.round(track.similarity || 0),
      uri: track.uri,
      subgroupLabel: track._subgroupLabel || null,
      subgroupMood: track._subgroupMood || null
    }));
    const avgSimilarity = finalPlaylist.reduce((sum, t) => sum + t.similarity, 0) / finalPlaylist.length;
    const qualityValidation = validatePlaylistQuality(finalPlaylist, seedTracks, culturalContext);
    const responseData = {
      similarities: finalPlaylist,
      avgSimilarity: Math.round(avgSimilarity),
      featuresAvailable,
      recommendationsAvailable: recTracks.length > 0,
      genreDistribution,
      decadeDistribution,
      inferredVibe: playlistVibe,
      culturalContext,
      qualityValidation,
      vibeSubgroups: vibeSubgroups.map(g => ({
        id: g.id,
        label: g.label,
        mood: g.mood,
        subMood: g.subMood,
        weight: g.weight,
        seedCount: g.count,
        seedArtists: Array.from(g.seedArtists || []),
        tags: Array.from(g.tags || [])
      }))
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

// Endpoint para obter URL de prévia de áudio via fontes alternativas (Deezer/iTunes)
app.post('/track-preview', async (req, res) => {
  try {
    const { id, name, artist } = req.body || {};
    const key = `preview:${(artist||'').toLowerCase()}:${(name||'').toLowerCase()}`;
    const cached = previewCache.get(key);
    if (cached) {
      return res.json({ previewUrl: cached, source: 'cache' });
    }

    if (!name || !artist) {
      return res.status(400).json({ error: 'Parâmetros insuficientes: name e artist são obrigatórios.' });
    }

    // 1) Tentar Deezer
    try {
      const q = `artist:"${artist}" track:"${name}"`;
      const dzUrl = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=3`;
      const dzRes = await fetch(dzUrl);
      if (dzRes.ok) {
        const dzData = await dzRes.json();
        const match = (dzData.data || []).find(it => it.preview);
        if (match && match.preview) {
          previewCache.set(key, match.preview);
          return res.json({ previewUrl: match.preview, source: 'deezer' });
        }
      }
    } catch (e) {
      console.warn('Deezer preview falhou:', e.message);
    }

    // 2) Tentar iTunes
    try {
      const term = `${artist} ${name}`;
      const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=5`;
      const itRes = await fetch(itUrl);
      if (itRes.ok) {
        const itData = await itRes.json();
        const candidate = (itData.results || []).find(r => r.previewUrl);
        if (candidate && candidate.previewUrl) {
          previewCache.set(key, candidate.previewUrl);
          return res.json({ previewUrl: candidate.previewUrl, source: 'itunes' });
        }
      }
    } catch (e) {
      console.warn('iTunes preview falhou:', e.message);
    }

    return res.json({ previewUrl: null });
  } catch (err) {
    console.error('Erro em /track-preview:', err);
    res.status(500).json({ error: 'Falha ao obter prévia.' });
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

app.post('/lyrics', async (req, res) => {
  try {
    const { trackName, artistName } = req.body;
    if (!trackName || !artistName) {
      return res.status(400).json({ error: 'Track name and artist name are required' });
    }

    const musixmatchApiKey = process.env.MUSIXMATCH_API_KEY;
    if (!musixmatchApiKey) {
      return res.status(500).json({ error: 'Musixmatch API key not configured' });
    }

    // Primeiro, buscar o track_id usando matcher.track.get
    const matcherUrl = `https://api.musixmatch.com/ws/1.1/matcher.track.get?q_track=${encodeURIComponent(trackName)}&q_artist=${encodeURIComponent(artistName)}&apikey=${musixmatchApiKey}`;
    
    const matcherResponse = await fetch(matcherUrl);
    const matcherData = await matcherResponse.json();

    if (matcherData.message.header.status_code !== 200) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const trackId = matcherData.message.body.track.track_id;

    // Agora buscar as letras usando track.lyrics.get
    const lyricsUrl = `https://api.musixmatch.com/ws/1.1/track.lyrics.get?track_id=${trackId}&apikey=${musixmatchApiKey}`;
    
    const lyricsResponse = await fetch(lyricsUrl);
    const lyricsData = await lyricsResponse.json();

    if (lyricsData.message.header.status_code !== 200) {
      return res.status(404).json({ error: 'Lyrics not found' });
    }

    const lyrics = lyricsData.message.body.lyrics;
    
    // Retornar apenas um trecho das letras (primeiras 30% das palavras) conforme ToS
    const words = lyrics.lyrics_body.split(' ');
    const previewLength = Math.floor(words.length * 0.3);
    const preview = words.slice(0, previewLength).join(' ') + '...';

    res.json({
      snippet: preview,
      copyright: lyrics.lyrics_copyright,
      tracking_url: lyrics.script_tracking_url,
      explicit: lyrics.explicit === 1
    });

  } catch (err) {
    console.error('Error in /lyrics:', err);
    res.status(500).json({ error: 'Failed to fetch lyrics' });
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
})