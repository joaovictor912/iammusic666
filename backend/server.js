const express = require('express');
const cors = require('cors');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({ origin: 'http://127.0.0.1:3000' }));
app.use(express.json());

// Helper para criar uma instância da API para cada requisição
const createApiInstance = (req) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('Token de acesso não fornecido.');
  console.log('Token recebido (primeiros 20 chars):', token.substring(0, 20) + '...');
  const api = new SpotifyWebApi({ clientId: process.env.SPOTIFY_CLIENT_ID });
  api.setAccessToken(token);
  return api;
};

// Instância SOMENTE para o fluxo de autorização
const authApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: 'http://127.0.0.1:5000/callback',
});

app.get('/auth', (req, res) => {
  const scopes = ['user-read-private', 'user-read-email', 'playlist-modify-public', 'playlist-modify-private', 'user-top-read'];
  res.redirect(authApi.createAuthorizeURL(scopes));
});

app.get('/callback', async (req, res) => {
  try {
    const data = await authApi.authorizationCodeGrant(req.query.code);
    const { access_token, refresh_token, expires_in } = data.body;
    res.redirect(`http://127.0.0.1:3000?access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${expires_in}`);
  } catch (err) {
    console.error('Erro no callback:', err.body || err.message);
    res.redirect(`http://127.0.0.1:3000/?error=token_fail`);
  }
});

app.post('/search', async (req, res) => {
    try {
        const api = createApiInstance(req);
        const { query } = req.body;
        const searchData = await api.searchTracks(query, { limit: 1 });
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
        const searchData = await api.searchTracks(query, { limit: 8 });
        const tracks = searchData.body.tracks.items.map(track => ({ id: track.id, name: track.name, artist: track.artists.map(a => a.name).join(', '), albumImages: track.album.images, previewUrl: track.preview_url }));
        res.json({ tracks });
    } catch (err) { 
      console.error('Erro em /search-suggestions:', err.body || err);
      res.status(err.statusCode || 500).json({ error: err.message }); 
    }
});

// Função helper para inferir vibe da playlist (mood, era, gêneros dominantes) - DETECÇÃO DE VIBE MAIS INTELIGENTE COM SUBMOODS
const inferPlaylistVibeFromMetadata = async (seedTracks, topSeedGenres, topSeedDecades, lastfmApiKey) => {
  const allTags = [];
  
  // Coleta tags de todas as seeds
  for (const track of seedTracks.slice(0, 3)) {
    try {
      const artistName = track.artists[0].name;
      const trackName = track.name;
      
      const url = `http://ws.audioscrobbler.com/2.0/?method=track.gettoptags&artist=${encodeURIComponent(artistName)}&track=${encodeURIComponent(trackName)}&api_key=${lastfmApiKey}&format=json`;
      const res = await fetch(url);
      const data = await res.json();
      
      const tags = (data.toptags?.tag || [])
        .map(t => t.name.toLowerCase())
        .slice(0, 10);
      
      allTags.push(...tags);
      
      await delay(100);
    } catch (e) {
      console.warn(`Erro ao buscar tags para ${track.name}:`, e.message);
    }
  }
  
  // Conta tags mais comuns
  const tagCounts = {};
  allTags.forEach(tag => {
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  });
  
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
  
  console.log('Top tags do Last.fm:', topTags);
  
  // Detecta mood pelas tags
  let mood = 'neutral';
  let subMood = null;
  
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
  
  return {
    mood,
    subMood,
    era,
    genres: topSeedGenres.slice(0, 3),
    tags: topTags,
    description: `${mood}${subMood ? ` (${subMood})` : ''} ${era} ${topSeedGenres.slice(0,2).join('/')} vibe`,
    profile: {
      isAcoustic: topTags.includes('acoustic'),
      isFast: topTags.includes('fast') || topTags.includes('energetic'),
      isLoud: topTags.includes('heavy') || topTags.includes('loud'),
      isVocal: !topTags.includes('instrumental'),
      isInstrumental: topTags.includes('instrumental')
    }
  };
};

