const express = require('express');
const cors = require('cors');
const SpotifyWebApi = require('spotify-web-api-node');
const { spawnSync } = require('child_process');
const path = require('path');
require('dotenv').config();

console.log("--- Verificando Credenciais do .env ---");
console.log(`CLIENT_ID Carregado: ${process.env.SPOTIFY_CLIENT_ID ? 'Sim' : 'Não'}`);
console.log(`CLIENT_SECRET Carregado: ${process.env.SPOTIFY_CLIENT_SECRET ? 'Sim' : 'Não'}`);
console.log("--------------------------------------");

const app = express();
const port = process.env.PORT || 5000;

// Configuração do CORS para permitir o cabeçalho de Autorização
const corsOptions = {
  origin: 'http://127.0.0.1:3000', 
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'], 
};
app.use(cors(corsOptions));
app.use(express.json());

// A instância global da API agora serve apenas como um molde com as credenciais
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: 'http://127.0.0.1:5000/callback',
});

app.get('/auth', (req, res) => {
  const scopes = [
    'user-read-private',
    'user-read-email',
    'playlist-modify-public',
    'playlist-modify-private',
    'user-top-read'
  ];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`http://127.0.0.1:3000/?error=auth_failed`);
  }
  if (!code) {
    return res.redirect(`http://127.0.0.1:3000/?error=no_code`);
  }
  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    const { access_token, refresh_token, expires_in } = data.body;
    console.log('Tokens obtidos! Redirecionando para o frontend.');
    res.redirect(`http://127.0.0.1:3000?access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${expires_in}`);
  } catch (err) {
    console.error('Erro ao obter tokens:', err.body || err);
    res.redirect(`http://127.0.0.1:3000/?error=token_fail`);
  }
});

// Helper para configurar o token em cada requisição
const setTokenOnApi = (req) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        throw new Error('Token de acesso não fornecido no cabeçalho Authorization.');
    }
    spotifyApi.setAccessToken(token);
};

