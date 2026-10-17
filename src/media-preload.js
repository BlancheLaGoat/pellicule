// Injecté dans la page de chaque plateforme, AVANT ses propres scripts.
// On garde une copie des boutons que le site déclare à Windows (play/pause/suivant/avancer…)
// pour que Pellicule puisse les appuyer, et on lit titre/artiste/pochette/position.
const { webFrame, ipcRenderer } = require('electron');

// ---------------- Anti-pub YouTube / YouTube Music ----------------
// On ne bloque aucune requête (c'est ce qui cassait le lecteur) : quand une pub démarre,
// on coupe le son, on la passe en accéléré et on clique sur « Passer » dès qu'il apparaît.
// Les bannières et encarts pub de la page sont masqués.
let adskip = false;
let twitchMode = 'vaft';
const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
const isTwitch = /(^|\.)twitch\.tv$/.test(location.hostname);
try {
  if (isYouTube || isTwitch) {
    const cfg = ipcRenderer.sendSync('pellicule:adskip') || {};
    adskip = !!cfg.on;
    twitchMode = cfg.twitchMode || 'vaft';
  }
} catch {}

// Twitch, mode « bloquer » : script TwitchAdSolutions (vaft), injecté avant les scripts de Twitch.
// Il cherche un flux sans pub et retire les segments publicitaires du live.
if (adskip && isTwitch && twitchMode === 'vaft') {
  try {
    const code = ipcRenderer.sendSync('pellicule:twitch-script');
    if (code) webFrame.executeJavaScript(code);
  } catch {}
}

// ---------------- Anti-pub Twitch ----------------
// Encarts pub de la page : toujours masqués.
// Mode « sourdine » : pendant une pub, on coupe le son et on cache l'image derrière un écran
// « Pub en cours », puis on remet tout comme avant (désactivé en mode « bloquer » pour ne pas
// couper le flux propre que trouve vaft).
if (adskip && isTwitch) webFrame.executeJavaScript(`(() => {
  if (window.__pelliculeTwitchAds) return;
  window.__pelliculeTwitchAds = true;
  const MUTE_DURING_ADS = ${twitchMode === 'mute'};

  const CSS = [
    '.stream-display-ad', '[data-a-target="sda-panel"]', '[data-test-selector="sad-overlay"]',
    '[data-a-target="outstream-ax-overlay"]', '.video-ads__container', '[data-test-selector="ad-banner-default-text"]',
    '[aria-label="Annonce"]', '[aria-label="Advertisement"]',
  ].join(',') + '{opacity:0!important;pointer-events:none!important}' +
    '.pellicule-ad-cover{position:absolute;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;' +
    'background:#0e0e10;color:#efeff1;font:600 15px/1.4 Inter,Roobert,Segoe UI,sans-serif;text-align:center;pointer-events:none}' +
    '.pellicule-ad-cover small{font-weight:400;color:#adadb8;font-size:13px}';
  const addStyle = () => {
    if (document.getElementById('pellicule-twitch-ads')) return;
    const st = document.createElement('style');
    st.id = 'pellicule-twitch-ads';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  };
  if (document.documentElement) addStyle();
  document.addEventListener('DOMContentLoaded', addStyle);

  // repères affichés par le lecteur Twitch pendant une pub
  const AD = '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"], .video-ads__container [data-a-target]';
  const state = new WeakMap(); // vidéo -> { muted, cover }

  if (MUTE_DURING_ADS) setInterval(() => {
    for (const player of document.querySelectorAll('.video-player, [data-a-target="video-player"]')) {
      const v = player.querySelector('video');
      if (!v) continue;
      const ad = !!player.querySelector(AD);
      let st = state.get(v);
      if (ad) {
        if (!st) {
          st = { muted: v.muted, cover: document.createElement('div') };
          st.cover.className = 'pellicule-ad-cover';
          st.cover.innerHTML = 'Pub en cours<small>Son coupé par Pellicule — le live reprend tout seul</small>';
          (v.parentElement || player).appendChild(st.cover);
          state.set(v, st);
        }
        if (!v.muted) v.muted = true;
      } else if (st) {
        v.muted = st.muted;
        st.cover.remove();
        state.delete(v);
      }
    }
  }, 300);
})();`);

