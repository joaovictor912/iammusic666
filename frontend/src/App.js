import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { motion, useMotionValue, useSpring } from 'framer-motion';

const TiltCard = ({ children, ...props }) => {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const mouseXSpring = useSpring(x, { stiffness: 300, damping: 30 });
  const mouseYSpring = useSpring(y, { stiffness: 300, damping: 30 });

  return (
    <motion.div
      style={{
        rotateX: mouseYSpring,
        rotateY: mouseXSpring,
        transformPerspective: 1000,
        transformStyle: 'preserve-3d',
        display: 'inline-block',
      }}
      {...props}
    >
      <div
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const width = rect.width;
          const height = rect.height;
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          const xPct = mouseX / width - 0.5;
          const yPct = mouseY / height - 0.5;
          x.set(xPct * 20); // Increased tilt for more visible effect
          y.set(yPct * 20);
        }}
        onMouseLeave={() => {
          x.set(0);
          y.set(0);
        }}
        style={{ display: 'inline-block' }}
      >
        {children}
      </div>
    </motion.div>
  );
};

const Home = () => {
  const [authorized, setAuthorized] = useState(false);
  const [seedTracks, setSeedTracks] = useState([]);
  const [showSeeds, setShowSeeds] = useState(false);
  const [playlist, setPlaylist] = useState([]);
  const [loading, setLoading] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [coverArtUrl, setCoverArtUrl] = useState('');
  const [trackName, setTrackName] = useState('');
  const [artistName, setArtistName] = useState('');
  const [previewUrl, setPreviewUrl] = useState(null);
  const [exporting, setExporting] = useState(false);
  
  // Novos estados para funcionalidades avançadas
  const [playlistAnalysis, setPlaylistAnalysis] = useState(null);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [trackRatings, setTrackRatings] = useState({});
  const [overallRating, setOverallRating] = useState(0);
  const [feedbackStats, setFeedbackStats] = useState(null);
  const [showQualityMetrics, setShowQualityMetrics] = useState(false);
  
  // Estados para gerenciar playlists salvas
  const [savedPlaylists, setSavedPlaylists] = useState([]);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [showSavedPlaylists, setShowSavedPlaylists] = useState(false);

  const audioRef = useRef(new Audio());
  const [volume, setVolume] = useState(0.5);
  const searchTimeoutRef = useRef(null);

  useEffect(() => {
    audioRef.current.pause();
    if (previewUrl) {
      audioRef.current.src = previewUrl;
      audioRef.current.volume = volume;
      audioRef.current.play().catch(e => console.error("Erro de autoplay:", e));
    }
    return () => { audioRef.current.pause(); };
  }, [previewUrl]);

  useEffect(() => {
    audioRef.current.volume = volume;
  }, [volume]);

  // Carregar estatísticas de feedback ao inicializar
  useEffect(() => {
    if (authorized) {
      fetchFeedbackStats();
      loadSavedPlaylists();
    }
  }, [authorized]);

  // Funções para gerenciar playlists salvas
  const loadSavedPlaylists = () => {
    try {
      const saved = localStorage.getItem('savedPlaylists');
      if (saved) {
        setSavedPlaylists(JSON.parse(saved));
      }
    } catch (err) {
      console.error('Erro ao carregar playlists salvas:', err);
    }
  };

  const savePlaylist = () => {
    if (!playlistName.trim()) {
      alert('Por favor, digite um nome para a playlist.');
      return;
    }

    const playlistData = {
      id: `playlist_${Date.now()}`,
      name: playlistName.trim(),
      tracks: playlist,
      analysis: playlistAnalysis,
      seedTracks: seedTracks,
      createdAt: new Date().toISOString(),
      trackRatings: trackRatings,
      overallRating: overallRating
    };

    const updatedPlaylists = [...savedPlaylists, playlistData];
    setSavedPlaylists(updatedPlaylists);
    
    try {
      localStorage.setItem('savedPlaylists', JSON.stringify(updatedPlaylists));
      alert(`Playlist "${playlistName}" salva com sucesso!`);
      setShowSaveModal(false);
      setPlaylistName('');
    } catch (err) {
      console.error('Erro ao salvar playlist:', err);
      alert('Erro ao salvar playlist. Tente novamente.');
    }
  };

  const loadPlaylist = (playlistData) => {
    setPlaylist(playlistData.tracks);
    setPlaylistAnalysis(playlistData.analysis);
    setSeedTracks(playlistData.seedTracks);
    setTrackRatings(playlistData.trackRatings || {});
    setOverallRating(playlistData.overallRating || 0);
    setShowSavedPlaylists(false);
    
    // Atualizar cover art com a primeira música
    if (playlistData.tracks.length > 0) {
      const firstTrack = playlistData.tracks[0];
      setCoverArtUrl(firstTrack.albumImages?.[0]?.url || '');
      setTrackName(firstTrack.name);
      setArtistName(firstTrack.artist);
    }
  };

  const deletePlaylist = (playlistId) => {
    const playlistToDelete = savedPlaylists.find(p => p.id === playlistId);
    if (playlistToDelete && window.confirm(`Tem certeza que deseja excluir a playlist "${playlistToDelete.name}"?`)) {
      const updatedPlaylists = savedPlaylists.filter(p => p.id !== playlistId);
      setSavedPlaylists(updatedPlaylists);
      
      try {
        localStorage.setItem('savedPlaylists', JSON.stringify(updatedPlaylists));
        alert('Playlist excluída com sucesso!');
      } catch (err) {
        console.error('Erro ao excluir playlist:', err);
        alert('Erro ao excluir playlist. Tente novamente.');
      }
    }
  };

  const resetPlaylist = () => {
    if (window.confirm('Tem certeza que deseja reiniciar? Isso irá limpar a playlist atual e as músicas seed.')) {
      setPlaylist([]);
      setPlaylistAnalysis(null);
      setSeedTracks([]);
      setTrackRatings({});
      setOverallRating(0);
      setCoverArtUrl('');
      setTrackName('');
      setArtistName('');
      setPreviewUrl(null);
      setShowQualityMetrics(false);
      setShowFeedbackModal(false);
      alert('Playlist reiniciada! Você pode começar uma nova.');
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const expiresIn = params.get('expires_in');

    if (accessToken) {
      localStorage.setItem('spotify_access_token', accessToken);
      if (refreshToken) localStorage.setItem('spotify_refresh_token', refreshToken);
      if (expiresIn) {
        const expiresAt = Date.now() + parseInt(expiresIn, 10) * 1000;
        localStorage.setItem('spotify_token_expires_at', String(expiresAt));
      }
      setAuthorized(true);
      window.history.replaceState({}, '', '/');
    } else {
      const existingToken = localStorage.getItem('spotify_access_token');
      const expiresAt = localStorage.getItem('spotify_token_expires_at');
      if (existingToken && expiresAt && Date.now() < parseInt(expiresAt, 10)) {
        setAuthorized(true);
      }
    }

    if (params.get('error')) {
      alert('Erro na autenticação: ' + params.get('error'));
      window.history.replaceState({}, '', '/');
    }
  }, []);

  const handleSpotifySetup = () => {
    window.location.href = 'http://127.0.0.1:5000/auth';
  };

  // Função "guardiã" que verifica e renova o token antes de usá-lo
  const getValidToken = async () => {
    let token = localStorage.getItem('spotify_access_token');
    const expiresAt = parseInt(localStorage.getItem('spotify_token_expires_at') || '0', 10);

    if (Date.now() > expiresAt - 60000) {
      console.log("Token expirado ou prestes a expirar, renovando...");
      const refreshToken = localStorage.getItem('spotify_refresh_token');

      try {
        const res = await fetch('http://127.0.0.1:5000/refresh_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });

        const data = await res.json();
        if (data.accessToken) {
          token = data.accessToken;
          const newExpiresAt = Date.now() + data.expiresIn * 1000;
          
          localStorage.setItem('spotify_access_token', token);
          localStorage.setItem('spotify_token_expires_at', String(newExpiresAt));
          console.log("Token renovado e salvo no localStorage!");
        } else {
          throw new Error('Não foi possível renovar o token.');
        }
      } catch (error) {
        console.error("Falha na renovação do token:", error);
        localStorage.clear();
        setAuthorized(false);
        return null;
      }
    }
    return token;
  };

  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputValue(value);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    if (value.trim().length > 2) {
      searchTimeoutRef.current = setTimeout(async () => {
        try {
          // CORREÇÃO: Usar a função guardiã para garantir um token válido
          const token = await getValidToken();
          if (!token) return;

          const res = await fetch('http://127.0.0.1:5000/search-suggestions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ query: value }),
          });
          
          const data = await res.json();
          setSuggestions(data.tracks || []);
          setShowSuggestions(true);
        } catch (err) {
          console.error('Erro ao buscar sugestões:', err);
        }
      }, 300);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const addTrackFromData = (trackData) => {
    if (!seedTracks.some(track => track.id === trackData.id)) {
      setSeedTracks([...seedTracks, trackData]); 
      setInputValue('');
      setSuggestions([]);
      setShowSuggestions(false);
      setCoverArtUrl(trackData.albumImages[0]?.url || ''); 
      setTrackName(trackData.name);
      setArtistName(trackData.artist);
      setPreviewUrl(trackData.previewUrl);
    } else {
      alert('Esta música já foi adicionada.');
    }
  };

  const addTrackId = async () => {
    const query = inputValue.trim();
    if (!query) return;
    setLoading(true);

    try {
      // CORREÇÃO: Usar a função guardiã para garantir um token válido
      const token = await getValidToken();
      if (!token) return;

      const res = await fetch('http://127.0.0.1:5000/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ query }),
      });
      
      const data = await res.json();
      
      if (data.id) {
        addTrackFromData(data);
      } else {
        alert('Nenhuma música encontrada para "' + query + '"');
      }
    } catch (err) {
      alert('Erro na busca: ' + err.message);
    }
    
    setLoading(false);
  };

  const selectSuggestion = (track) => {
    addTrackFromData(track);
  };

  const removeSeedTrack = (index) => {
    const newSeedTracks = seedTracks.filter((_, i) => i !== index);
    setSeedTracks(newSeedTracks);
  };

  const removeTrackFromPlaylist = (indexToRemove) => {
    setPlaylist(currentPlaylist => 
      currentPlaylist.filter((_, index) => index !== indexToRemove)
    );
  };

  const handleAnalyze = async () => {
    const trackIds = seedTracks.map(track => track.id);
    if (trackIds.length === 0) {
      alert('Adicione pelo menos uma música para gerar a playlist.');
      return;
    }
    setLoading(true);

    try {
      // CORREÇÃO: Usar a função guardiã para garantir um token válido
      const token = await getValidToken();
      if (!token) return;

      const res = await fetch('http://127.0.0.1:5000/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ trackIds }),
      });
      
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setPlaylist(data.similarities || []);
      setPlaylistAnalysis(data); // Salvar análise completa
      
      // Resetar ratings para nova playlist
      setTrackRatings({});
      setOverallRating(0);
    } catch (err) {
      alert('Erro na análise: ' + err.message);
    }
    
    setLoading(false);
  };

  // Função para enviar feedback
  const handleSubmitFeedback = async () => {
    if (Object.keys(trackRatings).length === 0 || overallRating === 0) {
      alert('Por favor, avalie pelo menos uma música e dê uma nota geral.');
      return;
    }

    try {
      const token = await getValidToken();
      if (!token) return;

      const res = await fetch('http://127.0.0.1:5000/playlist-feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          playlistId: `playlist_${Date.now()}`,
          trackRatings,
          overallRating,
          playlistContext: playlistAnalysis?.culturalContext || {}
        }),
      });

      const data = await res.json();
      if (data.success) {
        alert('Feedback enviado com sucesso! Obrigado por ajudar a melhorar o sistema.');
        setShowFeedbackModal(false);
        setTrackRatings({});
        setOverallRating(0);
        // Atualizar estatísticas
        await fetchFeedbackStats();
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      alert('Erro ao enviar feedback: ' + err.message);
    }
  };

  // Função para buscar estatísticas de feedback
  const fetchFeedbackStats = async () => {
    try {
      const res = await fetch('http://127.0.0.1:5000/feedback-stats');
      const data = await res.json();
      setFeedbackStats(data);
    } catch (err) {
      console.error('Erro ao buscar estatísticas:', err);
    }
  };

  // Função para avaliar uma música individual
  const rateTrack = (trackId, rating) => {
    setTrackRatings(prev => ({
      ...prev,
      [trackId]: rating
    }));
  };

  // Função para renderizar estrelas de rating
  const renderStars = (rating, onRatingChange, size = 'medium') => {
    const starSize = size === 'small' ? '12px' : '16px';
    return (
      <div style={{ display: 'flex', gap: '2px' }}>
        {[1, 2, 3, 4, 5].map(star => (
          <span
            key={star}
            onClick={() => onRatingChange(star)}
            style={{
              cursor: 'pointer',
              fontSize: starSize,
              color: star <= rating ? '#ffd700' : '#ddd',
              transition: 'color 0.2s'
            }}
          >
            ★
          </span>
        ))}
      </div>
    );
  };

  const handleExportToSpotify = async () => {
    if (playlist.length === 0) {
      alert('Nenhuma playlist para exportar.');
      return;
    }
    const playlistName = prompt('Nome da playlist:', 'My Mixed Playlist');
    if (!playlistName) return;
    setExporting(true);

    try {
      const trackUris = playlist.map(track => track.uri);
      
      // CORREÇÃO: Usar a função guardiã para garantir um token válido
      const token = await getValidToken();
      if (!token) return;
      
      const res = await fetch('http://127.0.0.1:5000/export-playlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ 
          playlistName, 
          trackUris 
        }),
      });
      
      const data = await res.json();
      
      if (data.success) {
        alert('Playlist criada com sucesso no Spotify!');
        window.open(data.playlistUrl, '_blank');
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      alert('Erro ao exportar: ' + err.message);
    }
    
    setExporting(false);
  };

  return (
    <div style={styles.fullscreenUi}>
      <header style={styles.ipodHeader}>
        <div style={styles.headerTitle}>
          {authorized ? 'Now Playing' : 'PLAYLIST MAKER'}
        </div>
        
        {authorized && (
          <div style={{
            ...styles.volumeControlContainer,
            ...(!previewUrl ? styles.volumeControlDisabled : {})
          }}>
            <svg style={styles.volumeIcon} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
              <path d="M5 17h-5v-10h5v10zm2-10v10l9 5v-20l-9 5zm11.008 2.093c.742.743 1.2 1.77 1.192 2.907-.008 1.137-.458 2.164-1.2 2.907l-1.414-1.414c.389-.39.624-.928.622-1.493-.002-.565-.24-1.102-.622-1.493l1.414-1.414zm3.555-3.556c1.488 1.488 2.404 3.518 2.402 5.663-.002 2.145-.92 4.175-2.402 5.663l-1.414-1.414c1.118-1.117 1.802-2.677 1.8-4.249-.002-1.572-.69-3.132-1.8-4.249l1.414-1.414z"/>
            </svg>
            <input 
              type="range" 
              min="0" 
              max="1" 
              step="0.01" 
              value={volume}
              onChange={e => setVolume(parseFloat(e.target.value))}
              style={styles.volumeSlider}
            />
          </div>
        )}
        
        <span style={styles.batteryIcon}>▮▮▮▯</span>
      </header>
      
      <main style={styles.ipodBody}>
        <div style={styles.artworkPanel}>
          <div style={{
            ...styles.artworkPanelBackground,
            backgroundImage: coverArtUrl ? `url(${coverArtUrl})` : 'none'
          }} />
          
          {!coverArtUrl ? (
            <div style={styles.artworkPlaceholder}>
              <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <div style={styles.placeholderText}>No Track Selected</div>
            </div>
          ) : (
            <div style={styles.artworkContainer}>
              <TiltCard style={styles.artworkDisplaySmall}>
                <img 
                  src={coverArtUrl} 
                  alt="Album Art" 
                  style={{ 
                    width: '100%', 
                    height: '100%', 
                    borderRadius: '8px',
                    objectFit: 'cover',
                    imageRendering: 'high-quality'
                  }} 
                />
              </TiltCard>
              <div style={styles.artworkInfo}>
                <p style={styles.trackName}>{trackName}</p>
                <p style={styles.artistName}>{artistName}</p>
              </div>
            </div>
          )}
        </div>

        <div style={styles.contentPanel}>
          {!authorized ? (
            <div style={styles.loginView}>
              <div style={styles.musicIcon}>
                <svg width="100" height="100" viewBox="0 0 24 24" fill="#007aff">
                  <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
              </div>
              <h2 style={styles.titleText}>PLAYLIST MAKER</h2>
              <p style={styles.subtitleText}>Frequency Mixer</p>
              <button onClick={handleSpotifySetup} style={styles.connectButton}>
                Connect to Spotify
              </button>
            </div>
          ) : (
            <div>
              <div style={{position: 'relative'}}>
                <input 
                  type="text" 
                  value={inputValue} 
                  onChange={handleInputChange}
                  onKeyPress={(e) => e.key === 'Enter' && addTrackId()}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                  placeholder="Search for a Track..." 
                  style={styles.ipodInput}
                />
                
                {showSuggestions && suggestions.length > 0 && (
                  <div style={styles.suggestionsDropdown}>
                    {suggestions.map((track, index) => (
                      <div 
                        key={index}
                        style={styles.suggestionItem}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSuggestion(track);
                        }}
                      >
                        <img 
                          src={track.albumImages?.[0]?.url || ''} 
                          alt={track.name} 
                          style={styles.seedCover}
                        />
                        <div style={styles.suggestionInfo}>
                          <div style={styles.suggestionName}>
                            {track.name}
                            {track.previewUrl && (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="#34c759" style={{ marginLeft: '8px', verticalAlign: 'middle' }}>
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            )}
                          </div>
                          <div style={styles.suggestionArtist}>{track.artist}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                
                <div style={styles.buttonGroup}>
                  <button 
                    onClick={addTrackId} 
                    style={styles.ipodButton} 
                    disabled={loading}
                  >
                    {loading ? 'Adding...' : 'Add Track'}
                  </button>
                  <button 
                    onClick={handleAnalyze} 
                    style={{
                      ...styles.ipodButton,
                      ...styles.mixButton,
                      ...(loading || seedTracks.length === 0 ? styles.buttonDisabled : {})
                    }} 
                    disabled={loading || seedTracks.length === 0}
                  >
                    {loading ? 'Mixing...' : 'Mix Playlist'}
                  </button>
                  <button 
                    onClick={resetPlaylist}
                    style={{
                      ...styles.ipodButton,
                      ...styles.resetButton,
                      ...(playlist.length === 0 && seedTracks.length === 0 ? styles.buttonDisabled : {})
                    }}
                    disabled={playlist.length === 0 && seedTracks.length === 0}
                  >
                    Reset
                  </button>
                </div>
                
                {/* Botão para ver playlists salvas */}
                {savedPlaylists.length > 0 && (
                  <div style={styles.savedPlaylistsSection}>
                    <button 
                      onClick={() => setShowSavedPlaylists(!showSavedPlaylists)}
                      style={{
                        ...styles.ipodButton,
                        ...styles.savedPlaylistsButton
                      }}
                    >
                      {showSavedPlaylists ? 'Hide Saved' : `Saved Playlists (${savedPlaylists.length})`}
                    </button>
                    
                    {showSavedPlaylists && (
                      <div style={styles.savedPlaylistsContainer}>
                        <h3 style={styles.savedPlaylistsTitle}>Playlists Salvas</h3>
                        <div style={styles.savedPlaylistsList}>
                          {savedPlaylists.map((savedPlaylist) => (
                            <div key={savedPlaylist.id} style={styles.savedPlaylistItem}>
                              <div style={styles.savedPlaylistInfo}>
                                <div style={styles.savedPlaylistName}>{savedPlaylist.name}</div>
                                <div style={styles.savedPlaylistMeta}>
                                  {savedPlaylist.tracks.length} tracks • {new Date(savedPlaylist.createdAt).toLocaleDateString()}
                                </div>
                              </div>
                              <div style={styles.savedPlaylistActions}>
                                <button 
                                  onClick={() => loadPlaylist(savedPlaylist)}
                                  style={styles.loadButton}
                                >
                                  Load
                                </button>
                                <button 
                                  onClick={() => deletePlaylist(savedPlaylist.id)}
                                  style={styles.deleteButton}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              
              {seedTracks.length > 0 && (
                <div>
                  <div 
                    style={styles.trackCounter}
                    onClick={() => setShowSeeds(!showSeeds)}
                  >
                    <span>{seedTracks.length} seed track{seedTracks.length !== 1 ? 's' : ''} added</span>
                    <svg 
                      width="12" 
                      height="12" 
                      viewBox="0 0 12 12" 
                      style={{
                        ...styles.arrowIcon,
                        transform: showSeeds ? 'rotate(180deg)' : 'rotate(0deg)'
                      }}
                    >
                      <path d="M6 9L1 4h10z" fill="currentColor"/>
                    </svg>
                  </div>
                  
                  {showSeeds && seedTracks.length > 0 && (
                    <ul style={styles.seedList}>
                      {seedTracks.map((track, index) => (
                        <li key={index} style={styles.seedListItem}>
                          <img 
                            src={track.albumImages[2]?.url || track.albumImages[0]?.url || ''}
                            alt={track.name} 
                            style={styles.seedCover}
                          />
                          <div style={styles.seedInfo}>
                            <div style={styles.seedName}>{track.name}</div>
                            <div style={styles.seedArtist}>{track.artist}</div>
                          </div>
                          <button
                            onClick={() => removeSeedTrack(index)}
                            style={styles.removeButton}
                            title="Remove track"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              
              {playlist.length > 0 && (
                <div>
                  <div style={styles.playlistHeaderContainer}>
                    <div style={styles.playlistHeader}>
                      Generated Playlist ({playlist.length} tracks)
                    </div>
                    <div style={styles.playlistActions}>
                      <button 
                        onClick={() => setShowQualityMetrics(!showQualityMetrics)}
                        style={{
                          ...styles.ipodButton,
                          ...styles.qualityButton
                        }}
                      >
                        {showQualityMetrics ? 'Hide Quality' : 'Show Quality'}
                      </button>
                      <button 
                        onClick={() => setShowFeedbackModal(true)}
                        style={{
                          ...styles.ipodButton,
                          ...styles.feedbackButton
                        }}
                      >
                        Rate Playlist
                      </button>
                      <button 
                        onClick={() => setShowSaveModal(true)}
                        style={{
                          ...styles.ipodButton,
                          ...styles.saveButton
                        }}
                      >
                        Save Playlist
                      </button>
                      <button 
                        onClick={handleExportToSpotify} 
                        style={{
                          ...styles.ipodButton,
                          ...styles.exportButton
                        }}
                        disabled={exporting}
                      >
                        {exporting ? 'Exporting...' : 'Export to Spotify'}
                      </button>
                    </div>
                  </div>

                  {/* Métricas de Qualidade */}
                  {showQualityMetrics && playlistAnalysis?.qualityValidation && (
                    <div style={styles.qualityMetricsContainer}>
                      <h3 style={styles.qualityTitle}>Playlist Quality Analysis</h3>
                      <div style={styles.qualityScore}>
                        Overall Score: <span style={styles.scoreValue}>{playlistAnalysis.qualityValidation.score}/100</span>
                      </div>
                      <div style={styles.metricsGrid}>
                        <div style={styles.metricItem}>
                          <div style={styles.metricLabel}>Coherence</div>
                          <div style={styles.metricValue}>{playlistAnalysis.qualityValidation.metrics.coherence}%</div>
                        </div>
                        <div style={styles.metricItem}>
                          <div style={styles.metricLabel}>Diversity</div>
                          <div style={styles.metricValue}>{playlistAnalysis.qualityValidation.metrics.diversity}%</div>
                        </div>
                        <div style={styles.metricItem}>
                          <div style={styles.metricLabel}>Flow</div>
                          <div style={styles.metricValue}>{playlistAnalysis.qualityValidation.metrics.flow}%</div>
                        </div>
                        <div style={styles.metricItem}>
                          <div style={styles.metricLabel}>Cultural Consistency</div>
                          <div style={styles.metricValue}>{playlistAnalysis.qualityValidation.metrics.culturalConsistency}%</div>
                        </div>
                      </div>
                      {playlistAnalysis.qualityValidation.recommendations.length > 0 && (
                        <div style={styles.recommendationsContainer}>
                          <h4 style={styles.recommendationsTitle}>Recommendations:</h4>
                          <ul style={styles.recommendationsList}>
                            {playlistAnalysis.qualityValidation.recommendations.map((rec, index) => (
                              <li key={index} style={styles.recommendationItem}>{rec}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Análise Cultural */}
                  {playlistAnalysis?.culturalContext && (
                    <div style={styles.culturalAnalysisContainer}>
                      <h3 style={styles.culturalTitle}>Cultural Analysis</h3>
                      <div style={styles.culturalInfo}>
                        <div style={styles.culturalItem}>
                          <strong>Era:</strong> {playlistAnalysis.culturalContext.culturalEra}
                        </div>
                        <div style={styles.culturalItem}>
                          <strong>Time Range:</strong> {playlistAnalysis.culturalContext.timeRange[0]} - {playlistAnalysis.culturalContext.timeRange[1]}
                        </div>
                        <div style={styles.culturalItem}>
                          <strong>Keywords:</strong> {playlistAnalysis.culturalContext.eraKeywords.join(', ')}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Vibe Analysis */}
                  {playlistAnalysis?.inferredVibe && (
                    <div style={styles.vibeAnalysisContainer}>
                      <h3 style={styles.vibeTitle}>Musical Vibe</h3>
                      <div style={styles.vibeInfo}>
                        <div style={styles.vibeItem}>
                          <strong>Mood:</strong> {playlistAnalysis.inferredVibe.mood}
                          {playlistAnalysis.inferredVibe.subMood && ` (${playlistAnalysis.inferredVibe.subMood})`}
                        </div>
                        <div style={styles.vibeItem}>
                          <strong>Description:</strong> {playlistAnalysis.inferredVibe.description}
                        </div>
                        <div style={styles.vibeItem}>
                          <strong>Confidence:</strong> {playlistAnalysis.inferredVibe.confidence}%
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <ul style={styles.ipodList}>
                    {playlist.map((track, index) => (
                      <li key={index} style={styles.ipodListItem}>
                        <div style={styles.trackInfoContainer}>
                          <img 
                            src={track.albumImages?.[0]?.url || ''} 
                            alt={track.name} 
                            style={styles.trackCover}
                          />
                          <div style={styles.trackDetails}>
                            <div style={styles.listItemName}>{track.name}</div>
                            <div style={styles.listItemArtist}>{track.artist}</div>
                            {track.similarity && (
                              <div style={styles.similarityBadge}>
                                {track.similarity}% match
                              </div>
                            )}
                          </div>
                        </div>
                        <div style={styles.trackActions}>
                          {showFeedbackModal && (
                            <div style={styles.trackRating}>
                              {renderStars(trackRatings[track.id] || 0, (rating) => rateTrack(track.id, rating), 'small')}
                            </div>
                          )}
                          <button
                            onClick={() => removeTrackFromPlaylist(index)}
                            style={styles.removeButton}
                            title="Remove track"
                          >
                            ✕
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Modal de Feedback */}
      {showFeedbackModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Rate This Playlist</h2>
              <button 
                onClick={() => setShowFeedbackModal(false)}
                style={styles.closeButton}
              >
                ✕
              </button>
            </div>
            
            <div style={styles.modalBody}>
              <div style={styles.overallRatingSection}>
                <h3 style={styles.ratingSectionTitle}>Overall Rating</h3>
                {renderStars(overallRating, setOverallRating)}
              </div>
              
              <div style={styles.trackRatingsSection}>
                <h3 style={styles.ratingSectionTitle}>Rate Individual Tracks</h3>
                <div style={styles.trackRatingsList}>
                  {playlist.slice(0, 10).map((track, index) => (
                    <div key={track.id} style={styles.trackRatingItem}>
                      <img 
                        src={track.albumImages?.[0]?.url || ''} 
                        alt={track.name} 
                        style={styles.ratingTrackCover}
                      />
                      <div style={styles.ratingTrackInfo}>
                        <div style={styles.ratingTrackName}>{track.name}</div>
                        <div style={styles.ratingTrackArtist}>{track.artist}</div>
                      </div>
                      {renderStars(trackRatings[track.id] || 0, (rating) => rateTrack(track.id, rating), 'small')}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            
            <div style={styles.modalFooter}>
              <button 
                onClick={() => setShowFeedbackModal(false)}
                style={styles.cancelButton}
              >
                Cancel
              </button>
              <button 
                onClick={handleSubmitFeedback}
                style={styles.submitButton}
              >
                Submit Feedback
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal para Salvar Playlist */}
      {showSaveModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Save Playlist</h2>
              <button 
                onClick={() => setShowSaveModal(false)}
                style={styles.closeButton}
              >
                ✕
              </button>
            </div>
            
            <div style={styles.modalBody}>
              <div style={styles.savePlaylistSection}>
                <label style={styles.inputLabel}>Playlist Name:</label>
                <input
                  type="text"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  placeholder="Enter playlist name..."
                  style={styles.playlistNameInput}
                  maxLength={50}
                />
                <div style={styles.playlistPreview}>
                  <div style={styles.previewTitle}>Preview:</div>
                  <div style={styles.previewInfo}>
                    <strong>{playlistName || 'Untitled Playlist'}</strong>
                    <div style={styles.previewMeta}>
                      {playlist.length} tracks • Created {new Date().toLocaleDateString()}
                    </div>
                    {playlistAnalysis?.culturalContext && (
                      <div style={styles.previewContext}>
                        Era: {playlistAnalysis.culturalContext.culturalEra} • 
                        Mood: {playlistAnalysis.inferredVibe?.mood || 'Unknown'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            
            <div style={styles.modalFooter}>
              <button 
                onClick={() => setShowSaveModal(false)}
                style={styles.cancelButton}
              >
                Cancel
              </button>
              <button 
                onClick={savePlaylist}
                style={styles.submitButton}
                disabled={!playlistName.trim()}
              >
                Save Playlist
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Estatísticas de Feedback */}
      {feedbackStats && (
        <div style={styles.feedbackStatsContainer}>
          <div style={styles.statsTitle}>System Statistics</div>
          <div style={styles.statsGrid}>
            <div style={styles.statItem}>
              <div style={styles.statValue}>{feedbackStats.totalFeedbacks || 0}</div>
              <div style={styles.statLabel}>Total Feedbacks</div>
            </div>
            <div style={styles.statItem}>
              <div style={styles.statValue}>{feedbackStats.trackRatings || 0}</div>
              <div style={styles.statLabel}>Track Ratings</div>
            </div>
            <div style={styles.statItem}>
              <div style={styles.statValue}>{feedbackStats.avgRating ? feedbackStats.avgRating.toFixed(1) : 'N/A'}</div>
              <div style={styles.statLabel}>Avg Rating</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const styles = {
  fullscreenUi: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100vh',
    backgroundColor: '#e8e8e8',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif',
    overflow: 'hidden',
  },
  ipodHeader: {
    background: 'linear-gradient(to bottom, #f0f0f2, #d8d8dc)',
    borderBottom: '1px solid #b8b8bc',
    padding: '8px 16px',
    fontWeight: '600',
    fontSize: '13px',
    letterSpacing: '0.3px',
    textShadow: '0 1px 0 rgba(255,255,255,0.8)',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '40px',
    gap: '15px',
  },
  headerTitle: {
    flexGrow: 1,
    textAlign: 'center',
    textTransform: 'uppercase',
    color: '#1a1a1a',
  },
  batteryIcon: {
    fontSize: '14px',
    color: '#666',
    letterSpacing: '-1px',
  },
  volumeControlContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  volumeIcon: {
    width: '18px',
    height: '18px',
    fill: '#666',
  },
  volumeSlider: {
    WebkitAppearance: 'none',
    appearance: 'none',
    width: '80px',
    height: '4px',
    background: '#c0c0c4',
    borderRadius: '2px',
    outline: 'none',
    cursor: 'pointer',
  },
  ipodBody: {
    display: 'flex',
    flexGrow: 1,
    height: 'calc(100vh - 40px)',
    overflow: 'hidden',
  },
  artworkPanel: {
    width: '40%',
    height: '100%',
    backgroundColor: '#fafafa',
    borderRight: '1px solid #d0d0d4',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '40px',
    position: 'relative',
    overflow: 'hidden',
  },
  artworkPanelBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    filter: 'blur(30px) brightness(0.7)',
    transform: 'scale(1.2)',
    transition: 'background-image 0.6s cubic-bezier(0.4, 0.0, 0.2, 1)',
    zIndex: 1,
  },
  artworkPlaceholder: {
    position: 'relative',
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '20px',
    opacity: 0.4,
  },
  placeholderText: {
    fontSize: '14px',
    color: '#999',
    fontWeight: '500',
  },
  artworkContainer: {
    position: 'relative',
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  artworkDisplaySmall: {
    width: '280px',
    height: '280px',
    maxWidth: '100%',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.2)',
    transition: 'transform 0.3s cubic-bezier(0.4, 0.0, 0.2, 1)',
    imageRendering: 'high-quality',
  },
  artworkInfo: {
    marginTop: '24px',
    textAlign: 'center',
    color: '#fff',
    textShadow: '0 2px 8px rgba(0,0,0,0.6)',
  },
  trackName: {
    fontSize: '20px',
    fontWeight: '600',
    margin: '0 0 4px 0',
    lineHeight: '1.3',
  },
  artistName: {
    fontSize: '16px',
    fontWeight: '400',
    margin: 0,
    opacity: 0.95,
  },
  contentPanel: {
    width: '60%',
    height: '100%',
    backgroundColor: '#e8e8e8',
    padding: '32px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  loginView: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    gap: '8px',
  },
  musicIcon: {
    marginBottom: '16px',
    opacity: 0.9,
  },
  titleText: {
    fontSize: '24px',
    fontWeight: '700',
    margin: '8px 0',
    color: '#1a1a1a',
    letterSpacing: '1px',
  },
  subtitleText: {
    fontSize: '14px',
    color: '#666',
    marginBottom: '32px',
    fontWeight: '400',
  },
  connectButton: {
    background: 'linear-gradient(to bottom, #ffffff, #f0f0f0)',
    border: '1px solid #b0b0b4',
    borderRadius: '8px',
    padding: '12px 24px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.8)',
    transition: 'all 0.15s cubic-bezier(0.4, 0.0, 0.2, 1)',
    color: '#1a1a1a',
    fontFamily: 'inherit',
  },
  ipodButton: {
    background: 'linear-gradient(to bottom, #ffffff, #f0f0f0)',
    border: '1px solid #b0b0b4',
    borderRadius: '8px',
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.8)',
    transition: 'all 0.15s cubic-bezier(0.4, 0.0, 0.2, 1)',
    color: '#1a1a1a',
    fontFamily: 'inherit',
    flex: 1,
  },
  mixButton: {
    background: 'linear-gradient(to bottom, #007aff, #0051d5)',
    color: '#fff',
    borderColor: '#0051d5',
    fontWeight: '600',
  },
  exportButton: {
    background: 'linear-gradient(to bottom, #34c759, #28a745)',
    color: '#fff',
    borderColor: '#28a745',
    fontWeight: '600',
    fontSize: '12px',
    padding: '6px 12px',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  ipodInput: {
    width: '100%',
    border: '1px solid #c8c8cc',
    background: '#fff',
    padding: '12px 16px',
    fontSize: '15px',
    borderRadius: '8px',
    marginBottom: '16px',
    fontFamily: 'inherit',
    boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.08)',
    transition: 'border-color 0.2s',
    outline: 'none',
  },
  buttonGroup: {
    display: 'flex',
    gap: '12px',
  },
  trackCounter: {
    marginTop: '16px',
    padding: '12px 16px',
    background: 'rgba(0,122,255,0.1)',
    borderRadius: '6px',
    fontSize: '13px',
    color: '#007aff',
    fontWeight: '500',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    transition: 'background 0.2s',
    userSelect: 'none',
  },
  arrowIcon: {
    transition: 'transform 0.3s ease',
  },
  seedList: {
    listStyle: 'none',
    padding: 0,
    margin: '12px 0 0 0',
    background: '#fff',
    borderRadius: '8px',
    overflow: 'hidden',
    boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
  },
  seedListItem: {
    padding: '10px 12px',
    borderBottom: '1px solid #f0f0f0',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  seedCover: {
    width: '40px',
    height: '40px',
    borderRadius: '4px',
    objectFit: 'cover',
    imageRendering: 'high-quality',
  },
  seedInfo: {
    flex: 1,
  },
  seedName: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#1a1a1a',
    marginBottom: '2px',
  },
  seedArtist: {
    fontSize: '12px',
    color: '#666',
  },
  removeButton: {
    background: 'transparent',
    border: 'none',
    color: '#999',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '16px',
    transition: 'all 0.2s',
  },
  suggestionsDropdown: {
    position: 'absolute',
    top: 'calc(100% - 16px)',
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    maxHeight: '300px',
    overflowY: 'auto',
    zIndex: 1000,
  },
  suggestionItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 12px',
    cursor: 'pointer',
    transition: 'background 0.2s',
    borderBottom: '1px solid #f0f0f0',
  },
  suggestionCover: {
    width: '45px',
    height: '45px',
    borderRadius: '4px',
    objectFit: 'cover',
    imageRendering: 'high-quality',
  },
  suggestionInfo: {
    flex: 1,
  },
  suggestionName: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#1a1a1a',
    marginBottom: '2px',
  },
  suggestionArtist: {
    fontSize: '12px',
    color: '#666',
  },
  playlistHeaderContainer: {
    marginTop: '28px',
    marginBottom: '12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  playlistHeader: {
    fontSize: '13px',
    fontWeight: '600',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  ipodList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    background: '#fff',
    borderRadius: '10px',
    overflow: 'hidden',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  ipodListItem: {
    padding: '12px 16px',
    borderBottom: '1px solid #e8e8ec',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    transition: 'background-color 0.2s cubic-bezier(0.4, 0.0, 0.2, 1)',
  },
  trackInfoContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flex: 1,
  },
  trackCover: {
    width: '50px',
    height: '50px',
    borderRadius: '4px',
    objectFit: 'cover',
    boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
    imageRendering: 'high-quality',
  },
  listItemName: {
    fontSize: '15px',
    fontWeight: '500',
    color: '#1a1a1a',
    marginBottom: '2px',
  },
  listItemArtist: {
    fontSize: '13px',
    color: '#666',
  },
  similarityBadge: {
    background: 'rgba(0,122,255,0.1)',
    color: '#007aff',
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: '600',
  },
  volumeControlDisabled: {
    opacity: 0.4,
    pointerEvents: 'none',
  },
  
  // Novos estilos para funcionalidades avançadas
  playlistActions: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  qualityButton: {
    background: 'linear-gradient(to bottom, #ff9500, #ff6b00)',
    color: '#fff',
    borderColor: '#ff6b00',
    fontWeight: '600',
    fontSize: '12px',
    padding: '6px 12px',
  },
  feedbackButton: {
    background: 'linear-gradient(to bottom, #ff3b30, #d70015)',
    color: '#fff',
    borderColor: '#d70015',
    fontWeight: '600',
    fontSize: '12px',
    padding: '6px 12px',
  },
  qualityMetricsContainer: {
    background: '#fff',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  qualityTitle: {
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 12px 0',
    color: '#1a1a1a',
  },
  qualityScore: {
    fontSize: '18px',
    fontWeight: '700',
    marginBottom: '16px',
    textAlign: 'center',
  },
  scoreValue: {
    color: '#007aff',
  },
  metricsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '12px',
    marginBottom: '16px',
  },
  metricItem: {
    background: '#f8f9fa',
    padding: '12px',
    borderRadius: '6px',
    textAlign: 'center',
  },
  metricLabel: {
    fontSize: '12px',
    color: '#666',
    marginBottom: '4px',
  },
  metricValue: {
    fontSize: '16px',
    fontWeight: '600',
    color: '#1a1a1a',
  },
  recommendationsContainer: {
    background: '#f8f9fa',
    padding: '12px',
    borderRadius: '6px',
  },
  recommendationsTitle: {
    fontSize: '14px',
    fontWeight: '600',
    margin: '0 0 8px 0',
    color: '#1a1a1a',
  },
  recommendationsList: {
    margin: 0,
    paddingLeft: '16px',
  },
  recommendationItem: {
    fontSize: '13px',
    color: '#666',
    marginBottom: '4px',
  },
  culturalAnalysisContainer: {
    background: '#fff',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  culturalTitle: {
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 12px 0',
    color: '#1a1a1a',
  },
  culturalInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  culturalItem: {
    fontSize: '14px',
    color: '#666',
  },
  vibeAnalysisContainer: {
    background: '#fff',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  vibeTitle: {
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 12px 0',
    color: '#1a1a1a',
  },
  vibeInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  vibeItem: {
    fontSize: '14px',
    color: '#666',
  },
  trackDetails: {
    flex: 1,
  },
  trackActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  trackRating: {
    display: 'flex',
    alignItems: 'center',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modalContent: {
    background: '#fff',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '600px',
    maxHeight: '80vh',
    overflow: 'hidden',
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
  },
  modalHeader: {
    padding: '20px',
    borderBottom: '1px solid #e8e8ec',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: '18px',
    fontWeight: '600',
    margin: 0,
    color: '#1a1a1a',
  },
  closeButton: {
    background: 'transparent',
    border: 'none',
    fontSize: '20px',
    cursor: 'pointer',
    color: '#666',
    padding: '4px',
  },
  modalBody: {
    padding: '20px',
    maxHeight: '50vh',
    overflowY: 'auto',
  },
  overallRatingSection: {
    marginBottom: '24px',
    textAlign: 'center',
  },
  ratingSectionTitle: {
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 12px 0',
    color: '#1a1a1a',
  },
  trackRatingsSection: {
    marginBottom: '16px',
  },
  trackRatingsList: {
    maxHeight: '200px',
    overflowY: 'auto',
  },
  trackRatingItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 0',
    borderBottom: '1px solid #f0f0f0',
  },
  ratingTrackCover: {
    width: '40px',
    height: '40px',
    borderRadius: '4px',
    objectFit: 'cover',
  },
  ratingTrackInfo: {
    flex: 1,
  },
  ratingTrackName: {
    fontSize: '14px',
    fontWeight: '500',
    color: '#1a1a1a',
    marginBottom: '2px',
  },
  ratingTrackArtist: {
    fontSize: '12px',
    color: '#666',
  },
  modalFooter: {
    padding: '20px',
    borderTop: '1px solid #e8e8ec',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '12px',
  },
  cancelButton: {
    background: 'transparent',
    border: '1px solid #c8c8cc',
    borderRadius: '6px',
    padding: '8px 16px',
    fontSize: '14px',
    cursor: 'pointer',
    color: '#666',
  },
  submitButton: {
    background: 'linear-gradient(to bottom, #007aff, #0051d5)',
    border: 'none',
    borderRadius: '6px',
    padding: '8px 16px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    color: '#fff',
  },
  feedbackStatsContainer: {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    background: '#fff',
    borderRadius: '8px',
    padding: '12px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    zIndex: 100,
  },
  statsTitle: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#666',
    marginBottom: '8px',
    textAlign: 'center',
  },
  statsGrid: {
    display: 'flex',
    gap: '12px',
  },
  statItem: {
    textAlign: 'center',
  },
  statValue: {
    fontSize: '16px',
    fontWeight: '700',
    color: '#007aff',
  },
  statLabel: {
    fontSize: '10px',
    color: '#666',
    marginTop: '2px',
  },
  
  // Estilos para funcionalidades de playlist salva
  resetButton: {
    background: 'linear-gradient(to bottom, #8e8e93, #6d6d70)',
    color: '#fff',
    borderColor: '#6d6d70',
    fontWeight: '600',
  },
  saveButton: {
    background: 'linear-gradient(to bottom, #007aff, #0051d5)',
    color: '#fff',
    borderColor: '#0051d5',
    fontWeight: '600',
    fontSize: '12px',
    padding: '6px 12px',
  },
  savedPlaylistsButton: {
    background: 'linear-gradient(to bottom, #007aff, #0051d5)',
    color: '#fff',
    borderColor: '#0051d5',
    fontWeight: '600',
    fontSize: '12px',
    padding: '6px 12px',
    marginTop: '12px',
  },
  savedPlaylistsSection: {
    marginTop: '16px',
  },
  savedPlaylistsContainer: {
    background: '#fff',
    borderRadius: '8px',
    padding: '16px',
    marginTop: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  savedPlaylistsTitle: {
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 12px 0',
    color: '#1a1a1a',
  },
  savedPlaylistsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  savedPlaylistItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px',
    background: '#f8f9fa',
    borderRadius: '6px',
    border: '1px solid #e8e8ec',
  },
  savedPlaylistInfo: {
    flex: 1,
  },
  savedPlaylistName: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: '4px',
  },
  savedPlaylistMeta: {
    fontSize: '12px',
    color: '#666',
  },
  savedPlaylistActions: {
    display: 'flex',
    gap: '8px',
  },
  loadButton: {
    background: 'linear-gradient(to bottom, #007aff, #0051d5)',
    border: 'none',
    borderRadius: '4px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    color: '#fff',
  },
  deleteButton: {
    background: 'linear-gradient(to bottom, #ff3b30, #d70015)',
    border: 'none',
    borderRadius: '4px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    color: '#fff',
  },
  savePlaylistSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  inputLabel: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: '8px',
  },
  playlistNameInput: {
    width: '100%',
    border: '1px solid #c8c8cc',
    background: '#fff',
    padding: '12px 16px',
    fontSize: '15px',
    borderRadius: '8px',
    fontFamily: 'inherit',
    boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.08)',
    transition: 'border-color 0.2s',
    outline: 'none',
  },
  playlistPreview: {
    background: '#f8f9fa',
    padding: '16px',
    borderRadius: '8px',
    border: '1px solid #e8e8ec',
  },
  previewTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: '8px',
  },
  previewInfo: {
    fontSize: '14px',
    color: '#666',
  },
  previewMeta: {
    fontSize: '12px',
    color: '#999',
    marginTop: '4px',
  },
  previewContext: {
    fontSize: '12px',
    color: '#007aff',
    marginTop: '4px',
    fontWeight: '500',
  },
};

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </Router>
  );
}

export default App;