app.post('/search', async (req, res) => {
  try {
    setTokenOnApi(req);
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const searchData = await spotifyApi.searchTracks(query, { limit: 1 });
    const track = searchData.body.tracks.items[0];
    if (!track) return res.status(404).json({ error: 'No track found' });

    res.json({
      id: track.id,
      name: track.name,
      artist: track.artists[0].name,
      albumImages: track.album.images,
      previewUrl: track.preview_url
    });
  } catch (err) {
    console.error('Erro na busca:', err.body || err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/search-suggestions', async (req, res) => {
  try {
    setTokenOnApi(req);
    const { query } = req.body;
    if (!query || query.trim().length < 2) {
      return res.json({ tracks: [] });
    }
    const searchData = await spotifyApi.searchTracks(query, { limit: 8 });
    const tracks = searchData.body.tracks.items.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      albumImages: track.album.images,
      previewUrl: track.preview_url
    }));
    res.json({ tracks });
  } catch (err) {
    console.error('Erro ao buscar sugestões:', err.body || err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/get-tracks', async (req, res) => {
  try {
    setTokenOnApi(req);
    const { trackIds } = req.body;
    if (!trackIds || trackIds.length === 0) {
      return res.status(400).json({ error: 'Track IDs required' });
    }
    const tracksData = await spotifyApi.getTracks(trackIds);
    const tracks = tracksData.body.tracks.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      albumImages: track.album.images,
    }));
    res.json({ tracks });
  } catch (err) {
    console.error('Erro ao buscar tracks:', err.body || err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/analyze', async (req, res) => {
  try {
    setTokenOnApi(req);

    const { trackIds } = req.body;
    if (!trackIds || trackIds.length === 0) {
      return res.status(400).json({ error: 'Nenhuma música fornecida.' });
    }

    const lastfmApiKey = process.env.LASTFM_API_KEY;
    if (!lastfmApiKey) {
      return res.status(400).json({ error: 'LASTFM_API_KEY não configurado' });
    }

    const playlistSize = Math.min(50, 30 + (trackIds.length * 5));
    const [meData, userTopData, seedTracksData] = await Promise.all([
      spotifyApi.getMe(),
      spotifyApi.getMyTopArtists({ time_range: 'medium_term', limit: 20 }),
      spotifyApi.getTracks(trackIds)
    ]);

    const userMarket = meData.body.country || 'US';
    const userTops = userTopData.body.items;
    const userAvgPop = userTops.reduce((sum, a) => sum + a.popularity, 0) / userTops.length || 50;
    const isUnderground = userAvgPop < 50;
    const popBias = isUnderground ? 1.15 : 0.85;
    
    const seedTracks = seedTracksData.body.tracks;
    
    const seedsByArtist = new Map();
    const artistCache = new Map();
    
    seedTracks.forEach(track => {
      const mainArtist = track.artists && track.artists[0];
      const key = (mainArtist && mainArtist.id) ? mainArtist.id : (mainArtist && mainArtist.name) ? `name:${mainArtist.name}` : `unknown:${track.id}`;
      if (!seedsByArtist.has(key)) seedsByArtist.set(key, []);
      seedsByArtist.get(key).push(track);
      if (mainArtist) {
        const cacheKey = (mainArtist.id) ? mainArtist.id : key;
        if (!artistCache.has(cacheKey)) artistCache.set(cacheKey, { id: mainArtist.id, name: mainArtist.name, popularity: mainArtist.popularity });
      }
    });
    
    const uniqueArtists = Array.from(artistCache.values());

    let mergedPlaylist = seedTracks.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      albumImages: track.album.images,
      similarity: 100,
      uri: track.uri,
      type: 'seed',
      source_artist: track.artists[0].name
    }));
    const seedUris = new Set(seedTracks.map(t => t.uri));
    const remainingSlots = playlistSize - seedTracks.length;
    
    const processArtist = async (artistObj) => {
      if (!artistObj || (!artistObj.id && !artistObj.name)) return [];
      if (!artistObj.id && artistObj.name) {
        try {
          const searchRes = await spotifyApi.searchArtists(artistObj.name, { limit: 1 });
          const found = searchRes.body.artists.items[0];
          if (found && found.id) {
            artistObj.id = found.id;
            artistObj.popularity = artistObj.popularity || found.popularity;
            artistObj.genres = found.genres || [];
          }
        } catch (e) {
          console.warn(`searchArtists failed for ${artistObj.name}:`, e && e.body ? JSON.stringify(e.body) : (e && e.message ? e.message : e));
        }
      } else if (artistObj.id && !artistObj.genres) {
        try {
          const artistData = await spotifyApi.getArtist(artistObj.id);
          artistObj.genres = artistData.body.genres || [];
        } catch (e) {
          console.warn(`Could not fetch full artist data for ${artistObj.name}`);
          artistObj.genres = artistObj.genres || [];
        }
      }

      const artistIdKey = artistObj.id || `name:${artistObj.name}`;
      const artistSeeds = seedsByArtist.get(artistIdKey) || [];
      const seedWeight = artistSeeds.length;
      let subTracks = [];
      const artistNameLower = (artistObj.name || '').toLowerCase();

      try {
        const searchQuery = `artist:"${artistObj.name}"`;
        const searchData = await spotifyApi.searchTracks(searchQuery, { limit: 30, market: userMarket });
        const artistTracks = searchData.body.tracks.items
          .filter(track =>
            track.artists.some(a => a.name.toLowerCase() === artistNameLower) &&
            !seedUris.has(track.uri)
          )
          .slice(0, 15);

        artistTracks.forEach(track => {
          subTracks.push({
            ...track,
            _artistGenres: artistObj.genres || [],
            similarity: 95 + Math.random() * 5,
            type: 'same_artist',
            weight: 100 * seedWeight,
            source_artist: artistObj.name
          });
        });

        let goodRelated = [];
        if (artistObj.id) {
          try {
            const relatedArtistsData = await spotifyApi.getArtistRelatedArtists(artistObj.id);
            goodRelated = relatedArtistsData.body.artists
              .filter(a => Math.abs((a.popularity || 50) - (artistObj.popularity || 50)) < 40)
              .slice(0, 5);
          } catch (e) {
            console.warn(`getArtistRelatedArtists failed for ${artistObj.name}. Erro completo:`, JSON.stringify(e, null, 2));
            goodRelated = [];
          }
        }
        
        const relatedPromises = goodRelated.map(async (relArtist) => {
          try {
            const recommendations = await spotifyApi.getRecommendations({
                seed_artists: [relArtist.id],
                limit: 3
            });
            const popSimilarity = 1 - (Math.abs(relArtist.popularity - artistObj.popularity) / 100);
            return recommendations.body.tracks
              .filter(track => !seedUris.has(track.uri))
              .map(track => ({
                ...track, 
                _artistGenres: relArtist.genres || [],
                similarity: Math.round(80 + (popSimilarity * 15)),
                type: 'fans_also_like',
                weight: 90 * seedWeight * popSimilarity, 
                source_artist: artistObj.name
              }));
          } catch { return []; }
        });
        
        const relatedResults = await Promise.all(relatedPromises);
        subTracks.push(...relatedResults.flat());

        let lastfmData = null;
        try {
          const lfRes = await fetch(`http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistObj.name)}&api_key=${lastfmApiKey}&format=json&limit=10`);
          if (lfRes.ok) lastfmData = await lfRes.json();
        } catch (e) {
          console.warn(`Last.fm fetch failed for ${artistObj.name}:`, e && e.message ? e.message : e);
        }
        const goodSimilars = (lastfmData?.similarartists?.artist || []).filter(s => parseFloat(s.match) > 0.15).slice(0, 5);
        
        const similarPromises = goodSimilars.map(async (sim) => {
            try {
                const spotifySearch = await spotifyApi.searchArtists(sim.name, { limit: 1 });
                const simSpotify = spotifySearch.body.artists.items[0];
                if (!simSpotify || !simSpotify.id) return [];
                if (Math.abs((simSpotify.popularity || 50) - (artistObj.popularity || 50)) > 40) return [];
                let simTracks = { body: { tracks: [] } };
                try {
                  simTracks = await spotifyApi.getArtistTopTracks(simSpotify.id, userMarket);
                } catch (e) {
                  console.warn(`getArtistTopTracks failed for ${sim.name} (${simSpotify.id}):`, e && e.body ? JSON.stringify(e.body) : (e && e.message ? e.message : e));
                  return [];
                }
                const match = parseFloat(sim.match || 0);
                const popSimilarity = 1 - (Math.abs((simSpotify.popularity || 50) - (artistObj.popularity || 50)) / 100);

                return simTracks.body.tracks
                  .filter(track => !seedUris.has(track.uri)).slice(0, 3)
                  .map(track => ({
                    ...track, 
                    _artistGenres: simSpotify.genres || [],
                    similarity: Math.round(match * popSimilarity * 90 * popBias), type: 'similar',
                    weight: match * popSimilarity * 100 * seedWeight, source_artist: artistObj.name
                  }));
            } catch { return []; }
        });
        
        const similarResults = await Promise.all(similarPromises);
        subTracks.push(...similarResults.flat());
        
      } catch (err) {
        console.warn(`Erro ao processar ${artistObj.name}: ${err && err.body ? JSON.stringify(err.body) : (err && err.message ? err.message : err)}`);
      }
      return subTracks;
    };

    let allSubTracks = (await Promise.all(uniqueArtists.map(processArtist))).flat();
    
    let seedFeatureList = [];
    let seedAvg = null;
    try {
      const seedFeatureKeys = ['danceability','energy','valence','tempo','acousticness','instrumentalness','liveness'];
      const seedIds = seedTracks.map(t => t.id).filter(Boolean);
      if (seedIds.length) {
        try {
          const seedFeatResp = await spotifyApi.getAudioFeaturesForTracks(seedIds);
          seedFeatureList = (seedFeatResp.body.audio_features || []).filter(Boolean);
        } catch (featErr) {
          console.warn('Erro ao buscar audio features das seeds. Erro completo:', JSON.stringify(featErr, null, 2));
        }
        if (seedFeatureList.length) {
          seedAvg = {};
          seedFeatureKeys.forEach(k => {
            seedAvg[k] = seedFeatureList.reduce((s, f) => s + (f[k] || 0), 0) / seedFeatureList.length;
          });
        }
      }

      if (seedAvg && seedFeatureList.length) {
        const candidateIds = Array.from(new Set(allSubTracks.map(t => t.id).filter(Boolean)));
        const candidateFeaturesMap = new Map();
        for (let i = 0; i < candidateIds.length; i += 100) {
          const batch = candidateIds.slice(i, i + 100);
          try {
            let resp = await spotifyApi.getAudioFeaturesForTracks(batch);
            (resp.body.audio_features || []).forEach(f => { if (f && f.id) candidateFeaturesMap.set(f.id, f); });
          } catch (outerErr) {
            console.warn('Erro inesperado ao processar batch de audio-features:', outerErr && outerErr.message ? outerErr.message : outerErr);
          }
        }

        const SIM_THRESHOLD = parseInt(process.env.SIM_THRESHOLD || '50', 10);
        const VARIANCE = parseFloat(process.env.PLAYLIST_VARIANCE || '0.08');
        const CRITICAL_DIFF = parseFloat(process.env.CRITICAL_DIFF || '0.65');

        allSubTracks = allSubTracks.map(track => {
          const f = candidateFeaturesMap.get(track.id);
          if (!f) {
            track._featureComputed = false;
            track.similarity = Math.min(track.similarity || 40, 50);
            track.weight = (track.weight || 40) * 0.7;
            return track;
          }

          const sims = seedFeatureList.map(sf => featureDistance(sf, f));
          const avgSim = Math.round(sims.reduce((s, x) => s + x, 0) / sims.length);

          let penalty = 0;
          if ((f.instrumentalness || 0) > 0.6 && (seedAvg.instrumentalness || 0) < 0.3) penalty += 35;
          if ((seedAvg.instrumentalness || 0) > 0.6 && (f.instrumentalness || 0) < 0.3) penalty += 20;
          const jitter = Math.round((Math.random() - 0.5) * 2 * VARIANCE * 100);
          let sim = Math.round(avgSim * 0.92 + (track.similarity || 0) * 0.08) - penalty + jitter;
          sim = Math.max(0, Math.min(100, sim));

          const baseWeight = (track.weight || 50);
          const weightJitter = (Math.random() - 0.5) * 8 * VARIANCE;
          let weight = baseWeight * (1 + sim / 100) * (1 + weightJitter);
          weight = Math.max(1, Math.round(weight));

          track.similarity = sim;
          track.weight = weight;
          track._featureComputed = true;
          track._featObj = f;
          return track;
        }).filter(track => {
          if (track.type === 'same_artist') return true;
          if (!track._featureComputed) return false;

          const f = track._featObj;
          const dEnergy = Math.abs((seedAvg.energy || 0) - (f.energy || 0));
          const dDance = Math.abs((seedAvg.danceability || 0) - (f.danceability || 0));
          const dValence = Math.abs((seedAvg.valence || 0) - (f.valence || 0));
          if (dEnergy > CRITICAL_DIFF || dDance > CRITICAL_DIFF || dValence > CRITICAL_DIFF) return false;
          
          return track.similarity >= SIM_THRESHOLD;
        });
      }
    } catch (e) {
      console.warn('Audio-filter falhou:', e && e.body ? JSON.stringify(e.body) : (e && e.message ? e.message : e));
    }
    
    try {
      if (Array.isArray(allSubTracks) && allSubTracks.length) {
        const seedDescriptors = (seedTracks || []).map((t, idx) => {
          const f = (seedFeatureList && seedFeatureList[idx]) || {};
          return trackDescriptorForEmbedding(t, f);
        });
        const candidateDescriptors = allSubTracks.map(t => trackDescriptorForEmbedding(t, t._featObj || {}));

        const toEmbed = [];
        const descSet = new Set();
        seedDescriptors.concat(candidateDescriptors).forEach(d => {
          if (!d) return;
          if (!_embCache.has(d) && !descSet.has(d)) { descSet.add(d); toEmbed.push(d); }
        });

        if (toEmbed.length) {
          const newEmb = getLocalEmbeddings(toEmbed);
          toEmbed.forEach((d, i) => { if (newEmb[i]) _embCache.set(d, newEmb[i]); });
        }

        const seedEmb = seedDescriptors.map(d => _embCache.get(d) || null);
        const candEmb = candidateDescriptors.map(d => _embCache.get(d) || null);

        let semanticApplied = 0;
        if (seedEmb.filter(Boolean).length && candEmb.length) {
          allSubTracks.forEach((track, i) => {
            const emb = candEmb[i];
            if (!emb) return;
            const sims = seedEmb.filter(Boolean).map(se => Math.max(0, cosineVec(se, emb)));
            if (!sims.length) return;
            const avgSim = sims.reduce((s, x) => s + x, 0) / sims.length;
            const semanticScore = Math.round(avgSim * 100);
            const oldSim = track.similarity || 70;
            const finalSimilarity = Math.round(semanticScore * 0.85 + oldSim * 0.15);
            track.similarity = finalSimilarity;
            track.weight = Math.max(1, Math.round((track.weight || 50) * (1 + avgSim)));
            semanticApplied++;
          });
        }
        console.log(`Semantic re-rank: processed ${semanticApplied} candidates with local embeddings`);
      }
    } catch (e) {
      console.warn('Semantic re-rank failed (inside analyze):', e && e.message ? e.message : e);
    }
    
    const uriSeen = new Set(seedUris);
    let finalSelection = [];

    const candidatesByType = { same_artist: [], fans_also_like: [], similar: [], recommendation: [] };
    allSubTracks.forEach(track => {
      const type = track.type || 'recommendation';
      if (candidatesByType[type]) {
        candidatesByType[type].push(track);
      }
    });
    
    for (const type in candidatesByType) {
      candidatesByType[type].sort((a, b) => b.weight - a.weight);
    }

    const quota = {
      fans_also_like: Math.ceil(remainingSlots * 0.40),
      similar: Math.ceil(remainingSlots * 0.25),
      same_artist: Math.ceil(remainingSlots * 0.20),
      recommendation: Math.ceil(remainingSlots * 0.25)
    };
    
    const typesInOrder = ['fans_also_like', 'similar', 'recommendation', 'same_artist'];
    for (const type of typesInOrder) {
      const amountToTake = quota[type];
      const candidates = candidatesByType[type];
      let taken = 0;
      
      for (const track of candidates) {
        if (taken >= amountToTake || finalSelection.length >= remainingSlots) break;
        if (!uriSeen.has(track.uri)) {
          uriSeen.add(track.uri);
          finalSelection.push(track);
          taken++;
        }
      }
    }
    
    if (finalSelection.length < remainingSlots) {
      const allRemainingCandidates = typesInOrder.flatMap(type => candidatesByType[type])
        .sort((a, b) => b.weight - a.weight);

      for (const track of allRemainingCandidates) {
        if (finalSelection.length >= remainingSlots) break;
        if (!uriSeen.has(track.uri)) {
          uriSeen.add(track.uri);
          finalSelection.push(track);
        }
      }
    }
    
    finalSelection.forEach(track => {
        mergedPlaylist.push({
            id: track.id,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            albumImages: track.album.images,
            similarity: track.similarity,
            uri: track.uri,
            type: track.type,
            source_artist: track.source_artist
        });
    });

    mergedPlaylist.sort((a, b) => {
      if (a.type === 'seed') return -1;
      if (b.type === 'seed') return 1;
      return (b.similarity || 0) - (a.similarity || 0);
    });

    if (mergedPlaylist.length > playlistSize) {
      mergedPlaylist = mergedPlaylist.slice(0, playlistSize);
    }

    res.json({ similarities: mergedPlaylist, stats: {} });

  } catch (err) {
    console.error('\n❌ ERRO em /analyze:', err.body || err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/export-playlist', async (req, res) => {
  try {
    setTokenOnApi(req);
    const { playlistName, trackUris } = req.body;

    if (!playlistName || !trackUris || trackUris.length === 0) {
      return res.status(400).json({ error: 'Nome e músicas são obrigatórios.' });
    }

    const meData = await spotifyApi.getMe();
    const userId = meData.body.id;

    const playlistData = await spotifyApi.createPlaylist(userId, playlistName, {
      description: 'Playlist gerada pelo Playlist Maker - Frequency Mixer',
      public: false,
    });
    const playlistId = playlistData.body.id;
    await spotifyApi.addTracksToPlaylist(playlistId, trackUris);

    res.json({
      success: true,
      playlistId: playlistId,
      playlistUrl: playlistData.body.external_urls.spotify,
    });
  } catch (err) {
    console.error('Erro ao exportar playlist:', err.body || err);
    res.status(500).json({ error: err.message });
  }
});