// PARTE 1: Detector de Era Cultural
const detectCulturalEra = (seedTracks, topSeedGenres, topSeedDecades) => {
  // Análise temporal mais granular
  const years = seedTracks
    .map(t => {
      const date = t.album?.release_date;
      if (!date) return null;
      return parseInt(date.substring(0, 4));
    })
    .filter(y => y && y > 1950);
  
  const avgYear = Math.round(years.reduce((sum, y) => sum + y, 0) / years.length);
  const yearSpread = Math.max(...years) - Math.min(...years);
  
  // Define "eras culturais" mais específicas
  let culturalEra = null;
  let eraKeywords = [];
  
  if (avgYear >= 2020) {
    culturalEra = '2020s';
    eraKeywords = ['hyperpop', 'bedroom pop', 'alt', 'tiktok era'];
  } else if (avgYear >= 2015 && avgYear < 2020) {
    culturalEra = 'late-2010s';
    eraKeywords = ['streaming era', 'soundcloud', 'trap', 'indie'];
  } else if (avgYear >= 2010 && avgYear < 2015) {
    culturalEra = 'early-2010s';
    eraKeywords = ['edm boom', 'dubstep', 'indie folk', 'tumblr era'];
  } else if (avgYear >= 2004 && avgYear < 2010) {
    culturalEra = 'mid-2000s'; // ← SUA ERA ALVO
    eraKeywords = ['pop-rap crossover', 'urban radio', 'ringtone era', 'crunk', 'timbaland'];
  } else if (avgYear >= 1998 && avgYear < 2004) {
    culturalEra = 'late-90s-early-2000s';
    eraKeywords = ['teen pop', 'nu metal', 'post-grunge', 'trl era'];
  } else if (avgYear >= 1990 && avgYear < 1998) {
    culturalEra = '90s';
    eraKeywords = ['grunge', 'hip hop golden age', 'britpop', 'r&b'];
  } else if (avgYear >= 1980 && avgYear < 1990) {
    culturalEra = '80s';
    eraKeywords = ['synth pop', 'new wave', 'mtv era', 'hair metal'];
  } else {
    culturalEra = 'classic';
    eraKeywords = ['classic rock', 'disco', 'funk', 'soul'];
  }
  
  // Detecta se é uma era "focada" ou "ampla"
  const isFocusedEra = yearSpread <= 5;
  
  // Mix de gêneros + era para contexto
  const genreMix = topSeedGenres.slice(0, 3).join('+');
  
  return {
    culturalEra,
    eraKeywords,
    avgYear,
    yearSpread,
    isFocusedEra,
    searchContext: `${genreMix} ${culturalEra}`, // Ex: "pop+hip hop mid-2000s"
    timeRange: [Math.min(...years), Math.max(...years)]
  };
};

// Função helper para similaridade de vibe - ANÁLISE SEMÂNTICA MELHORADA COM PESOS E BONUS
const calculateEnhancedVibeSimilarity = (candidateFeatures, avgVibe, playlistVibe) => {
  // Pesos baseados no tipo de vibe detectada
  const weights = {
    melancholic: { valence: 2.5, energy: 1.5, acousticness: 2.0, tempo: 1.0, loudness: 1.2, danceability: 1.0 },
    party: { danceability: 2.5, energy: 2.0, valence: 2.0, tempo: 1.8, loudness: 1.5, acousticness: 0.5 },
    upbeat: { energy: 2.0, danceability: 2.0, tempo: 1.5, valence: 1.5, acousticness: 1.0 },
    neutral: { danceability: 1.0, energy: 1.0, valence: 1.0, acousticness: 1.0, tempo: 1.0, loudness: 1.0 }
  };
  
  const w = weights[playlistVibe.mood] || weights.neutral;
  
  // Distância euclidiana ponderada
  let dist = Math.sqrt(
    Math.pow((candidateFeatures.danceability - avgVibe.danceability) * (w.danceability || 1), 2) +
    Math.pow((candidateFeatures.energy - avgVibe.energy) * (w.energy || 1), 2) +
    Math.pow((candidateFeatures.valence - avgVibe.valence) * (w.valence || 1), 2) +
    Math.pow((candidateFeatures.acousticness - avgVibe.acousticness) * (w.acousticness || 1), 2) +
    Math.pow((candidateFeatures.tempo - avgVibe.tempo) / 30 * (w.tempo || 1), 2) +
    Math.pow((candidateFeatures.loudness - avgVibe.loudness) / 5 * (w.loudness || 1), 2) +
    Math.pow((candidateFeatures.speechiness - avgVibe.speechiness) * 1.2, 2) +
    Math.pow((candidateFeatures.instrumentalness - avgVibe.instrumentalness) * 1.0, 2)
  );
  
  // Bonus para características extremas que combinam (muito triste + muito triste, etc)
  if (playlistVibe.mood === 'melancholic') {
    if (candidateFeatures.valence < 0.3 && avgVibe.valence < 0.3) dist *= 0.85; // Boost
  } else if (playlistVibe.mood === 'party') {
    if (candidateFeatures.energy > 0.7 && avgVibe.energy > 0.7 && 
        candidateFeatures.danceability > 0.7 && avgVibe.danceability > 0.7) {
      dist *= 0.80; // Boost forte
    }
  }
  
  return Math.max(0, 100 - (dist * 15));
};

// Função helper para validação rigorosa de vibe match
const isVibeMatch = (candFeatures, playlistVibe) => {
  const { mood, subMood, profile } = playlistVibe;
  
  // Regras rígidas para moods específicos
  if (mood === 'melancholic' || subMood === 'sad-trap') {
    if (candFeatures.valence > 0.5) return false; // Muito feliz
    if (candFeatures.energy > 0.7) return false; // Muito energético
  }
  
  if (mood === 'party') {
    if (candFeatures.danceability < 0.45) return false;
    if (candFeatures.energy < 0.55) return false;
  }
  
  if (mood === 'chill' || subMood === 'mellow') {
    if (candFeatures.energy > 0.65) return false;
    if (candFeatures.loudness > -5) return false;
  }
  
  if (subMood === 'acoustic' || profile.isAcoustic) {
    if (candFeatures.acousticness < 0.3) return false;
  }
  
  return true;
};

