// Discord Rich Presence : « Regarde <titre> » sur ton profil Discord, quelle que soit la plateforme.
// Il faut l'ID d'une application Discord (gratuit) dans src/config.js.
const { DISCORD_CLIENT_ID } = require('./config');

let Client = null;
try { ({ Client } = require('@xhayper/discord-rpc')); } catch {}

let client = null;
let ready = false;
let enabled = false;
let retryTimer = null;
let lastKey = null;
let lastSent = 0;
let pending = null;
let log = () => {};

const available = () => !!(Client && DISCORD_CLIENT_ID);

function connect() {
  if (!enabled || !available() || client) return;
  client = new Client({ clientId: DISCORD_CLIENT_ID, transport: { type: 'ipc' } });
  client.on('ready', () => {
    ready = true;
    lastKey = null;
    log('[discord] connecté');
    if (pending) push(pending, true);
  });
  client.on('disconnected', () => {
    log('[discord] déconnecté');
    reset();
    scheduleRetry();
  });
  client.login().catch(() => { reset(); scheduleRetry(); }); // Discord fermé : on réessaie plus tard
}

function reset() {
  ready = false;
  try { client && client.destroy(); } catch {}
  client = null;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (enabled) retryTimer = setTimeout(connect, 30_000);
}

// Discord limite à ~5 mises à jour / 20 s : on n'envoie que quand quelque chose change vraiment.
function push(np, force = false) {
  pending = np;
  if (!ready || !client || !client.user) return;

  const playing = np && np.title && np.playing;
  // clé = vidéo + état + position arrondie (pour détecter un saut dans la vidéo)
  const startAt = playing && np.duration ? Math.round((Date.now() / 1000 - (np.position || 0)) / 5) : 0;
  const key = playing ? `${np.title}|${np.artist}|${np.platform && np.platform.name}|${startAt}` : 'idle';
  if (!force && key === lastKey) return;
  if (!force && Date.now() - lastSent < 4000) return; // on retentera au prochain tour
  lastKey = key;
  lastSent = Date.now();

  if (!playing) {
    client.user.clearActivity().catch(() => {});
    return;
  }

  const now = Date.now();
  const activity = {
    type: 3, // « Regarde »
    statusDisplayType: 2, // affiche le titre dans la liste des membres
    details: clip(np.title, 128),
    state: clip(np.artist || (np.platform ? np.platform.name : ' '), 128),
    largeImageKey: np.art && /^https?:/.test(np.art) ? np.art : 'pellicule',
    largeImageText: clip(np.album || np.title, 128),
    smallImageKey: 'pellicule',
    smallImageText: np.platform ? `Sur ${np.platform.name} — via Pellicule` : 'Pellicule',
    instance: false,
  };
  if (np.duration && np.position != null) {
    activity.startTimestamp = new Date(now - np.position * 1000);
    activity.endTimestamp = new Date(now + (np.duration - np.position) * 1000);
  }
  client.user.setActivity(activity).catch(err => log(`[discord] ${err && err.message}`));
}

const clip = (s, n) => {
  s = String(s || '');
  if (s.length < 2) s = s.padEnd(2, ' '); // Discord exige au moins 2 caractères
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

module.exports = {
  available,
  setLogger(fn) { log = fn; },
  setEnabled(on) {
    enabled = on;
    if (on) connect();
    else {
      clearTimeout(retryTimer);
      if (client && client.user) client.user.clearActivity().catch(() => {});
      reset();
    }
  },
  update(np) { if (enabled) push(np); },
};