// ROTA PARA RENOVAR O ACCESS TOKEN
app.post('/refresh_token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token é necessário.' });
  }

  try {
    const tempSpotifyApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      refreshToken: refreshToken,
    });

    const data = await tempSpotifyApi.refreshAccessToken();
    console.log("Token renovado com sucesso via /refresh_token!");

    res.json({
      accessToken: data.body['access_token'],
      expiresIn: data.body['expires_in'],
    });

  } catch (err) {
    console.error('Erro ao renovar token na rota /refresh_token:', err.body || err);
    res.status(403).json({ error: 'Falha ao renovar token.', details: err.body });
  }
});

// Funções Utilitárias (permanecem no final)

function featureDistance(fA, fB, weights = {}) {
  const defaults = {danceability:1, energy:1, valence:1, tempo:0.3, acousticness:0.8, instrumentalness:0.8, liveness:0.5};
  const w = {...defaults, ...weights};
  const keys = Object.keys(w);
  let sum = 0;
  keys.forEach(k => {
    const a = (fA[k] == null ? 0 : fA[k]);
    const b = (fB[k] == null ? 0 : fB[k]);
    const va = k === 'tempo' ? a / 200 : a;
    const vb = k === 'tempo' ? b / 200 : b;
    const diff = va - vb;
    sum += w[k] * diff * diff;
  });
  const dist = Math.sqrt(sum);
  const sim = Math.max(0, Math.round(100 * (1 - (dist / Math.sqrt(keys.length * 1.0)))));
  return sim;
}

