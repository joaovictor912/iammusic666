// ============================================
// ARQUIVO: server.js (Backend Node.js/Express)
// ============================================

const express = require('express');
const cors = require('cors');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: 'http://127.0.0.1:5000/callback',
});

// ========== AUTENTICAÇÃO ==========
app.get('/auth', (req, res) => {
  const scopes = [
    'user-read-private',
    'user-read-email',
    'playlist-modify-public',
    'playlist-modify-private',
    'user-top-read' // ADICIONADO: necessário para recommendations
  ];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes);
  console.log('Auth URL gerada:', authorizeURL);
  res.redirect(authorizeURL);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    console.error('Erro na autenticação:', error);
    return res.redirect('http://127.0.0.1:3000/?error=auth_failed');
  }
  if (!code) {
    return res.redirect('http://127.0.0.1:3000/?error=no_code');
  }

  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    const { access_token, refresh_token, expires_in } = data.body;

    spotifyApi.setAccessToken(access_token);
    spotifyApi.setRefreshToken(refresh_token);

    // NOVO: Renovar token automaticamente antes de expirar
    setTimeout(async () => {
      try {
        const refreshData = await spotifyApi.refreshAccessToken();
        spotifyApi.setAccessToken(refreshData.body.access_token);
        console.log('Token renovado automaticamente!');
      } catch (err) {
        console.error('Erro ao renovar token:', err);
      }
    }, (expires_in - 300) * 1000); // Renova 5 min antes de expirar

    console.log('Tokens obtidos com sucesso!');
    res.redirect('http://127.0.0.1:3000/?authorized=true');
  } catch (err) {
    console.error('Erro ao obter tokens:', err);
    res.redirect('http://127.0.0.1:3000/?error=token_fail');
  }
});