// ---------------- Anti-pub YouTube ----------------
// La page signale où se trouve le bouton « Passer » ; Pellicule y fait un vrai clic de souris
// (YouTube ignore parfois les clics simulés par script).
if (adskip && isYouTube) {
  window.addEventListener('message', e => {
    const d = e.source === window && e.data && e.data.__pelliculeYtSkip;
    if (d && typeof d.x === 'number' && typeof d.y === 'number') ipcRenderer.send('pellicule:yt-skip', { x: d.x, y: d.y });
  });
}
if (adskip && isYouTube) webFrame.executeJavaScript(`(() => {
  if (window.__pelliculeAdskip) return;
  window.__pelliculeAdskip = true;

  const CSS = [
    'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-banner-promo-renderer',
    'ytd-statement-banner-renderer', 'ytd-promoted-sparkles-web-renderer', 'ytd-display-ad-renderer',
    'ytd-companion-slot-renderer', 'ytd-player-legacy-desktop-watch-ads-renderer', '#player-ads', '#masthead-ad',
    'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)', 'ytd-search-pyv-renderer',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    '.ytp-ad-overlay-container', '.ytp-ad-image-overlay', 'ytmusic-mealbar-promo-renderer',
  ].join(',') + '{display:none!important}' +
    // pendant une pub : on cache l'image de la pub (le lecteur reste noir 1 ou 2 secondes)
    '.html5-video-player.ad-showing video{opacity:0!important}';

  const addStyle = () => {
    if (document.getElementById('pellicule-adskip')) return;
    const st = document.createElement('style');
    st.id = 'pellicule-adskip';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  };
  if (document.documentElement) addStyle();
  document.addEventListener('DOMContentLoaded', addStyle);

  const SKIP = [
    '.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button-slot button',
    '.ytp-ad-skip-button-container button', '[id^="skip-button"] button', '.ytp-skip-ad button', 'button[class*="skip-ad"]',
  ].join(',');
  let inAd = false, saved = null, lastTrusted = 0;

  // bouton « Passer » réellement visible et cliquable
  const visibleSkip = () => [...document.querySelectorAll(SKIP)].find(b => {
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const st = getComputedStyle(b);
    return st.visibility !== 'hidden' && st.display !== 'none' && +st.opacity > 0.05 && r.bottom > 0 && r.top < innerHeight;
  });

  setInterval(() => {
    const player = document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting')
      || document.querySelector('#movie_player, .html5-video-player');
    if (!player) return;
    const v = player.querySelector('video');
    const ad = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');

    if (ad && v) {
      if (!inAd) { inAd = true; saved = { muted: v.muted, rate: v.playbackRate > 0 && v.playbackRate <= 2 ? v.playbackRate : 1 }; }
      if (!v.muted) v.muted = true;
      if (v.playbackRate !== 16) { try { v.playbackRate = 16; } catch (e) {} }
      if (v.paused && v.readyState > 2) v.play().catch(() => {});
      const btn = visibleSkip();
      if (btn) {
        try { btn.click(); } catch (e) {}
        // vrai clic de souris, au plus une fois toutes les 0,7 s
        if (Date.now() - lastTrusted > 700) {
          lastTrusted = Date.now();
          const r = btn.getBoundingClientRect();
          window.postMessage({ __pelliculeYtSkip: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }, '*');
        }
      }
    } else if (inAd) {
      inAd = false;
      if (v && saved) {
        try { v.playbackRate = saved.rate; } catch (e) {}
        v.muted = saved.muted;
      }
      saved = null;
    }
    // fenêtre « les bloqueurs de pub ne sont pas autorisés » (au cas où)
    const enforce = document.querySelector('ytd-enforcement-message-view-model');
    if (enforce) {
      const dlg = enforce.closest('tp-yt-paper-dialog');
      const close = enforce.querySelector('#dismiss-button button, button[aria-label]');
      if (close) close.click(); else if (dlg) dlg.remove();
      const vv = document.querySelector('#movie_player video');
      if (vv && vv.paused) vv.play().catch(() => {});
    }
  }, 250);
})();`);