const isVibeMatchByMetadata = async (track, playlistVibe, lastfmApiKey) => {
  const trackVibe = await inferVibeFromMetadata(track, lastfmApiKey);
  
  // Se confiança muito baixa, aceita
  if (trackVibe.confidence < 40) return true;
  
  // Se moods são compatíveis
  if (trackVibe.mood === playlistVibe.mood) return true;
  
  // Moods relacionados
  const compatible = {
    melancholic: ['chill', 'neutral'],
    party: ['upbeat', 'neutral'],
    chill: ['melancholic', 'neutral'],
    aggressive: ['party', 'neutral']
  };
  
  return compatible[playlistVibe.mood]?.includes(trackVibe.mood) || false;
};

// Função helper para inferir vibe por tags do Last.fm
const inferVibeFromMetadata = async (track, lastfmApiKey) => {
  const artistName = track.artists[0].name;
  const trackName = track.name;
  
  try {
    // Pega tags do Last.fm (ex: "melancholic", "party", "chill")
    const url = `http://ws.audioscrobbler.com/2.0/?method=track.gettoptags&artist=${encodeURIComponent(artistName)}&track=${encodeURIComponent(trackName)}&api_key=${lastfmApiKey}&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    
    const tags = (data.toptags?.tag || [])
      .map(t => t.name.toLowerCase())
      .slice(0, 10);
    
    // Classifica por tags
    const moodTags = {
      melancholic: ['sad', 'melancholy', 'melancholic', 'depressing', 'emotional', 'dark'],
      party: ['party', 'dance', 'club', 'energetic', 'upbeat', 'fun'],
      chill: ['chill', 'relaxing', 'mellow', 'ambient', 'calm', 'peaceful'],
      aggressive: ['aggressive', 'angry', 'heavy', 'intense', 'hard']
    };
    
    let detectedMood = 'neutral';
    let maxMatches = 0;
    
    for (const [mood, keywords] of Object.entries(moodTags)) {
      const matches = tags.filter(t => keywords.some(k => t.includes(k))).length;
      if (matches > maxMatches) {
        maxMatches = matches;
        detectedMood = mood;
      }
    }
    
    return {
      mood: detectedMood,
      tags,
      confidence: maxMatches > 0 ? Math.min(maxMatches * 25, 100) : 30
    };
    
  } catch (e) {
    return { mood: 'neutral', tags: [], confidence: 0 };
  }
};

// Função helper para delay (rate limiting)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// NOVO: getRelatedArtists via Last.fm
const getRelatedArtistsViaLastfm = async (seedTracks, lastfmApiKey, api) => {
  const relatedMap = new Map(); // artistSpotifyId -> [relatedSpotifyIds]
  
  for (const seedTrack of seedTracks) {
    const seedArtistName = seedTrack.artists[0].name;
    const seedArtistId = seedTrack.artists[0].id;
    
    try {
      // 1. Pega similares do Last.fm (por NOME, não ID)
      const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(seedArtistName)}&api_key=${lastfmApiKey}&format=json&limit=20`;
      const res = await fetch(url);
      const data = await res.json();
      
      const similarArtists = (data.similarartists?.artist || [])
        .filter(a => parseFloat(a.match) > 0.4)
        .slice(0, 15);
      
      const relatedIds = [];
      
      // 2. Para cada artista similar, busca ID no Spotify
      for (const simArtist of similarArtists) {
        try {
          const searchData = await api.searchArtists(simArtist.name, { limit: 1 });
          const spotifyArtist = searchData.body.artists.items[0];
          
          if (spotifyArtist && spotifyArtist.id !== seedArtistId) {
            relatedIds.push(spotifyArtist.id);
          }
        } catch (e) {
          console.warn(`Erro ao buscar ${simArtist.name} no Spotify:`, e.message);
        }
        await delay(100);
      }
      
      relatedMap.set(seedArtistId, relatedIds);
      console.log(`✓ ${seedArtistName}: ${relatedIds.length} relacionados via Last.fm`);
      
    } catch (e) {
      console.warn(`Erro Last.fm para ${seedArtistName}:`, e.message);
      relatedMap.set(seedArtistId, []);
    }
    
    await delay(200);
  }
  
  return relatedMap;
};