// ========== BUSCA DE MÚSICA ==========
app.post('/search', async (req, res) => {
  if (!spotifyApi.getAccessToken()) {
    return res.status(401).json({ error: 'Usuário não autenticado.' });
  }
  
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });
  
  try {
    const searchData = await spotifyApi.searchTracks(query, { limit: 1 });
    const track = searchData.body.tracks.items[0];
    
    if (!track) return res.status(404).json({ error: 'No track found' });
    
    res.json({
      id: track.id,
      name: track.name,
      artist: track.artists[0].name,
      cover: track.album.images[0]?.url || '',
      previewUrl: track.preview_url
    });
  } catch (err) {
    console.error('Erro na busca:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== BUSCAR SUGESTÕES (AUTOCOMPLETE) ==========
app.post('/search-suggestions', async (req, res) => {
  if (!spotifyApi.getAccessToken()) {
    return res.status(401).json({ error: 'Usuário não autenticado.' });
  }
  
  const { query } = req.body;
  if (!query || query.trim().length < 2) {
    return res.json({ tracks: [] });
  }
  
  try {
    const searchData = await spotifyApi.searchTracks(query, { limit: 8 });
    const tracks = searchData.body.tracks.items.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      cover: track.album.images[2]?.url || track.album.images[0]?.url || '',
      previewUrl: track.preview_url
    }));
    
    res.json({ tracks });
  } catch (err) {
    console.error('Erro ao buscar sugestões:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== BUSCAR DETALHES DE MÚLTIPLAS TRACKS ==========
app.post('/get-tracks', async (req, res) => {
  if (!spotifyApi.getAccessToken()) {
    return res.status(401).json({ error: 'Usuário não autenticado.' });
  }
  
  const { trackIds } = req.body;
  if (!trackIds || trackIds.length === 0) {
    return res.status(400).json({ error: 'Track IDs required' });
  }
  
  try {
    const tracksData = await spotifyApi.getTracks(trackIds);
    const tracks = tracksData.body.tracks.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      cover: track.album.images[2]?.url || track.album.images[0]?.url || '',
    }));
    
    res.json({ tracks });
  } catch (err) {
    console.error('Erro ao buscar tracks:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== GERAR PLAYLIST INTELIGENTE ==========
app.post('/analyze', async (req, res) => {
  if (!spotifyApi.getAccessToken()) {
    return res.status(401).json({ error: 'Usuário não autenticado.' });
  }

  const { trackIds } = req.body;
  
  if (!trackIds || trackIds.length === 0) {
    return res.status(400).json({ error: 'Nenhuma música fornecida.' });
  }

  const lastfmApiKey = process.env.LASTFM_API_KEY;
  if (!lastfmApiKey) {
    return res.status(400).json({ error: 'LASTFM_API_KEY não configurado em .env' });
  }

  try {
    console.log(`\n========================================`);
    console.log(`Analisando ${trackIds.length} músicas seed...`);
    console.log('Track IDs:', trackIds);

    const accessToken = spotifyApi.getAccessToken();
    console.log('\n🔑 Token Spotify (primeiros 20 chars):', accessToken.substring(0, 20) + '...');

    // 1. Buscar market e top artists do user pra bias relevância (market só pra user data)
    const meData = await spotifyApi.getMe();
    const userMarket = meData.body.country || 'US';
    const userTopData = await spotifyApi.getMyTopArtists({ time_range: 'medium_term', limit: 20 });
    const userTops = userTopData.body.items;
    const userAvgPop = userTops.reduce((sum, a) => sum + a.popularity, 0) / userTops.length;
    const isUnderground = userAvgPop < 50;
    const popBias = isUnderground ? 1.1 : 0.9;
    console.log(`Market user: ${userMarket} | User avg pop: ${Math.round(userAvgPop)} | Bias: ${isUnderground ? 'underground' : 'mainstream'}`);

    // 2. Buscar seeds e extrair artistas principais + FEATS
    const seedLimit = Math.min(trackIds.length, 5);
    const seedTracksData = await spotifyApi.getTracks(trackIds.slice(0, seedLimit));
    const seedTracks = seedTracksData.body.tracks;

    let allSeedArtists = new Map(); // id -> artistObj
    seedTracks.forEach(track => {
      track.artists.forEach(artist => {
        if (!allSeedArtists.has(artist.id)) allSeedArtists.set(artist.id, artist);
      });
    });
    const uniqueArtists = Array.from(allSeedArtists.values());
    console.log(`Artistas únicos + feats (${uniqueArtists.length}):`, uniqueArtists.map(a => a.name).join(', '));

    // 3. Adicionar SEEDS à playlist (com 100%)
    let mergedPlaylist = seedTracks.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      cover: track.album.images[0]?.url || '',
      similarity: 100,
      uri: track.uri,
      type: 'seed',
      source_artist: track.artists[0]?.name || 'Unknown'
    }));
    const seedUris = seedTracks.map(t => t.uri);

    // Coletar TODOS genres de todos artists (pra fallback global)
    let allArtistGenres = [];
    for (const artistObj of uniqueArtists) {
      try {
        const artistFull = await spotifyApi.getArtist(artistObj.id);
        const genres = artistFull.body.genres || [];
        allArtistGenres.push(...genres);
        await new Promise(resolve => setTimeout(resolve, 100)); // Delay leve
      } catch (err) {
        console.warn(`Erro genres ${artistObj.name}:`, err.message);
      }
    }
    allArtistGenres = [...new Set(allArtistGenres)].slice(0, 5); // Únicos, top 5
    console.log(`Gêneros coletados de todos artists: ${allArtistGenres.join(', ')}`);

    // 4. Por artista único: Sub-playlist (busca geral + filtro por nome artista)
    let allSubTracks = [];
    const seenArtists = new Set(uniqueArtists.map(a => a.name.toLowerCase()));

    for (const artistObj of uniqueArtists) {
      if (seenArtists.has(artistObj.name.toLowerCase())) continue;
      seenArtists.add(artistObj.name.toLowerCase());
      console.log(`\n--- Sub-playlist para ${artistObj.name} (pop: ${artistObj.popularity}) ---`);
      
      let subTracks = [];
      const seedArtistPop = artistObj.popularity;
      const artistNameLower = artistObj.name.toLowerCase();

      // Prioridade 1: Busca geral por nome + filtro por artista exato
      try {
        const searchData = await spotifyApi.searchTracks(artistObj.name, { limit: 50, type: 'track' }); // q=name, global
        const allItems = searchData.body.tracks.items;
        console.log(`  Search "${artistObj.name}" global: returned ${allItems.length} total items`);
        const artistTracks = allItems.filter(track => 
          track.artists.some(a => a.name.toLowerCase() === artistNameLower)
        ).slice(0, 25); // Filtro exato por nome artista
        let addedCount = 0;
        artistTracks.forEach(track => {
          if (!seedUris.includes(track.uri)) {
            const sim = 95 + Math.random() * 5;
            subTracks.push({
              ...track,
              similarity: Math.round(sim),
              type: 'same_or_feat',
              source_artist: artistObj.name,
              weight: sim,
              pop_range_match: 1
            });
            addedCount++;
          }
        });
        console.log(`  ✓ Added ${addedCount} tracks same/feat (filtered from ${artistTracks.length})`);
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        console.warn(`Erro search tracks ${artistObj.name}:`, err.message);
      }

      // Prioridade 2: Similars via Last.fm (threshold muito baixo, filtro pós-busca)
      try {
        const lastfmUrl = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistObj.name)}&api_key=${lastfmApiKey}&format=json&limit=30`;
        const lastfmRes = await fetch(lastfmUrl);
        console.log(`  Last.fm fetch for ${artistObj.name}: status ${lastfmRes.status}`);
        if (!lastfmRes.ok) throw new Error(`Last.fm HTTP ${lastfmRes.status}`);
        const lastfmData = await lastfmRes.json();
        const similars = lastfmData.similarartists?.artist || [];
        console.log(`  Last.fm returned ${similars.length} similars`);
        const goodSimilars = similars
          .filter(s => parseFloat(s.match) > 0.05)
          .filter(s => {
            const estPop = Math.round(seedArtistPop * (0.6 + parseFloat(s.match)));
            const popMatch = Math.abs(estPop - seedArtistPop) / 100 < 0.4;
            return popMatch && (!isUnderground || estPop < 75);
          })
          .slice(0, 15);
        
        console.log(`  Good similars (match>0.05, pop ±40%): ${goodSimilars.length}`);
        if (goodSimilars.length > 0) console.log(`  Ex: ${goodSimilars.slice(0,3).map(s => `${s.name} (${(s.match*100).toFixed(1)}%)`).join(', ')}`);

        let similarAdded = 0;
        for (const sim of goodSimilars) {
          try {
            const spotifySearch = await spotifyApi.searchArtists(sim.name, { limit: 1 });
            const simSpotify = spotifySearch.body.artists.items[0];
            if (simSpotify && simSpotify.popularity > 2) {
              const simSearchData = await spotifyApi.searchTracks(simSpotify.name, { limit: 30, type: 'track' }); // q=name similar
              const allSimItems = simSearchData.body.tracks.items;
              const simArtistNameLower = simSpotify.name.toLowerCase();
              const simTracks = allSimItems.filter(track => 
                track.artists.some(a => a.name.toLowerCase() === simArtistNameLower)
              ).slice(0, 12); // Filtro exato
              let simAdded = 0;
              simTracks.forEach(track => {
                if (!seedUris.includes(track.uri) && subTracks.length < 40) {
                  const match = parseFloat(sim.match);
                  const popSim = Math.abs(simSpotify.popularity - seedArtistPop) / 100;
                  const simWeight = (match * (1 - popSim) * 100 * popBias) * 1.25;
                  subTracks.push({
                    ...track,
                    similarity: Math.min(95, Math.max(55, Math.round(simWeight))),
                    type: 'similar',
                    source_artist: artistObj.name,
                    weight: simWeight,
                    match_lastfm: match,
                    pop_range_match: 1 - popSim
                  });
                  simAdded++;
                }
              });
              similarAdded += simAdded;
              console.log(`    Added ${simAdded} from ${sim.name} (filtered from ${simTracks.length})`);
            }
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (err) {
            console.warn(`    Erro similar ${sim.name}:`, err.message);
          }
        }
        console.log(`  Total similar added: ${similarAdded}`);
      } catch (err) {
        console.warn(`Erro Last.fm para ${artistObj.name}:`, err.message);
      }

      // Adicionar subTracks (overlap <0.9)
      const overlap = allSubTracks.filter(t => subTracks.some(s => s.uri === t.uri)).length / subTracks.length || 0;
      const addCount = overlap < 0.9 ? subTracks.length : Math.floor(subTracks.length * 0.7);
      allSubTracks.push(...subTracks.slice(0, addCount));
      console.log(`  Added to allSub: ${addCount} tracks (overlap ${Math.round(overlap*100)}%)`);

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Fallback global: Se <15 total, busca OR name + genres, filtro por similaridade (não exato)
    if (allSubTracks.length < 15) {
      console.log('  🔄 Fallback global: OR names + genres pra boost');
      let fallbackQuery = uniqueArtists.map(a => a.name).join(' OR ');
      if (allArtistGenres.length > 0) {
        fallbackQuery += ` OR ${allArtistGenres.join(' OR ')}`;
      }
      try {
        const broadSearch = await spotifyApi.searchTracks(fallbackQuery, { limit: 50, type: 'track' });
        const broadItems = broadSearch.body.tracks.items.length;
        console.log(`  Fallback query "${fallbackQuery}": returned ${broadItems} items`);
        // Filtro loose: tracks com artista similar ou genre match (não exato)
        broadSearch.body.tracks.items.slice(0, 25).forEach(track => {
          const hasRelatedArtist = track.artists.some(a => uniqueArtists.some(ua => a.name.toLowerCase().includes(ua.name.toLowerCase().slice(0,5)))); // Loose match
          if (hasRelatedArtist && !seedUris.includes(track.uri) && allSubTracks.length < 50) {
            allSubTracks.push({
              ...track,
              similarity: 70 + Math.random() * 20,
              type: 'fallback',
              source_artist: 'Global fallback',
              weight: 80
            });
          }
        });
        console.log(`  Fallback added ${allSubTracks.length - (allSubTracks.length - 25)} tracks (loose filter)`);
      } catch (err) {
        console.warn('Fallback error:', err.message);
      }
    }

    // 5. Mesclar: Dedup, sort, limite 30
    const uriSeen = new Set(seedUris);
    allSubTracks.forEach(track => {
      if (!uriSeen.has(track.uri) && mergedPlaylist.length < 30) {
        uriSeen.add(track.uri);
        mergedPlaylist.push({
          id: track.id,
          name: track.name,
          artist: track.artists.map(a => a.name).join(', '),
          cover: track.album.images[0]?.url || '',
          similarity: track.similarity,
          uri: track.uri,
          type: track.type,
          source_artist: track.source_artist
        });
      }
    });

    mergedPlaylist.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return Math.random() - 0.5;
    });

    console.log(`\n✅ Playlist: ${mergedPlaylist.length} músicas (seeds: ${seedTracks.length})`);
    console.log(`Distrib: Seed ${mergedPlaylist.filter(p => p.type === 'seed').length}, Same/Feat ${mergedPlaylist.filter(p => p.type === 'same_or_feat').length}, Similar ${mergedPlaylist.filter(p => p.type === 'similar').length}, Fallback ${mergedPlaylist.filter(p => p.type === 'fallback').length}`);
    console.log(`Média sim: ${Math.round(mergedPlaylist.reduce((sum, t) => sum + t.similarity, 0) / mergedPlaylist.length || 0)}% | Underground bias: ${isUnderground}`);
    console.log(`========================================\n`);

    res.json({
      similarities: mergedPlaylist,
      avgFeatures: null,
      method: 'filtered-search-boosted',
      userBias: isUnderground ? 'underground' : 'mainstream',
      totalArtists: uniqueArtists.length
    });

  } catch (err) {
    console.error('\n❌ ERRO NA ANÁLISE:', err.message);
    console.error('Stack:', err.stack);
    console.error('========================================\n');
    res.status(500).json({ error: err.message });
  }
});

// ========== EXPORTAR PLAYLIST PARA SPOTIFY ==========
app.post('/export-playlist', async (req, res) => {
  if (!spotifyApi.getAccessToken()) {
    return res.status(401).json({ error: 'Usuário não autenticado.' });
  }

  const { playlistName, trackUris } = req.body;

  if (!playlistName || !trackUris || trackUris.length === 0) {
    return res.status(400).json({ error: 'Nome e músicas são obrigatórios.' });
  }

  try {
    // 1. Pegar ID do usuário
    const meData = await spotifyApi.getMe();
    const userId = meData.body.id;

    // 2. Criar playlist no Spotify
    const playlistData = await spotifyApi.createPlaylist(userId, playlistName, {
      description: 'Playlist gerada pelo Playlist Maker - Frequency Mixer',
      public: false,
    });

    const playlistId = playlistData.body.id;

    // 3. Adicionar músicas à playlist
    await spotifyApi.addTracksToPlaylist(playlistId, trackUris);

    console.log(`Playlist "${playlistName}" criada com sucesso!`);

    res.json({
      success: true,
      playlistId: playlistId,
      playlistUrl: playlistData.body.external_urls.spotify,
    });

  } catch (err) {
    console.error('Erro ao exportar playlist:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== INICIAR SERVIDOR ==========
app.listen(port, () => {
  console.log(` Backend rodando em http://127.0.0.1:${port}`);
});