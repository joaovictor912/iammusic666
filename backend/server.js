const express = require('express');
const cors = require('cors');
const SpotifyWebApi = require('spotify-web-api-node');
const { spawnSync } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

const corsOptions = {
  origin: 'http://127.0.0.1:3000',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json());

// Helper para criar uma instância da API para cada requisição
const createApiInstance = (req) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('Token de acesso não fornecido.');
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
  const scopes = ['user-read-private', 'user-read-email', 'playlist-modify-public', 'playlist-modify-private'];
  const authorizeURL = authApi.createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
});

app.get('/callback', async (req, res) => {
  try {
    const data = await authApi.authorizationCodeGrant(req.query.code);
    const { access_token, refresh_token, expires_in } = data.body;
    res.redirect(`http://127.0.0.1:3000?access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${expires_in}`);
  } catch (err) {
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
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

app.post('/search-suggestions', async (req, res) => {
  try {
    const api = createApiInstance(req);
    const { query } = req.body;
    const searchData = await api.searchTracks(query, { limit: 8 });
    const tracks = searchData.body.tracks.items.map(track => ({ id: track.id, name: track.name, artist: track.artists.map(a => a.name).join(', '), albumImages: track.album.images, previewUrl: track.preview_url }));
    res.json({ tracks });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

// FUNÇÃO HELPER para buscar tags na Last.fm
async function getTrackTags(trackName, artistName) {
    const lastfmApiKey = process.env.LASTFM_API_KEY;
    if (!lastfmApiKey) return [];
    try {
        const url = `http://ws.audioscrobbler.com/2.0/?method=track.gettoptags&artist=${encodeURIComponent(artistName)}&track=${encodeURIComponent(trackName)}&api_key=${lastfmApiKey}&format=json`;
        const lfRes = await fetch(url);
        if (!lfRes.ok) return [];
        const data = await lfRes.json();
        return (data.toptags?.tag || []).map(t => t.name).slice(0, 5); // Pega as 5 tags principais
    } catch (e) {
        console.warn(`Last.fm getTrackTags falhou para ${trackName}:`, e.message);
        return [];
    }
}

app.post('/analyze', async (req, res) => {
  try {
    const api = createApiInstance(req);
    const { trackIds } = req.body;
    if (!trackIds || !trackIds.length) return res.status(400).json({ error: 'Nenhuma música fornecida.' });

    console.log("Fase 1: Buscando dados das músicas semente...");
    const seedTracksData = await api.getTracks(trackIds);
    const seedTracks = seedTracksData.body.tracks;
    
    // Enriquecer sementes com tags
    for (const track of seedTracks) {
        track._tags = await getTrackTags(track.name, track.artists[0].name);
    }
    
    let candidateTracks = [];
    const uriSeen = new Set(seedTracks.map(t => t.uri));

    console.log("Fase 2: Buscando artistas similares e suas músicas...");
    const uniqueArtistNames = [...new Set(seedTracks.map(t => t.artists[0].name))];
    const lastfmApiKey = process.env.LASTFM_API_KEY;

    for (const artistName of uniqueArtistNames) {
        // Fonte 1: Mais músicas do mesmo artista
        const topTracksData = await api.getArtistTopTracks(seedTracks.find(t => t.artists[0].name === artistName).artists[0].id, 'US');
        topTracksData.body.tracks.slice(0, 5).forEach(track => {
            if (!uriSeen.has(track.uri)) {
                candidateTracks.push(track);
                uriSeen.add(track.uri);
            }
        });
        
        // Fonte 2: Músicas de artistas similares via Last.fm
        const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&artist=${encodeURIComponent(artistName)}&api_key=${lastfmApiKey}&format=json&limit=10`;
        const lfRes = await fetch(url);
        if (lfRes.ok) {
            const data = await lfRes.json();
            const similarArtists = (data.similarartists?.artist || []).slice(0, 3); // Pega 3 artistas similares
            for (const simArtist of similarArtists) {
                const searchData = await api.searchTracks(`artist:"${simArtist.name}"`, { limit: 3, market: 'US' });
                searchData.body.tracks.items.forEach(track => {
                    if (!uriSeen.has(track.uri)) {
                        candidateTracks.push(track);
                        uriSeen.add(track.uri);
                    }
                });
            }
        }
    }
    console.log(`-> ${candidateTracks.length} candidatos encontrados.`);

    console.log("Fase 3: Ranqueando com a IA...");
    for (const track of candidateTracks) {
        track._tags = await getTrackTags(track.name, track.artists[0].name);
    }

    const descriptors = [...seedTracks, ...candidateTracks].map(trackDescriptorForEmbedding);
    const embeddings = getLocalEmbeddings(descriptors);

    const seedEmbeddings = embeddings.slice(0, seedTracks.length).filter(Boolean);
    const candidateEmbeddings = embeddings.slice(seedTracks.length);

    if (!seedEmbeddings.length) return res.status(500).json({ error: "Não foi possível analisar as músicas semente." });

    let rankedCandidates = [];
    candidateTracks.forEach((track, i) => {
        const emb = candidateEmbeddings[i];
        if (!emb) return;
        const sims = seedEmbeddings.map(se => cosineVec(se, emb));
        const avgSim = sims.reduce((s, x) => s + x, 0) / sims.length;
        rankedCandidates.push({ ...track, similarity: Math.round(avgSim * 100) });
    });

    rankedCandidates.sort((a, b) => b.similarity - a.similarity);

    const playlistSize = Math.min(50, 30 + seedTracks.length);
    const finalSelection = rankedCandidates.slice(0, playlistSize - seedTracks.length);

    const finalPlaylist = [...seedTracks.map(t => ({ ...t, similarity: 100 })), ...finalSelection].map(track => ({
        id: track.id, name: track.name, artist: (track.artists || []).map(a => a.name).join(', '),
        albumImages: track.album?.images || [], similarity: track.similarity, uri: track.uri
    }));

    res.json({ similarities: finalPlaylist });

  } catch (err) {
    console.error('❌ ERRO GERAL em /analyze:', err.body || err.message, err.stack);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/export-playlist', async (req, res) => { /* ...código sem alteração... */ });
app.post('/refresh_token', async (req, res) => { /* ...código sem alteração... */ });

// Funções Utilitárias
function trackDescriptorForEmbedding(track) {
  const artist = (track.artists || []).map(a => a.name).join(', ');
  const tags = (track._tags || []).join(', ');
  let desc = `${track.name} por ${artist}.`;
  if (tags) desc += ` Tags: ${tags}.`;
  return desc;
}
function getLocalEmbeddings(texts = []) { /* ...código sem alteração... */ }
function cosineVec(a, b) { /* ...código sem alteração... */ }

app.listen(port, () => { console.log(`Backend rodando em http://127.0.0.1:${port}`); });

// Adicione as funções completas que foram abreviadas
app.post('/export-playlist', async (req, res) => {
    try {
        const api = createApiInstance(req);
        const { playlistName, trackUris } = req.body;
        if (!playlistName || !trackUris || !trackUris.length) return res.status(400).json({ error: 'Nome e músicas são obrigatórios.' });
        const meData = await api.getMe();
        const playlistData = await api.createPlaylist(meData.body.id, playlistName, { public: false, description: 'Playlist gerada pelo Frequency Mixer' });
        await api.addTracksToPlaylist(playlistData.body.id, trackUris);
        res.json({ success: true, playlistUrl: playlistData.body.external_urls.spotify });
    } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
});

app.post('/refresh_token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token é necessário.' });
  const tempApi = new SpotifyWebApi({ clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET, refreshToken });
  try {
    const data = await tempApi.refreshAccessToken();
    res.json({ accessToken: data.body['access_token'], expiresIn: data.body['expires_in'] });
  } catch (err) { res.status(403).json({ error: 'Falha ao renovar token.', details: err.body }); }
});

function getLocalEmbeddings(texts = []) {
  try {
    const proc = spawnSync('python', [path.join(__dirname, 'embedder.py')], {
      input: JSON.stringify({ texts }),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    });
    if (proc.error) throw proc.error;
    if (proc.status !== 0) throw new Error(`embedder failed: ${proc.stderr}`);
    const parsed = JSON.parse(proc.stdout.trim());
    return parsed.embeddings || [];
  } catch (e) {
    console.warn('getLocalEmbeddings failed:', e.message);
    return [];
  }
}
function cosineVec(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag ? dot / mag : 0;
}