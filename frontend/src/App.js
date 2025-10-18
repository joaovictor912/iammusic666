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
    } catch (err) {
      alert('Erro na análise: ' + err.message);
    }
    
    setLoading(false);
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
                </div>
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
                  
                  <ul style={styles.ipodList}>
                    {playlist.map((track, index) => (
                      <li key={index} style={styles.ipodListItem}>
                        <div style={styles.trackInfoContainer}>
                          <img 
                            src={track.albumImages?.[0]?.url || ''} 
                            alt={track.name} 
                            style={styles.trackCover}
                          />
                          <div>
                            <div style={styles.listItemName}>{track.name}</div>
                            <div style={styles.listItemArtist}>{track.artist}</div>
                          </div>
                        </div>
                        <button
                          onClick={() => removeTrackFromPlaylist(index)}
                          style={styles.removeButton}
                          title="Remove track"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
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
     flex: 'none',
    width: 'fit-content',
    padding: '8px 16px',
    fontSize: '13px',
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