// NOVO: Exploração de rede via Last.fm
const exploreArtistNetworkViaLastfm = async (seedTracks, topSeedGenres, lastfmApiKey, api, depth = 2) => {
  const network = new Map(); // artistName -> { spotifyId, genres, popularity, level }
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
      // 1. Busca info do artista no Spotify (se tiver ID válido)
      let artistInfo = { genres: [], popularity: 50 };
      if (spotifyId) {
        try {
          const artistData = await api.getArtist(spotifyId);
          artistInfo = {
            genres: artistData.body.genres || [],
            popularity: artistData.body.popularity || 50
          };
        } catch (e) {
          console.warn(`Spotify ID ${spotifyId} inválido, usando busca por nome`);
          // Fallback: busca por nome
          const searchData = await api.searchArtists(name, { limit: 1 });
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
      
      // 2. Pega relacionados via Last.fm
      const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(name)}&api_key=${lastfmApiKey}&format=json&limit=20`;
      const res = await fetch(url);
      const data = await res.json();
      
      const similarArtists = (data.similarartists?.artist || [])
        .filter(a => parseFloat(a.match) > 0.4);
      
      // 3. Filtra por overlap de gênero e baixa popularidade
      const seedGenresSet = new Set(topSeedGenres);
      
      for (const simArtist of similarArtists.slice(0, level === 0 ? 10 : 5)) {
        const simName = simArtist.name;
        const simNameLower = simName.toLowerCase();
        
        if (visited.has(simNameLower)) continue;
        
        // Busca no Spotify para pegar gêneros/popularidade
        try {
          const searchData = await api.searchArtists(simName, { limit: 1 });
          const spotifyArtist = searchData.body.artists.items[0];
          
          if (spotifyArtist) {
            const hasGenreOverlap = spotifyArtist.genres.some(g => 
              seedGenresSet.has(g) || 
              seedGenresSet.has('unknown') // Se seeds não têm gênero, aceita todos
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
        
        await delay(100);
      }
      
      await delay(150);
      
    } catch (e) {
      console.warn(`Erro ao explorar ${name}:`, e.message);
    }
  }
  
  console.log(`✓ Rede explorada: ${network.size} artistas`);
  const nicheCount = Array.from(network.values()).filter(a => a.popularity < 55).length;
  console.log(`  - ${nicheCount} artistas nicho (popularidade < 55)`);
  
  return network;
};

// PARTE 1: CHAMADA DE detectCulturalEra (será integrada na rota)

// PARTE 2: Busca Contextual de Artistas da Mesma Era
const getArtistsFromSameEra = async (seedTracks, culturalContext, lastfmKey, api) => {
  const eraArtists = new Set();
  const { timeRange, culturalEra, eraKeywords } = culturalContext;
  
  console.log(`Buscando artistas do contexto: ${culturalEra} (${timeRange[0]}-${timeRange[1]})`);
  
  // 1. Para cada seed, busca artistas similares via Last.fm
  for (const seedTrack of seedTracks.slice(0, 4)) {
    const artistName = seedTrack.artists[0].name;
    
    try {
      // Last.fm: artist.getSimilar
      const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistName)}&api_key=${lastfmKey}&format=json&limit=30`;
      const res = await fetch(url);
      const data = await res.json();
      
      const similarArtists = (data.similarartists?.artist || [])
        .filter(a => parseFloat(a.match) > 0.4)
        .slice(0, 15);
      
      console.log(`${artistName} → Similares: ${similarArtists.length}`);
      
      // 2. Para CADA artista similar, verifica se tem presença na mesma era
      for (const simArtist of similarArtists) {
        try {
          // Busca no Spotify
          const searchData = await api.searchArtists(simArtist.name, { limit: 1 });
          const spotifyArtist = searchData.body.artists.items[0];
          
          if (!spotifyArtist) continue;
          
          // CRUCIAL: Pega top tracks do artista e verifica época de lançamento
          const topTracksData = await api.getArtistTopTracks(spotifyArtist.id, 'US');
          const topTracks = topTracksData.body.tracks;
          
          // Filtra tracks que foram lançadas na MESMA ERA
          const eraRelevantTracks = topTracks.filter(track => {
            const releaseDate = track.album?.release_date;
            if (!releaseDate) return false;
            
            const year = parseInt(releaseDate.substring(0, 4));
            
            // Verifica se está no range temporal + margem de 2 anos
            return year >= (timeRange[0] - 2) && year <= (timeRange[1] + 2);
          });
          
          // Se o artista tem pelo menos 2 hits na era, é relevante!
          if (eraRelevantTracks.length >= 2) {
            eraArtists.add({
              id: spotifyArtist.id,
              name: spotifyArtist.name,
              popularity: spotifyArtist.popularity,
              genres: spotifyArtist.genres,
              eraTracksCount: eraRelevantTracks.length,
              relevantTracks: eraRelevantTracks.map(t => ({
                id: t.id,
                name: t.name,
                year: parseInt(t.album.release_date.substring(0, 4))
              }))
            });
            
            console.log(`  ✓ ${spotifyArtist.name} é relevante (${eraRelevantTracks.length} tracks na era)`);
          }
          
          await delay(120);
        } catch (e) {
          console.warn(`Erro ao verificar ${simArtist.name}:`, e.message);
        }
      }
      
      await delay(200);
    } catch (e) {
      console.warn(`Erro Last.fm para ${artistName}:`, e.message);
    }
  }
  
  console.log(`✓ Artistas da mesma era encontrados: ${eraArtists.size}`);
  return Array.from(eraArtists);
};

