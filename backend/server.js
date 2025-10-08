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
  tokenExpirationEpoch: 0
});

async function refreshTokenIfNeeded() {
  const expirationTime = spotifyApi.tokenExpirationEpoch || 0;
  const currentTime = new Date().getTime() / 1000;
  const timeUntilExpiration = expirationTime - currentTime;

  if (timeUntilExpiration < 300) {
    console.log('Token prestes a expirar ou inválido, renovando agora...');
    try {
      const data = await spotifyApi.refreshAccessToken();
      const { access_token, expires_in } = data.body;
      spotifyApi.setAccessToken(access_token);
      spotifyApi.tokenExpirationEpoch = (new Date().getTime() / 1000) + expires_in;
      console.log('Token renovado com sucesso! Nova expiração:', new Date(spotifyApi.tokenExpirationEpoch * 1000));
    } catch (error) {
      console.error('Erro ao renovar o token:', error.message);
      throw new Error('Falha ao renovar o token de autenticação.');
    }
  } else {
    console.log(`Token ainda é válido por ${Math.round(timeUntilExpiration / 60)} minutos.`);
  }
}

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
    spotifyApi.setAccessToken(access_token);
    spotifyApi.setRefreshToken(refresh_token);
    spotifyApi.tokenExpirationEpoch = (new Date().getTime() / 1000) + expires_in;
    console.log('Tokens obtidos com sucesso!');
    res.redirect('http://127.0.0.1:3000/?authorized=true');
  } catch (err) {
    console.error('Erro ao obter tokens:', err);
    res.redirect(`http://127.0.0.1:3000/?error=token_fail`);
  }
});