const _embCache = new Map();
function getLocalEmbeddings(texts = []) {
  try {
    const py = path.join(__dirname, 'embedder.py');
    const proc = spawnSync('python', [py], {
      input: JSON.stringify({ texts }),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    });
    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
      const errOut = proc.stderr || proc.stdout;
      throw new Error(`embedder failed (status ${proc.status}): ${errOut}`);
    }
    const out = proc.stdout && proc.stdout.trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    if (parsed.error) throw new Error(parsed.error);
    return parsed.embeddings || [];
  } catch (e) {
    console.warn('getLocalEmbeddings failed:', e && e.message ? e.message : e);
    return [];
  }
}

function cosineVec(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let da = 0, db = 0, dot = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; da += a[i] * a[i]; db += b[i] * b[i]; }
  if (da === 0 || db === 0) return 0;
  return dot / (Math.sqrt(da) * Math.sqrt(db));
}

function trackDescriptorForEmbedding(track, featObj) {
    const artist = (track.artists || []).map(a => a.name).join(', ');
    const genres = (track._artistGenres || []).slice(0, 3);
    const f = featObj || {};
    let description = `${track.name} por ${artist}.`;
    if (genres.length > 0) {
        description += ` Um som do gênero ${genres.join(', ')}.`;
    }
    const vibeParts = [];
    if (f.energy > 0.75) vibeParts.push("muito energética");
    else if (f.energy > 0.5) vibeParts.push("energética");
    else if (f.energy < 0.3) vibeParts.push("calma e relaxante");
    if (f.danceability > 0.75) vibeParts.push("muito dançante");
    else if (f.danceability > 0.6) vibeParts.push("dançante");
    if (f.valence > 0.7) vibeParts.push("positiva e feliz");
    else if (f.valence > 0.5) vibeParts.push("otimista");
    else if (f.valence < 0.3) vibeParts.push("melancólica ou sombria");
    if (f.acousticness > 0.7) vibeParts.push("acústica");
    if (f.instrumentalness > 0.6) vibeParts.push("instrumental");
    if (vibeParts.length > 0) {
        description += ` É uma música ${vibeParts.join(', ')}.`;
    }
    return description;
}

app.listen(port, () => {
  console.log(` Backend rodando em http://127.0.0.1:${port}`);
});