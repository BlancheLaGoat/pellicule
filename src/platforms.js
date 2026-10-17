// Plateformes proposées sur l'écran d'accueil.
// url : page d'ouverture ; domains : sites qui restent dans l'appli (le reste s'ouvre dans ton navigateur).
// multi : plusieurs onglets possibles en mode onglets ; adblock : anti-pub de Pellicule.
module.exports = [
  {
    id: 'netflix', name: 'Netflix', color: '#1a0607', accent: '#e50914',
    url: 'https://www.netflix.com/browse',
    domains: ['netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxext.com', 'nflxso.net'],
  },
  {
    id: 'disneyplus', name: 'Disney+', color: '#0b1430', accent: '#3d7bff',
    url: 'https://www.disneyplus.com/',
    domains: ['disneyplus.com', 'disney-plus.net', 'bamgrid.com', 'dssott.com', 'mydisney.com', 'go.com', 'disney.com'],
  },
  {
    id: 'primevideo', name: 'Prime Video', color: '#0b1a26', accent: '#1fa8ff',
    url: 'https://www.primevideo.com/',
    domains: ['primevideo.com', 'amazon.fr', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'media-amazon.com', 'aiv-cdn.net', 'aiv-delivery.net'],
  },
  {
    id: 'viki', name: 'Viki', color: '#06222a', accent: '#1ec2e8',
    url: 'https://www.viki.com/',
    domains: ['viki.com', 'viki.io', 'vikiassets.com'],
    note: 'Dramas asiatiques sous-titrés',
  },
  {
    id: 'youtube', name: 'YouTube', color: '#2a0b0b', accent: '#ff4040',
    url: 'https://www.youtube.com/',
    domains: ['youtube.com', 'youtu.be', 'google.com', 'gstatic.com', 'ytimg.com'],
    adblock: true,
    multi: true,
    note: 'Pubs passées automatiquement · la connexion Google peut être refusée',
  },
  {
    id: 'twitch', name: 'Twitch', color: '#1f1233', accent: '#a970ff',
    url: 'https://www.twitch.tv/',
    domains: ['twitch.tv', 'ttvnw.net', 'jtvnw.net', 'twitchcdn.net', 'twitchsvc.net'],
    adblock: true,
    multi: true,
    note: 'Pubs bloquées (TwitchAdSolutions)',
  },
];