// PARTE 3: Priorizar Tracks da Era Correta
const getTracksFromEraContext = async (eraArtist, culturalContext, playlistVibe, avgVibe, featuresAvailable, api) => {
  const { timeRange } = culturalContext;
  const tracks = [];
  
  // Prioriza tracks que o artista já tem mapeadas da era
  for (const relevantTrack of eraArtist.relevantTracks.slice(0, 3)) {
    try {
      // Pega dados completos da track
      const trackData = await api.getTrack(relevantTrack.id);
      const track = trackData.body;
      
      // Valida vibe
      if (featuresAvailable) {
        const featData = await api.getAudioFeaturesForTracks([track.id]);
        const feat = featData.body.audio_features[0];
        
        if (!feat || !isVibeMatch(feat, playlistVibe)) {
          continue; // Pula se vibe não bate
        }
        
        // Calcula similarity
        const simScore = calculateEnhancedVibeSimilarity(feat, avgVibe, playlistVibe);
        
        tracks.push({
          ...track,
          similarity: simScore,
          _circle: 2, // Artista da mesma era = círculo próximo
          _source: 'era-context',
          _eraYear: relevantTrack.year
        });
      } else {
        tracks.push({
          ...track,
          similarity: 85,
          _circle: 2,
          _source: 'era-context',
          _eraYear: relevantTrack.year
        });
      }
      
      await delay(100);
    } catch (e) {
      console.warn(`Erro ao buscar track ${relevantTrack.name}:`, e.message);
    }
  }
  
  return tracks;
};