app.post('/search', async (req, res) => {
  try {
    await refreshTokenIfNeeded();
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
    console.error('Erro na busca:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/search-suggestions', async (req, res) => {
  try {
    await refreshTokenIfNeeded();
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
    console.error('Erro ao buscar sugestões:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/get-tracks', async (req, res) => {
  try {
    await refreshTokenIfNeeded();
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
    console.error('Erro ao buscar tracks:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/analyze', async (req, res) => {
  try {
    await refreshTokenIfNeeded();

    if (!spotifyApi.getAccessToken()) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

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
      const mainArtist = track.artists[0];
      if (!seedsByArtist.has(mainArtist.id)) {
        seedsByArtist.set(mainArtist.id, []);
        artistCache.set(mainArtist.id, mainArtist);
      }
      seedsByArtist.get(mainArtist.id).push(track);
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
      const artistSeeds = seedsByArtist.get(artistObj.id) || [];
      const seedWeight = artistSeeds.length;
      let subTracks = [];
      const artistNameLower = artistObj.name.toLowerCase();
      
      try {
        const searchData = await spotifyApi.searchTracks(`artist:"${artistObj.name}"`, { limit: 30, market: userMarket });
        const artistTracks = searchData.body.tracks.items
          .filter(track => 
            track.artists.some(a => a.name.toLowerCase() === artistNameLower) &&
            !seedUris.has(track.uri)
          )
          .slice(0, 15);
        
        artistTracks.forEach(track => {
          subTracks.push({
            ...track, similarity: 95 + Math.random() * 5, type: 'same_artist',
            weight: 100 * seedWeight, source_artist: artistObj.name
          });
        });
        
        const relatedArtistsData = await spotifyApi.getArtistRelatedArtists(artistObj.id);
        const goodRelated = relatedArtistsData.body.artists
          .filter(a => Math.abs(a.popularity - artistObj.popularity) < 40)
          .slice(0, 5);
          
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
                similarity: Math.round(80 + (popSimilarity * 15)),
                type: 'fans_also_like',
                weight: 90 * seedWeight * popSimilarity, 
                source_artist: artistObj.name
              }));
          } catch { return []; }
        });
        
        const relatedResults = await Promise.all(relatedPromises);
        const relatedTracks = relatedResults.flat();
        subTracks.push(...relatedTracks);

        const lastfmPromise = fetch(
          `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistObj.name)}&api_key=${lastfmApiKey}&format=json&limit=10`,
          { signal: AbortSignal.timeout(3000) }
        ).then(res => res.ok ? res.json() : null).catch(() => null);
        
        const lastfmData = await lastfmPromise;
        const goodSimilars = (lastfmData?.similarartists?.artist || []).filter(s => parseFloat(s.match) > 0.15).slice(0, 5);
        
        const similarPromises = goodSimilars.map(async (sim) => {
            try {
                const spotifySearch = await spotifyApi.searchArtists(sim.name, { limit: 1 });
                const simSpotify = spotifySearch.body.artists.items[0];
                if (!simSpotify || Math.abs(simSpotify.popularity - artistObj.popularity) > 40) return [];
                
                const simTracks = await spotifyApi.getArtistTopTracks(simSpotify.id, userMarket);
                const match = parseFloat(sim.match);
                const popSimilarity = 1 - (Math.abs(simSpotify.popularity - artistObj.popularity) / 100);

                return simTracks.body.tracks
                  .filter(track => !seedUris.has(track.uri)).slice(0, 3)
                  .map(track => ({
                    ...track, similarity: Math.round(match * popSimilarity * 90 * popBias), type: 'similar',
                    weight: match * popSimilarity * 100 * seedWeight, source_artist: artistObj.name
                  }));
            } catch { return []; }
        });
        
        const similarResults = await Promise.all(similarPromises);
        const similarTracks = similarResults.flat();
        subTracks.push(...similarTracks);
        
      } catch (err) {
        console.warn(`Erro ao processar ${artistObj.name}: ${err.message}`);
      }
      return subTracks;
    };

    const allSubTracks = (await Promise.all(uniqueArtists.map(processArtist))).flat();
    
    const uriSeen = new Set(seedUris);
    const finalSelection = [];

    const candidatesByType = { same_artist: [], fans_also_like: [], similar: [] };
    allSubTracks.forEach(track => {
      if (candidatesByType[track.type]) {
        candidatesByType[track.type].push(track);
      }
    });

    for (const type in candidatesByType) {
      candidatesByType[type].sort((a, b) => b.weight - a.weight);
    }

    const quota = {
      fans_also_like: Math.ceil(remainingSlots * 0.40),
      similar: Math.ceil(remainingSlots * 0.30),
      same_artist: Math.ceil(remainingSlots * 0.30)
    };

    const typesInOrder = ['fans_also_like', 'similar', 'same_artist'];
    for (const type of typesInOrder) {
      const amountToTake = quota[type];
      const candidates = candidatesByType[type];
      let taken = 0;
      
      for (const track of candidates) {
        if (taken >= amountToTake) break;
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
      return b.similarity - a.similarity;
    });

    if (mergedPlaylist.length > playlistSize) {
        mergedPlaylist = mergedPlaylist.slice(0, playlistSize);
    }

    const stats = {
      total: mergedPlaylist.length,
      seeds: mergedPlaylist.filter(p => p.type === 'seed').length,
      same_artist: mergedPlaylist.filter(p => p.type === 'same_artist').length,
      fans_also_like: mergedPlaylist.filter(p => p.type === 'fans_also_like').length,
      similar: mergedPlaylist.filter(p => p.type === 'similar').length,
      avgSimilarity: Math.round(mergedPlaylist.reduce((sum, t) => sum + t.similarity, 0) / mergedPlaylist.length)
    };
    
    const bySource = new Map();
    mergedPlaylist.forEach(track => {
      const source = track.source_artist || 'Unknown';
      bySource.set(source, (bySource.get(source) || 0) + 1);
    });
    
    res.json({
      similarities: mergedPlaylist,
      method: 'quota-based-v4.2-recs',
      stats: { ...stats, distributionBySourceArtist: Object.fromEntries(bySource) }
    });

  } catch (err) {
    console.error('\n❌ ERRO:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/export-playlist', async (req, res) => {
  try {
    await refreshTokenIfNeeded();
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
    console.error('Erro ao exportar playlist:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(` Backend rodando em http://127.0.0.1:${port}`);
});