webFrame.executeJavaScript(`(() => {
  if (window.__pellicule) return;
  const handlers = {};
  let pos = null;
  const MS = window.MediaSession && MediaSession.prototype;
  if (MS) {
    const origSet = MS.setActionHandler;
    MS.setActionHandler = function (action, handler) {
      handlers[action] = handler;
      return origSet.call(this, action, handler);
    };
    const origPos = MS.setPositionState;
    if (origPos) {
      MS.setPositionState = function (s) {
        pos = s && s.duration ? { duration: s.duration, position: s.position || 0, rate: s.playbackRate || 1, at: Date.now() } : null;
        return origPos.call(this, s);
      };
    }
  }
  // Certains sites (Spotify…) jouent le son avec un lecteur qui n'est jamais ajouté à la page :
  // on retient tous les lecteurs qui démarrent, même invisibles.
  const known = new Set();
  const HME = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (HME) {
    const origPlay = HME.play;
    HME.play = function () { known.add(this); return origPlay.apply(this, arguments); };
  }
  for (const ev of ['play', 'playing', 'loadedmetadata']) {
    document.addEventListener(ev, e => { if (e.target instanceof HTMLMediaElement) known.add(e.target); }, true);
  }
  const media = () => {
    const all = [...new Set([...known, ...document.querySelectorAll('audio,video')])]
      .filter(m => m.currentSrc || m.src || m.srcObject);
    // priorité : celui qui joue, puis celui qui a une durée
    return all.find(m => !m.paused && !m.ended)
      || all.find(m => isFinite(m.duration) && m.duration > 0)
      || all[0] || null;
  };
  const abs = u => { try { return new URL(u, location.href).href; } catch { return null; } };

  window.__pellicule = {
    state() {
      const ms = navigator.mediaSession;
      const md = ms && ms.metadata;
      const m = media();
      let playing = !!ms && ms.playbackState === 'playing';
      if (m && (!ms || ms.playbackState === 'none' || !ms.playbackState)) playing = !m.paused && !m.ended;
      else if (m && !playing && ms.playbackState !== 'paused') playing = !m.paused && !m.ended;

      let position = null, duration = null;
      if (pos) {
        duration = pos.duration;
        position = pos.position + (playing ? (Date.now() - pos.at) / 1000 * pos.rate : 0);
      } else if (m && isFinite(m.duration) && m.duration > 0) {
        duration = m.duration;
        position = m.currentTime;
      }
      if (duration && position > duration) position = duration;

      let art = null;
      if (md && md.artwork && md.artwork.length) {
        // la plus grande pochette proposée
        const best = [...md.artwork].sort((a, b) => (parseInt(b.sizes) || 0) - (parseInt(a.sizes) || 0))[0];
        art = abs(best.src);
      }
      return {
        title: md ? md.title : null,
        artist: md ? md.artist : null,
        album: md ? md.album : null,
        art, playing, position, duration,
        volume: m ? m.volume : null,
        can: {
          prev: !!handlers.previoustrack,
          next: !!handlers.nexttrack,
          seek: !!handlers.seekto || !!(m && isFinite(m.duration)),
          volume: !!m,
        },
      };
    },
    // a = 'play' | 'pause' | 'toggle' | 'nexttrack' | 'previoustrack'
    //   | { seek: secondes } | { volume: 0..1 }
    action(a) {
      const m = media();
      if (a && typeof a === 'object') {
        if (typeof a.seek === 'number') {
          if (handlers.seekto) { try { handlers.seekto({ action: 'seekto', seekTime: a.seek }); return true; } catch (e) {} }
          if (m) { m.currentTime = a.seek; return true; }
        }
        if (typeof a.volume === 'number' && m) {
          m.volume = Math.max(0, Math.min(1, a.volume));
          return true;
        }
        return false;
      }
      if (a === 'toggle') a = this.state().playing ? 'pause' : 'play';
      const h = handlers[a];
      if (h) { try { h({ action: a }); return true; } catch (e) {} }
      if (m && a === 'play') { m.play(); return true; }
      if (m && a === 'pause') { m.pause(); return true; }
      return false;
    },
  };
})();`);