// SOLUÇÃO 1: Exploração Multi-Nível de Artistas
const getLastfmSimilarArtists = async (artistName, lastfmApiKey) => {
  try {
    const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistName)}&api_key=${lastfmApiKey}&format=json&limit=20`;
    const res = await fetch(url);
    const data = await res.json();
    
    return (data.similarartists?.artist || [])
      .filter(a => parseFloat(a.match) > 0.5) // Alta similaridade
      .map(a => a.name);
  } catch (e) {
    console.warn(`Erro Last.fm similar artists:`, e.message);
    return [];
  }
};

// SOLUÇÃO 2: Deep Cuts em vez de Top Tracks
const getArtistDeepCuts = async (artistId, api, playlistVibe, avgVibe, featuresAvailable) => {
  try {
    // Pega TODOS os álbuns (incluindo singles)
    const albumsData = await api.getArtistAlbums(artistId, { 
      limit: 50, 
      include_groups: 'album,single' 
    });
    const albums = albumsData.body.items;
    
    // Pega tracks de álbuns aleatórios (não só os populares)
    const randomAlbums = albums
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    
    const deepCuts = [];
    
    for (const album of randomAlbums) {
      const tracksData = await api.getAlbumTracks(album.id, { limit: 20 });
      const tracks = tracksData.body.items;
      
      // Pega tracks do MEIO do álbum (não hits)
      const middleTracks = tracks.slice(
        Math.floor(tracks.length * 0.3), 
        Math.floor(tracks.length * 0.8)
      );
      
      for (const track of middleTracks) {
        // FILTRA por vibe antes de adicionar
        if (featuresAvailable) {
          const featData = await api.getAudioFeaturesForTracks([track.id]);
          const feat = featData.body.audio_features[0];
          
          if (feat && isVibeMatch(feat, playlistVibe)) {
            deepCuts.push({
              ...track,
              album: { images: album.images, release_date: album.release_date },
              artists: [{ id: artistId, name: album.artists[0].name }]
            });
          }
        } else {
          deepCuts.push({
            ...track,
            album: { images: album.images, release_date: album.release_date },
            artists: [{ id: artistId, name: album.artists?.[0]?.name || 'Unknown Artist' }]
          });
        }
        
        await delay(100);
      }
    }
    
    return deepCuts.slice(0, 5); // Máximo 5 por artista
    
  } catch (e) {
    console.warn(`Erro ao buscar deep cuts de ${artistId}:`, e.message);
    return [];
  }
};

app.post('/analyze', async (req, res) => {
  try {
    const api = createApiInstance(req);
    let { trackIds } = req.body;
    if (!trackIds || !trackIds.length) {
      return res.status(400).json({ error: 'Nenhuma música fornecida.' });
    }

    // NOVA LÓGICA: Remover duplicatas das seeds por ID/URI logo no início
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
    const meData = await api.getMe();
    console.log('Token válido. Usuário:', meData.body.display_name);

    console.log('Buscando seed tracks...');
    const seedTracksData = await api.getTracks(uniqueTrackIds);
    let seedTracks = seedTracksData.body.tracks.filter(t => t); // Filtra tracks inválidas
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

    // SOLUÇÃO 1: CHAME ISSO logo após obter topSeedGenres
    const artistNetwork = await exploreArtistNetworkViaLastfm(seedTracks, topSeedGenres, lastfmApiKey, api, 2);

    // Extraia artistas nicho para minerar:
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

    let avgVibe = null;
    let featuresAvailable = false;
    console.log('Inferindo vibe por metadados (sem audio features)...');

    const playlistVibe = await inferPlaylistVibeFromMetadata(seedTracks, topSeedGenres, topSeedDecades, lastfmApiKey);
    console.log('Vibe inferida (com mood emocional):', playlistVibe);

    // PARTE 1: CHAME logo após inferir playlistVibe:
    const culturalContext = detectCulturalEra(seedTracks, topSeedGenres, topSeedDecades);
    console.log('Contexto cultural detectado:', culturalContext);

    console.log('Obtendo top artists...');
    let topArtistIds = [];
    let useTopArtists = true;
    try {
      const topArtistsData = await api.getMyTopArtists({ limit: 5, time_range: 'medium_term' });
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
      
      const recsData = await api.getRecommendations(recsOptions);
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
    
    for (const track of recTracks) {
      let simScore = 85;
      let candFeatures = null;
      if (featuresAvailable) {
        try {
          const candFeaturesData = await api.getAudioFeaturesForTracks([track.id]);
          candFeatures = candFeaturesData.body.audio_features[0];
          if (candFeatures) {
            if (!isVibeMatch(candFeatures, playlistVibe)) {
              continue; // Pula se não match de vibe
            }
            simScore = calculateEnhancedVibeSimilarity(candFeatures, avgVibe, playlistVibe);
          }
        } catch (candErr) {
          if (candErr.statusCode !== 403 && candErr.statusCode !== 404) console.warn('Erro em features de candidato:', candErr.message);
        }
      } else if (lastfmApiKey) {
        try {
          if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) {
            continue;
          }
          simScore = 80; // Fallback para metadata match
        } catch (metaErr) {
          console.warn('Erro em vibe metadata:', metaErr.message);
        }
      }
      const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
      simScore = Math.min(100, Math.round(simScore * classification.weight));
      candidateTracks.push({ ...track, similarity: simScore, _circle: classification.circle, _source: 'spotify-rec' });
      uriSeen.add(track.uri);
      await delay(50);
    }

    // SOLUÇÃO 3: Fase NOVA após related artists: Last.fm User-Based Filtering
    console.log("Fase Last.fm: Minerando artistas similares por comportamento de usuário...");
    let lastfmUsed = false;
    const lastfmArtistCandidates = new Set();

    if (lastfmApiKey) {
      for (const seedTrack of seedTracks.slice(0, 3)) {
        const artistName = seedTrack.artists[0].name;
        const similar = await getLastfmSimilarArtists(artistName, lastfmApiKey);
        
        console.log(`${artistName} → Similar: ${similar.slice(0, 5).join(', ')}`);
        
        for (const simArtistName of similar.slice(0, 10)) {
          try {
            // Busca o artista no Spotify
            const searchData = await api.searchArtists(simArtistName, { limit: 1 });
            const artist = searchData.body.artists.items[0];
            
            if (artist && artist.popularity < 65) { // Foco em nicho
              lastfmArtistCandidates.add(artist.id);
            }
          } catch (e) {}
          
          await delay(100);
        }
      }

      console.log(`Artistas Last.fm identificados: ${lastfmArtistCandidates.size}`);

      // Minere deep cuts desses artistas também
      for (const lfArtistId of Array.from(lastfmArtistCandidates).slice(0, 8)) {
        const deepCuts = await getArtistDeepCuts(lfArtistId, api, playlistVibe, avgVibe, featuresAvailable);
        
        for (const track of deepCuts) {
          if (!uriSeen.has(track.uri) && candidateTracks.length < 50) {
            let simScore = 80;
            if (featuresAvailable) {
              const candFeaturesData = await api.getAudioFeaturesForTracks([track.id]);
              const candFeatures = candFeaturesData.body.audio_features[0];
              if (candFeatures) {
                simScore = calculateEnhancedVibeSimilarity(candFeatures, avgVibe, playlistVibe);
              }
            } else if (lastfmApiKey) {
              if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) {
                continue;
              }
              simScore = 75;
            }
            const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
            simScore = Math.min(100, Math.round(simScore * classification.weight));
            candidateTracks.push({ 
              ...track, 
              similarity: simScore, 
              _circle: classification.circle,
              _source: 'lastfm'
            });
            uriSeen.add(track.uri);
          }
        }
        await delay(200);
      }
      lastfmUsed = true;
    }

    // 4. Fallback aprimorado com Last.fm (track.getsimilar para vibe por track) + Deep Cuts para seeds
    console.log("Fase 2: Buscando similares via Last.fm tracks e deep cuts...");
    if (lastfmApiKey) {
      const lastfmPromises = seedTracks.slice(0, 3).map(async (seedTrack) => {
        try {
          const seedArtistId = seedTrack.artists[0].id;

          // SUBSTITUIÇÃO: Use deep cuts em vez de top tracks para seed artists
          const deepCuts = await getArtistDeepCuts(seedArtistId, api, playlistVibe, avgVibe, featuresAvailable);
          
          for (const track of deepCuts) {
            if (!uriSeen.has(track.uri) && candidateTracks.length < 50) {
              let simScore = 95;
              if (featuresAvailable) {
                const candFeaturesData = await api.getAudioFeaturesForTracks([track.id]);
                const candFeatures = candFeaturesData.body.audio_features[0];
                if (candFeatures) {
                  simScore = calculateEnhancedVibeSimilarity(candFeatures, avgVibe, playlistVibe);
                }
              } else if (lastfmApiKey) {
                if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) {
                  continue;
                }
                simScore = 90;
              }
              const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
              simScore = Math.min(100, Math.round(simScore * classification.weight));
              candidateTracks.push({ ...track, similarity: simScore, _circle: classification.circle, _source: 'deep-cut' });
              uriSeen.add(track.uri);
            }
          }

          const url = `http://ws.audioscrobbler.com/2.0/?method=track.getsimilar&artist=${encodeURIComponent(seedTrack.artists[0].name)}&track=${encodeURIComponent(seedTrack.name)}&api_key=${lastfmApiKey}&format=json&limit=10`;
          const lfRes = await fetch(url);
          if (lfRes.ok) {
            const data = await lfRes.json();
            const similarTracks = (data.similartracks?.track || []).filter(t => parseFloat(t.match) > 0.3).slice(0, 7);
            for (const simTrack of similarTracks) {
              try {
                const searchData = await api.searchTracks(`${simTrack.name} ${simTrack.artist.name}`, { limit: 1, market: 'US' });
                const matchTrack = searchData.body.tracks.items[0];
                if (matchTrack && !uriSeen.has(matchTrack.uri)) {
                  let similarityScore = Math.round(parseFloat(simTrack.match) * 100);
                  let candFeatures = null;
                  if (featuresAvailable) {
                    try {
                      const candFeaturesData = await api.getAudioFeaturesForTracks([matchTrack.id]);
                      candFeatures = candFeaturesData.body.audio_features[0];
                      if (candFeatures) {
                        if (!isVibeMatch(candFeatures, playlistVibe)) {
                          continue; // Pula se não match
                        }
                        const vibeSim = calculateEnhancedVibeSimilarity(candFeatures, avgVibe, playlistVibe);
                        similarityScore = Math.round(0.6 * vibeSim + 0.4 * similarityScore);
                      }
                    } catch (candErr) {
                      if (candErr.statusCode !== 403 && candErr.statusCode !== 404) console.warn('Erro em features de similar track:', candErr.message);
                    }
                  } else if (lastfmApiKey) {
                    if (!(await isVibeMatchByMetadata(matchTrack, playlistVibe, lastfmApiKey))) {
                      continue;
                    }
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
          await delay(100);
        } catch (error) {
          console.warn(`Aviso: Falha ao processar seed "${seedTrack.name}". Erro: ${error.message}`);
        }
      });

      await Promise.all(lastfmPromises);
      console.log(`Last.fm usado: ${lastfmUsed}. Total de candidatos: ${candidateTracks.length}`);
    }

    // SOLUÇÃO 2: Adicione deep cuts para niche artists
    console.log('Minerando deep cuts de artistas nicho...');
    for (const nicheId of nicheArtistIds.slice(0, 10)) {
      const deepCuts = await getArtistDeepCuts(nicheId, api, playlistVibe, avgVibe, featuresAvailable);
      
      for (const track of deepCuts) {
        if (!uriSeen.has(track.uri) && candidateTracks.length < 50) {
          let simScore = 75; // Base score para nicho
          
          if (featuresAvailable) {
            const candFeaturesData = await api.getAudioFeaturesForTracks([track.id]);
            const candFeatures = candFeaturesData.body.audio_features[0];
            if (candFeatures) {
              simScore = calculateEnhancedVibeSimilarity(candFeatures, avgVibe, playlistVibe);
            }
          } else if (lastfmApiKey) {
            if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) {
              continue;
            }
            simScore = 70;
          }
          
          const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
          simScore = Math.min(100, Math.round(simScore * classification.weight));
          candidateTracks.push({ 
            ...track, 
            similarity: simScore, 
            _circle: 3,
            _source: 'deep-cut'
          });
          uriSeen.add(track.uri);
        }
      }
      await delay(200);
    }

    if (candidateTracks.length < 10 && useTopArtists && topArtistIds.length > 0) {
      console.log('Adicionando deep cuts de top artists do usuário...');
      for (const artistId of topArtistIds.slice(0, 3)) {
        try {
          const deepCuts = await getArtistDeepCuts(artistId, api, playlistVibe, avgVibe, featuresAvailable);
          
          for (const track of deepCuts) {
            if (!uriSeen.has(track.uri) && candidateTracks.length < 50) {
              let simScore = 80;
              if (featuresAvailable) {
                const candFeaturesData = await api.getAudioFeaturesForTracks([track.id]);
                const candFeatures = candFeaturesData.body.audio_features[0];
                if (candFeatures) {
                  simScore = calculateEnhancedVibeSimilarity(candFeatures, avgVibe, playlistVibe);
                }
              } else if (lastfmApiKey) {
                if (!(await isVibeMatchByMetadata(track, playlistVibe, lastfmApiKey))) {
                  continue;
                }
                simScore = 75;
              }
              const classification = classifyCandidateByProximity(track, seedTracks, topArtistIds, relatedArtistSet);
              simScore = Math.min(100, Math.round(simScore * classification.weight));
              candidateTracks.push({ ...track, similarity: simScore, _circle: classification.circle, _source: 'deep-cut' });
              uriSeen.add(track.uri);
            }
          }
          await delay(200);
        } catch (userTopErr) {
          console.warn(`Erro em deep cuts de top artist ${artistId}:`, userTopErr.message);
        }
      }
    } else if (candidateTracks.length < 10 && !useTopArtists) {
      console.log('Pulando top tracks de user por mismatch de gênero. Considerando mais related artists.');
    }

    // PARTE 2: CHAME esta função em uma NOVA FASE, após obter playlistVibe:
    console.log("\n=== FASE: MINERAÇÃO DE CONTEXTO CULTURAL ===");
    const eraArtists = await getArtistsFromSameEra(
      seedTracks, 
      culturalContext, 
      lastfmApiKey, 
      api
    );

    // PARTE 3: USE esta função no loop de eraArtists:
    for (const eraArtist of eraArtists.slice(0, 15)) { // Processa top 15 artistas da era
      const eraTracks = await getTracksFromEraContext(
        eraArtist, 
        culturalContext, 
        playlistVibe, 
        avgVibe, 
        featuresAvailable, 
        api
      );
      
      eraTracks.forEach(track => {
        if (!uriSeen.has(track.uri)) {
          candidateTracks.push(track);
          uriSeen.add(track.uri);
        }
      });
      
      console.log(`  ${eraArtist.name}: ${eraTracks.length} tracks adicionadas`);
    }

    console.log('Removendo faixas duplicadas por nome...');
    const seenNames = new Set();
    const initialCount = candidateTracks.length;
    candidateTracks = candidateTracks.filter(track => {
      if (seenNames.has(track.name)) {
        console.log(`Duplicado removido: ${track.name} por ${track.artists.map(a => a.name).join(', ')}`);
        return false;
      }
      seenNames.add(track.name);
      return true;
    });
    console.log(`Deduplicação concluída: ${initialCount} → ${candidateTracks.length} tracks únicas.`);

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

    // PARTE 4: MODIFIQUE a seleção final para PRIORIZAR contexto de era:
    const finalSelection = [];

    // Separa por fonte
    const eraContextTracks = candidateTracks.filter(t => t._source === 'era-context');
    const circle1Tracks = candidateTracks.filter(t => t.circle === 1 && t._source !== 'era-context');
    const otherTracks = candidateTracks.filter(t => t._source !== 'era-context' && t.circle !== 1);

    console.log(`\nDistribuição de fontes:
      - Era Context: ${eraContextTracks.length}
      - Circle 1 (seeds diretos): ${circle1Tracks.length}
      - Outros: ${otherTracks.length}
    `);

    const targetSize = Math.min(50, 30 + seedTracks.length) - seedTracks.length;

    // Balanceamento priorizando ERA:
    // - 50% tracks de artistas da mesma era cultural
    // - 30% círculo 1 (artistas diretos das seeds)
    // - 20% outros (para diversidade)

    finalSelection.push(
      ...eraContextTracks
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, Math.floor(targetSize * 0.5)),
      
      ...circle1Tracks
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, Math.floor(targetSize * 0.3)),
      
      ...otherTracks
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, Math.floor(targetSize * 0.2))
    );

    // Shuffle para misturar
    finalSelection.sort(() => Math.random() - 0.5);

    const finalPlaylist = [
      ...seedTracks.map(t => ({ ...t, similarity: 100 })),
      ...finalSelection
    ].map(track => ({
      id: track.id, name: track.name, artist: (track.artists || []).map(a => a.name).join(', '),
      albumImages: track.album?.images || [], similarity: Math.round(track.similarity || 0), uri: track.uri
    }));

    const avgSimilarity = finalPlaylist.reduce((sum, t) => sum + t.similarity, 0) / finalPlaylist.length;
    const responseData = { 
      similarities: finalPlaylist, 
      avgSimilarity: Math.round(avgSimilarity),
      featuresAvailable,
      recommendationsAvailable: recTracks.length > 0,
      genreDistribution,
      decadeDistribution,
      inferredVibe: playlistVibe,
      culturalContext // Adicione ao response para frontend visualizar
    };

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

// Rota de teste para validar token isoladamente
app.post('/test-token', async (req, res) => {
  try {
    const api = createApiInstance(req);
    const meData = await api.getMe();
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
        const meData = await api.getMe();
        const playlistData = await api.createPlaylist(meData.body.id, playlistName, { public: false, description: 'Playlist gerada pelo Frequency Mixer' });
        await api.addTracksToPlaylist(playlistData.body.id, trackUris);
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

// Helper para chunk (getArtists aceita <=50 ids)
const chunkArray = (arr, size) => {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
};

const getArtistsGenres = async (artistIds = [], api) => {
  const genresMap = {};
  const uniqueIds = Array.from(new Set(artistIds.filter(Boolean)));
  const chunks = chunkArray(uniqueIds, 50);
  for (const chunk of chunks) {
    try {
      const data = await api.getArtists(chunk);
      (data.body.artists || []).forEach(a => {
        genresMap[a.id] = a.genres || [];
      });
    } catch (e) {
      console.warn('Erro ao obter artistas para gêneros:', e.message || e);
    }
    await delay(120);
  }
  return genresMap;
};

const decadeFromReleaseDate = (dateStr) => {
  if (!dateStr) return 'Unknown';
  const year = parseInt(dateStr.substring(0, 4));
  if (isNaN(year) || year < 0) return 'Unknown';
  const decade = Math.floor(year / 10) * 10;
  return `${decade}s`;
};