// Pellicule — tes plateformes vidéo (Netflix, Disney+, Prime Video, Viki, YouTube, Twitch) dans une appli desktop stable.
// Build Electron Castlabs = Widevine => les vidéos protégées se lisent. Une session séparée par plateforme : tu restes connecté partout.
// Si une page crashe ou fige, elle se relance toute seule là où tu étais.
//
// Fenêtres : chaque fenêtre (« hôte ») contient une barre d'onglets (cachée en mode classique) et une vue par page.
//  - mode classique (par défaut) : une seule page à la fois, changer de plateforme remplace la page, comme avant ;
//  - mode onglets : plusieurs plateformes ouvertes en même temps, chaque onglet peut être détaché dans sa fenêtre.

const {
  app, components, BaseWindow, WebContentsView, Tray, Menu, nativeImage, shell, session, ipcMain,
  dialog, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');

// Points d'accroche pour les tests automatiques (sans effet en temps normal).
if (process.env.PELLICULE_USER_DATA) app.setPath('userData', process.env.PELLICULE_USER_DATA);
const PLATFORMS = process.env.PELLICULE_PLATFORMS_FILE ? require(process.env.PELLICULE_PLATFORMS_FILE) : require('./platforms');

const discord = require('./discord');

// Les sites vidéo refusent les navigateurs « inconnus » ou trop vieux : on se présente comme le Chrome
// sur lequel l'appli est construite (même version), sous Windows.
const CHROME_MAJOR = String(process.versions.chrome || '140').split('.')[0];
const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';
// Pages de connexion tierces autorisées dans une popup (le reste part dans ton navigateur).
const AUTH_DOMAINS = [
  'accounts.google.com', 'appleid.apple.com', 'idmsa.apple.com', 'facebook.com',
  'amazon.fr', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'primevideo.com', 'mydisney.com', 'go.com',
];

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const BAR_H = 40;
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const logFile = () => path.join(app.getPath('userData'), 'crash.log');

let mainHost = null;          // fenêtre principale
const hosts = new Set();      // toutes les fenêtres (principale + détachées)
let nowTab = null;            // onglet dont on affiche la lecture (barre, Discord)
let pollTimer = null;
let nowPlaying = { title: null, playing: false };
let tray = null;
let quitting = false;
let startHidden = process.argv.includes('--hidden'); // lancé par Windows au démarrage
let crashTimes = [];
let state = { lastUrls: {} };
let updateStatus = '';
let tabSeq = 0;
const configured = new Set();

const byId = id => PLATFORMS.find(p => p.id === id);
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
const inDomains = (url, domains) => { const h = hostOf(url); return domains.some(d => h === d || h.endsWith('.' + d)); };
const tabsMode = () => !!state.tabsMode;
const allTabs = () => [...hosts].flatMap(h => h.tabs);
const findTab = pred => allTabs().find(pred);
const alive = t => t && t.view && !t.view.webContents.isDestroyed();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logFile(), line); } catch {}
  console.log(line.trim());
}

function loadState() {
  try { state = { lastUrls: {}, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch {}
}

function saveState() {
  if (mainHost && !mainHost.win.isDestroyed()) {
    if (!mainHost.floating) Object.assign(state, mainHost.win.getNormalBounds(), { maximized: mainHost.win.isMaximized() });
    // onglets ouverts (toutes fenêtres confondues) pour les rouvrir au prochain lancement
    const list = allTabs().filter(t => t.p);
    state.tabs = list.map(t => ({ id: t.p.id, url: alive(t) ? t.view.webContents.getURL() || null : null }));
    const act = mainHost.active;
    if (act && act.p) { state.platform = act.p.id; state.activeTab = list.indexOf(act); }
  }
  try { fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch {}
}

// Chaque plateforme a sa propre session (cookies, connexion) qui persiste entre les lancements.
function sessionFor(p) {
  const s = session.fromPartition(`persist:${p.id}`);
  if (configured.has(p.id)) return s;
  configured.add(p.id);

  s.setUserAgent(CHROME_UA);
  s.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(['mediaKeySystem', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm));
  });
  // Google bloque les connexions dans les applis Electron : sur ses pages on se présente comme Firefox.
  s.webRequest.onBeforeSendHeaders({ urls: ['*://accounts.google.com/*'] }, (d, cb) => {
    const h = d.requestHeaders;
    h['User-Agent'] = FIREFOX_UA;
    for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('sec-ch-ua')) delete h[k];
    cb({ requestHeaders: h });
  });
  return s;
}

// La page YouTube/Twitch demande au démarrage si l'anti-pub est actif (voir media-preload.js).
ipcMain.on('pellicule:adskip', e => { e.returnValue = { on: state.adblock !== false, twitchMode: state.twitchAds || 'vaft' }; });
// YouTube : vrai clic de souris sur le bouton « Passer » (coordonnées envoyées par la page).
const lastSkipClick = new WeakMap();
ipcMain.on('pellicule:yt-skip', (e, pt) => {
  const wc = e.sender;
  const tab = findTab(t => alive(t) && t.view.webContents === wc);
  if (!tab || !tab.p || !tab.p.adblock || state.adblock === false) return;
  if (!/(^|\.)youtube\.com$/.test(hostOf(wc.getURL()))) return;
  const x = Math.round(Number(pt && pt.x)), y = Math.round(Number(pt && pt.y));
  const [w, h] = (() => { const b = tab.view.getBounds(); return [b.width, b.height]; })();
  if (!(x >= 0 && y >= 0 && x <= w && y <= h)) return;
  const now = Date.now();
  if (now - (lastSkipClick.get(wc) || 0) < 600) return;
  lastSkipClick.set(wc, now);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
});

// Script TwitchAdSolutions (vaft), lu une fois puis gardé en mémoire.
let vaftCode = null;
ipcMain.on('pellicule:twitch-script', e => {
  if (vaftCode == null) {
    try { vaftCode = fs.readFileSync(path.join(__dirname, 'vendor', 'twitch-vaft.js'), 'utf8'); }
    catch (err) { log(`[twitch] script vaft introuvable : ${err.message}`); vaftCode = ''; }
  }
  e.returnValue = vaftCode;
});

// Mode anti-pub Twitch : 'vaft' (bloquer, TwitchAdSolutions) ou 'mute' (couper le son et masquer).
function setTwitchAds(mode) {
  state.twitchAds = mode;
  saveState();
  for (const t of allTabs()) if (t.p && t.p.id === 'twitch' && alive(t)) t.view.webContents.reload();
  buildTrayMenu();
}

// Active / coupe l'anti-pub sur YouTube, YouTube Music et Twitch.
async function setAdblock(on) {
  state.adblock = on;
  saveState();
  for (const t of allTabs()) if (t.p && t.p.adblock && alive(t)) t.view.webContents.reload();
  buildTrayMenu();
}

// ------------------------------------------------------------------
// Fenêtres et onglets
// ------------------------------------------------------------------
class Host {
  constructor({ main, bounds }) {
    this.main = main;
    this.tabs = [];
    this.active = null;
    this.fullscreenTab = null;
    this.win = new BaseWindow({
      width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y,
      minWidth: 640, minHeight: 420,
      backgroundColor: '#0b0b0d', title: 'Pellicule', icon: ICON, autoHideMenuBar: true, show: false,
    });
    this.bar = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'tabs-preload.js'), contextIsolation: true, sandbox: true },
    });
    this.bar.setBackgroundColor('#0b0b0d');
    this.bar.webContents.loadFile(path.join(__dirname, 'tabs.html'));
    this.bar.webContents.on('did-finish-load', () => this.updateBar());
    this.bar.webContents.on('before-input-event', (e, input) => shortcut(e, input, this));
    this.win.contentView.addChildView(this.bar);

    const moved = () => {
      if (this.floating) { const b = this.win.getBounds(); state.float = { x: b.x, y: b.y, width: b.width, height: b.height }; }
      if (this.main || this.floating) saveState();
    };
    this.win.on('resize', () => { this.layout(); moved(); });
    this.win.on('move', moved);
    this.win.on('leave-full-screen', () => {   // sortie du plein écran par Windows (Échap, Win+↓…)
      if (this.windowFullscreen && !this.fullscreenTab) { this.windowFullscreen = false; this.layout(); this.updateBar(); }
    });
    this.win.on('focus', () => { if (this.active && alive(this.active)) this.active.view.webContents.focus(); });
    this.win.on('app-command', (_e, cmd) => {   // boutons latéraux de la souris
      if (cmd === 'browser-backward') goBack(this);
      if (cmd === 'browser-forward') goForward(this);
    });
    this.win.on('close', e => {
      if (this.main) {
        saveState();
        if (!quitting) {
          // on range Pellicule près de l'horloge (les connexions restent ouvertes) et on met les vidéos en pause
          e.preventDefault();
          if (this.floating) setFloating(this, false);
          this.win.hide();
          pauseAll();
        }
        return;
      }
      // fenêtre détachée : on ferme ses onglets avec elle
      for (const t of [...this.tabs]) destroyTab(t);
    });
    this.win.on('closed', () => {
      hosts.delete(this);
      if (this.main) mainHost = null;
      buildTrayMenu();
    });
    hosts.add(this);
    this.layout();
    setImmediate(() => updateThumbar(true));
  }

  barVisible() { return !this.fullscreenTab; } // la barre porte le bouton Accueil, même en mode classique
  barHeight() { return this.floating ? FLOAT_BAR_H : BAR_H; }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const barH = this.barVisible() ? this.barHeight() : 0;
    this.bar.setVisible(barH > 0);
    this.bar.setBounds({ x: 0, y: 0, width, height: this.barHeight() });
    for (const t of this.tabs) t.view.setBounds({ x: 0, y: barH, width, height: Math.max(0, height - barH) });
  }

  add(tab, { activate = true, index } = {}) {
    tab.host = this;
    this.win.contentView.addChildView(tab.view);
    if (index == null || index < 0 || index > this.tabs.length) this.tabs.push(tab);
    else this.tabs.splice(index, 0, tab);
    this.layout();
    if (activate || !this.active) this.activate(tab);
    else { tab.view.setVisible(false); this.updateBar(); }
  }

  // Retire l'onglet de cette fenêtre sans le détruire (pour le déplacer).
  take(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return -1;
    this.tabs.splice(i, 1);
    if (this.fullscreenTab === tab) this.exitFullscreen();
    try { this.win.contentView.removeChildView(tab.view); } catch {}
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.activate(next);
    }
    this.updateBar();
    return i;
  }

  activate(tab) {
    if (!tab || this.tabs.indexOf(tab) < 0) return;
    if (this.active && this.active !== tab) this.previous = this.active;
    this.active = tab;
    for (const t of this.tabs) t.view.setVisible(t === tab);
    if (!this.win.isDestroyed()) {
      this.win.setTitle(tab.p ? `${tab.p.name} — Pellicule` : 'Pellicule');
      this.win.setBackgroundColor(tab.p ? tab.p.color : '#0b0b0d');
    }
    if (alive(tab) && this.win.isVisible()) tab.view.webContents.focus();
    this.updateBar();
    if (this.main) saveState();
    buildTrayMenu();
  }

  // Plein écran demandé par le lecteur vidéo du site : la vidéo prend tout l'écran, la barre disparaît.
  enterFullscreen(tab) {
    if (this.floating) setFloating(this, false);
    this.fullscreenTab = tab;
    this.win.setFullScreen(true);
    this.layout();
  }

  exitFullscreen() {
    this.fullscreenTab = null;
    if (!this.win.isDestroyed()) { if (!this.windowFullscreen) this.win.setFullScreen(false); this.layout(); }
  }

  updateBar() {
    if (this.bar.webContents.isDestroyed() || this.bar.webContents.isLoading()) return;
    this.bar.webContents.send('tabs:state', {
      main: this.main,
      tabsMode: tabsMode(),
      floating: !!this.floating,
      fullscreen: !!this.windowFullscreen,
      active: this.active ? this.active.key : null,
      nav: navState(this),
      np: npForBar(),
      tabs: this.tabs.map(t => ({
        key: t.key,
        name: t.p ? tabName(t) : 'Nouvel onglet',
        platform: t.p ? t.p.name : null,
        accent: t.p ? t.p.accent : '#8d8d97',
        picker: !t.p,
        audible: alive(t) && t.view.webContents.isCurrentlyAudible(),
        muted: alive(t) && t.view.webContents.isAudioMuted(),
      })),
    });
  }

  show() {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    if (this.main && state.maximized && !this.win.isVisible()) this.win.maximize();
    this.win.show();
    this.win.focus();
  }
}

// Nom affiché dans l'onglet : le titre de la page (vidéo, chaîne) pour YouTube/Twitch, sinon le nom de la plateforme.
function tabName(t) {
  if (!t.p.multi || !t.title) return t.p.name;
  const clean = t.title.replace(/\s*[-–|]\s*(YouTube|Twitch|Viki)\s*$/i, '').replace(/^\(\d+\)\s*/, '').trim();
  return clean && clean.toLowerCase() !== t.p.name.toLowerCase() ? clean : t.p.name;
}

function createMainHost() {
  mainHost = new Host({
    main: true,
    bounds: { width: state.width || 1280, height: state.height || 800, x: state.x, y: state.y },
  });
  return mainHost;
}

// Crée un onglet : une plateforme (p) ou l'écran de choix (p = null).
function createTab(p, url) {
  const view = new WebContentsView({
    webPreferences: p
      ? {
          session: sessionFor(p),
          preload: path.join(__dirname, 'media-preload.js'),
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
          plugins: true,
        }
      : { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
  });
  view.setBackgroundColor(p ? p.color : '#0b0b0d');
  const tab = { key: `t${++tabSeq}`, p, view, host: null };
  wireTab(tab);
  if (p) {
    const last = state.lastUrls[p.id];
    const target = url && inDomains(url, p.domains) ? url
      : tabsMode() && p.multi ? p.url              // nouvel onglet YouTube/Twitch : page d'accueil
      : last && inDomains(last, p.domains) && !isAuthPage(last) ? last : p.url;
    view.webContents.loadURL(target);
  } else {
    view.webContents.loadFile(path.join(__dirname, 'picker.html'));
  }
  return tab;
}

function destroyTab(tab) {
  if (tab.host) tab.host.take(tab);
  if (nowTab === tab) nowTab = null;
  try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
}

function wireTab(tab) {
  const wc = tab.view.webContents;
  const p = tab.p;
  wc.on('before-input-event', (e, input) => shortcut(e, input, tab.host));
  wc.on('audio-state-changed', () => tab.host && tab.host.updateBar());
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-finish-load']) {
    wc.on(ev, () => { if (tab.host && tab.host.active === tab) tab.host.updateBar(); });
  }
  wc.on('enter-html-full-screen', () => tab.host && tab.host.enterFullscreen(tab));
  wc.on('leave-html-full-screen', () => tab.host && tab.host.exitFullscreen());
  wc.on('page-title-updated', (_e, title) => { tab.title = title; if (tab.host) tab.host.updateBar(); });
  if (!p) return;

  // Mémorise la page en cours pour y revenir après un crash ou au prochain lancement.
  const track = (_e, url) => { if (inDomains(url, p.domains) && !isAuthPage(url)) state.lastUrls[p.id] = url; };
  wc.on('did-navigate', (e, url, code) => {
    log(`${p.name} : page ${code} ${String(url).slice(0, 200)}`);
    // Page d'erreur (« Not found »…) : souvent le cache interne du site (service worker) abîmé par un chargement
    // coupé. On le vide et on repart de la page d'accueil de la plateforme, une fois par lancement.
    if (code >= 400 && !repaired.has(p.id)) {
      repaired.add(p.id);
      delete state.lastUrls[p.id];
      repairSite(p).then(() => { if (alive(tab)) wc.loadURL(p.url).catch(() => {}); });
      return;
    }
    track(e, url);
  });
  wc.on('did-navigate-in-page', track);

  // --- Filets de sécurité ---
  wc.on('render-process-gone', (_e, d) => recover(tab, `renderer: ${d.reason}`));
  wc.on('unresponsive', () => {
    log(`${p.name} : page figée, on attend 10 s avant de forcer…`);
    setTimeout(() => { if (alive(tab) && !wc.isCrashed()) wc.forcefullyCrashRenderer(); }, 10_000);
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) recover(tab, `chargement raté ${code} ${desc}`);
  });

  // Liens : site de la plateforme ou connexion => popup dans l'appli ; le reste => navigateur.
  wc.setWindowOpenHandler(({ url }) => {
    // en mode onglets, un lien YouTube/Twitch ouvert « dans un nouvel onglet » devient un vrai onglet
    if (tabsMode() && p.multi && inDomains(url, p.domains) && !inDomains(url, AUTH_DOMAINS)) {
      setImmediate(() => open(p.id, { inHost: tab.host, url, background: true, after: tab }));
      return { action: 'deny' };
    }
    if (inDomains(url, p.domains) || inDomains(url, AUTH_DOMAINS)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720 } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Pages de connexion (login.disney.com/finish-authorize, /login, /ap/signin…) : elles ne marchent qu'au milieu
// d'une connexion, on ne les rouvre jamais au lancement suivant.
function isAuthPage(url) {
  try {
    const u = new URL(url);
    return /^(login|auth|accounts?|signin|id|identity|registerdisney)\./i.test(u.hostname)
      || /(^|\/)(login|signin|sign-in|logout|authorize|finish-authorize|oauth|ap\/signin|ap\/register|identity)(\/|$|\?)/i.test(u.pathname);
  } catch { return true; }
}

// Vide le cache interne du site (service workers + cache des pages), sans toucher à la connexion (cookies).
const repaired = new Set();
async function repairSite(p) {
  try {
    await sessionFor(p).clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    await sessionFor(p).clearCache();
    log(`${p.name} : cache du site vidé`);
  } catch (err) { log(`${p.name} : impossible de vider le cache (${err && err.message})`); }
}

// Recharge la page sans tourner en boucle si le site est vraiment HS.
function recover(tab, reason) {
  const p = tab.p;
  const now = Date.now();
  crashTimes = crashTimes.filter(t => now - t < 60_000);
  crashTimes.push(now);
  log(`${p.name} : récupération (${reason}) — ${crashTimes.length} dans la dernière minute`);
  const delay = crashTimes.length > 3 ? 15_000 : 1_000;
  setTimeout(() => {
    if (!alive(tab) || !tab.host) return;
    const last = state.lastUrls[p.id];
    tab.view.webContents.loadURL(last && inDomains(last, p.domains) ? last : p.url).catch(() => {});
  }, delay);
}

// Ouvre une plateforme (ou l'écran de choix si id = null).
//  - mode classique : remplace la page de la fenêtre principale (comme avant) ;
//  - mode onglets : va sur l'onglet s'il existe déjà, sinon en ouvre un nouveau.
function open(id, { inHost, replace, url, background, after } = {}) {
  const p = id ? byId(id) : null;
  if (!mainHost) createMainHost();
  const host = inHost && !inHost.win.isDestroyed() ? inHost : mainHost;

  // YouTube, Twitch… : en mode onglets, chaque ouverture crée un nouvel onglet
  const allowDuplicate = p && tabsMode() && (p.multi || url);
  if (p && !allowDuplicate) {
    const existing = findTab(t => t.p && t.p.id === p.id);
    if (existing) {
      existing.host.activate(existing);
      if (replace && replace !== existing) destroyTab(replace);
      showHost(existing.host);
      return existing;
    }
  } else if (!p && tabsMode()) {
    const picker = host.tabs.find(t => !t.p);
    if (picker) { host.activate(picker); showHost(host); return picker; }
  }

  const tab = createTab(p, url);
  if (!tabsMode()) {
    // une seule page à la fois : on remplace tout ce qui est ouvert dans la fenêtre principale
    const old = [...mainHost.tabs];
    mainHost.add(tab);
    for (const t of old) destroyTab(t);
  } else if (replace && replace.host === host) {
    const idx = host.tabs.indexOf(replace);
    host.add(tab, { index: idx });
    destroyTab(replace);
  } else if (after && after.host === host) {
    host.add(tab, { index: host.tabs.indexOf(after) + 1, activate: !background });
  } else {
    host.add(tab, { activate: !background });
  }
  if (p) state.platform = p.id;
  saveState();
  if (!background) showHost(host);
  return tab;
}

function showHost(host) {
  // Au démarrage de Windows, la fenêtre reste cachée.
  if (startHidden) return;
  host.show();
}

// Déplace un onglet dans une nouvelle fenêtre (sans recharger la page).
function detach(tab, at) {
  const from = tab.host;
  if (!from || !tab.p || (from.tabs.length < 2 && !from.main)) return;
  const [w, h] = from.win.getSize();
  const W = Math.min(w, 1100), H = Math.min(h, 760);
  const cur = at || screen.getCursorScreenPoint();
  const host = new Host({ main: false, bounds: { width: W, height: H, x: Math.round(cur.x - W / 2), y: Math.round(cur.y - 20) } });
  from.take(tab);
  host.add(tab);
  host.show();
  if (from.main && from.tabs.length === 0) open(null); // la fenêtre principale garde au moins l'écran de choix
  saveState();
  buildTrayMenu();
}

// Remet un onglet détaché dans la fenêtre principale.
function attach(tab) {
  const from = tab.host;
  if (!from || from.main) return;
  if (!mainHost) createMainHost();
  from.take(tab);
  // si la fenêtre principale n'affiche que l'écran de choix, on le remplace
  const onlyPicker = mainHost.tabs.length === 1 && !mainHost.tabs[0].p ? mainHost.tabs[0] : null;
  mainHost.add(tab);
  if (onlyPicker) destroyTab(onlyPicker);
  if (from.tabs.length === 0) from.win.close();
  mainHost.show();
  saveState();
  buildTrayMenu();
}

// Active / coupe le mode onglets.
function setTabsMode(on) {
  if (on === tabsMode()) return;
  if (!on) {
    // retour au mode classique : on garde la page affichée dans la fenêtre principale, le reste se ferme
    const keep = (mainHost && mainHost.active) || null;
    for (const h of [...hosts]) if (!h.main) { for (const t of [...h.tabs]) if (t !== keep) destroyTab(t); h.win.close(); }
    if (mainHost) for (const t of [...mainHost.tabs]) if (t !== keep) destroyTab(t);
  }
  state.tabsMode = on;
  for (const h of hosts) { h.layout(); h.updateBar(); }
  saveState();
  buildTrayMenu();
}

// Accueil : affiche l'écran de choix SANS fermer la plateforme en cours.
// Choisir la même plateforme y revient ; en choisir une autre la remplace (mode classique).
function goHome(inHost) {
  if (!mainHost) createMainHost();
  let host = inHost && !inHost.win.isDestroyed() ? inHost : mainHost;
  if (!tabsMode()) host = mainHost;
  const picker = host.tabs.find(t => !t.p);
  if (picker) { host.activate(picker); showHost(host); return picker; }
  const tab = createTab(null);
  host.add(tab);
  showHost(host);
  return tab;
}

// « Retour » depuis l'accueil : revient à la page d'avant et ferme l'écran de choix.
function leaveHome(pickerTab) {
  const host = pickerTab && pickerTab.host;
  if (!host) return;
  const back = host.previous && host.previous !== pickerTab && host.tabs.includes(host.previous) && host.previous.p
    ? host.previous
    : [...host.tabs].reverse().find(t => t.p);
  if (!back) return; // rien vers quoi revenir
  host.activate(back);
  destroyTab(pickerTab);
  saveState();
}

function closeTab(tab) {
  const host = tab.host;
  if (!host) return;
  if (host.main && host.tabs.length === 1) {
    // dernier onglet de la fenêtre principale : on revient à l'écran de choix
    if (tab.p) open(null, { replace: tab });
    return;
  }
  destroyTab(tab);
  if (!host.main && host.tabs.length === 0) host.win.close();
  saveState();
  buildTrayMenu();
}

// Raccourcis clavier, valables dans toutes les pages.
// ------------------------------------------------------------------
// Retour / Suivant (historique de la page affichée)
// Sur l'écran d'accueil, « Retour » ramène à la plateforme d'où on vient.
// ------------------------------------------------------------------
const navOf = t => (alive(t) ? t.view.webContents.navigationHistory : null);

function navState(host) {
  const t = host.active;
  if (!t) return { back: false, forward: false };
  if (!t.p) {
    const prev = host.previous && host.previous !== t && host.tabs.includes(host.previous) && host.previous.p;
    return { back: !!(prev || host.tabs.some(x => x.p)), forward: false };
  }
  const h = navOf(t);
  return { back: !!(h && h.canGoBack()), forward: !!(h && h.canGoForward()) };
}

function goBack(host = mainHost) {
  const t = host && host.active;
  if (!t) return;
  if (!t.p) return leaveHome(t);
  const h = navOf(t);
  if (h && h.canGoBack()) h.goBack();
}

function goForward(host = mainHost) {
  const t = host && host.active;
  const h = t && t.p && navOf(t);
  if (h && h.canGoForward()) h.goForward();
}

function shortcut(e, input, host) {
  // Alt + ← / → : retour / suivant (comme dans un navigateur)
  if (input.type === 'keyDown' && input.alt && !input.control && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
    e.preventDefault();
    return input.key === 'ArrowLeft' ? goBack(host || mainHost) : goForward(host || mainHost);
  }
  // Échap quitte le plein écran F11 (la touche est quand même transmise au site)
  if (input.type === 'keyDown' && input.key === 'Escape' && host && host.windowFullscreen && !host.fullscreenTab) {
    toggleWindowFullscreen(host);
  }
  if (input.type === 'keyDown' && input.key === 'F11' && !input.control && !input.alt) {
    e.preventDefault();
    return toggleWindowFullscreen(host || mainHost);
  }
  if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && !input.shift && input.key.toLowerCase() === 'r'))) {
    e.preventDefault();
    return reloadActive(host || mainHost, input.control && input.key === 'F5');
  }
  if (input.type !== 'keyDown' || !input.control) return;
  const k = input.key.toLowerCase();
  const h = host || mainHost;
  if (input.shift) {
    if (k === 'p') { e.preventDefault(); goHome(h); }
    if (k === 'f') { e.preventDefault(); setFloating(h, !h.floating); }
    if (k === 'd' && tabsMode() && h && h.active) { e.preventDefault(); detach(h.active); }
  }
  if (!tabsMode() || !h) return;
  if (!input.shift && k === 't') { e.preventDefault(); open(null, { inHost: h }); }
  if (!input.shift && k === 'w' && h.active) { e.preventDefault(); closeTab(h.active); }
  if (k === 'tab' && h.tabs.length > 1) {
    e.preventDefault();
    const i = h.tabs.indexOf(h.active);
    h.activate(h.tabs[(i + (input.shift ? -1 : 1) + h.tabs.length) % h.tabs.length]);
  }
  if (!input.shift && /^[1-9]$/.test(k)) {
    const t = h.tabs[Math.min(+k, h.tabs.length) - 1];
    if (t) { e.preventDefault(); h.activate(t); }
  }
}

function showWin() {
  if (!mainHost) { open(state.platform || null); return; }
  if (!mainHost.tabs.length) open(null);
  mainHost.show();
}

// --- IPC de la barre d'onglets ---
const tabByKey = key => findTab(t => t.key === key);
ipcMain.on('tabs:activate', (_e, key) => { const t = tabByKey(key); if (t) t.host.activate(t); });
ipcMain.on('tabs:close', (_e, key) => { const t = tabByKey(key); if (t) closeTab(t); });
const hostOfBar = sender => [...hosts].find(x => x.bar.webContents === sender) || mainHost;
ipcMain.on('tabs:back', e => goBack(hostOfBar(e.sender)));
ipcMain.on('tabs:reload', e => reloadActive(hostOfBar(e.sender)));
ipcMain.on('tabs:media', (_e, action) => { if (['previoustrack', 'toggle', 'nexttrack'].includes(action)) mediaAction(action); });
ipcMain.on('tabs:show-playing', () => { if (nowTab && nowTab.host) { nowTab.host.activate(nowTab); nowTab.host.show(); } });
ipcMain.on('tabs:floating', e => { const h = hostOfBar(e.sender); setFloating(h, !h.floating); });
ipcMain.on('tabs:fullscreen', e => toggleWindowFullscreen(hostOfBar(e.sender)));
ipcMain.on('tabs:forward', e => goForward(hostOfBar(e.sender)));
ipcMain.on('tabs:home', e => { const h = [...hosts].find(x => x.bar.webContents === e.sender); goHome(h || mainHost); });
ipcMain.on('tabs:new', e => { const h = [...hosts].find(x => x.bar.webContents === e.sender); open(null, { inHost: h || mainHost }); });
ipcMain.on('tabs:detach', (_e, key, x, y) => { const t = tabByKey(key); if (t) detach(t, x != null ? { x, y } : null); });
ipcMain.on('tabs:attach', (_e, key) => { const t = tabByKey(key); if (t) attach(t); });
ipcMain.on('tabs:mute', (_e, key) => {
  const t = tabByKey(key);
  if (alive(t)) { t.view.webContents.setAudioMuted(!t.view.webContents.isAudioMuted()); t.host.updateBar(); }
});
ipcMain.on('tabs:move', (_e, key, index) => {
  const t = tabByKey(key);
  if (!t || !t.host) return;
  const h = t.host, i = h.tabs.indexOf(t);
  if (i < 0 || index === i) return;
  h.tabs.splice(i, 1);
  h.tabs.splice(Math.max(0, Math.min(index, h.tabs.length)), 0, t);
  h.updateBar();
  saveState();
});
ipcMain.on('tabs:menu', (_e, key) => {
  const t = tabByKey(key);
  if (!t) return;
  const h = t.host;
  Menu.buildFromTemplate([
    ...(h.main
      ? [{ label: 'Détacher dans une fenêtre', enabled: !!t.p, click: () => detach(t) }]
      : [{ label: 'Rattacher à la fenêtre principale', click: () => attach(t) }]),
    { label: 'Recharger', enabled: alive(t), click: () => t.view.webContents.reload() },
    { label: alive(t) && t.view.webContents.isAudioMuted() ? 'Remettre le son' : 'Couper le son', enabled: alive(t) && !!t.p,
      click: () => { t.view.webContents.setAudioMuted(!t.view.webContents.isAudioMuted()); h.updateBar(); } },
    { type: 'separator' },
    { label: 'Fermer l\'onglet', click: () => closeTab(t) },
  ]).popup({ window: h.win });
});

// ------------------------------------------------------------------
// Mode flottant : la fenêtre devient une petite vidéo toujours au premier plan, dans un coin de l'écran,
// pour regarder en faisant autre chose. Marche avec toutes les plateformes (même Netflix ou Disney+,
// qui interdisent l'image dans l'image du navigateur). Ctrl+Maj+F ou le bouton de la barre.
// ------------------------------------------------------------------
const FLOAT_BAR_H = 30;
function setFloating(host, on) {
  if (!host || host.win.isDestroyed() || !!host.floating === !!on) return;
  const win = host.win;
  if (on) {
    if (host.fullscreenTab && alive(host.fullscreenTab)) host.fullscreenTab.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    if (host.windowFullscreen) toggleWindowFullscreen(host);
    host.restoreBounds = win.getNormalBounds();
    host.restoreMax = win.isMaximized();
    if (host.restoreMax) win.unmaximize();
    host.floating = true;
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const saved = state.float || {};
    const W = Math.max(320, Math.min(saved.width || 480, area.width));
    const H = Math.max(200, Math.min(saved.height || 300, area.height));
    let x = saved.x ?? area.x + area.width - W - 20;
    let y = saved.y ?? area.y + area.height - H - 20;
    // toujours visible même si l'écran a changé
    x = Math.min(Math.max(x, area.x), area.x + area.width - W);
    y = Math.min(Math.max(y, area.y), area.y + area.height - H);
    win.setMinimumSize(320, 200);
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces?.(true);
    win.setBounds({ x, y, width: W, height: H });
  } else {
    host.floating = false;
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces?.(false);
    win.setMinimumSize(640, 420);
    if (host.restoreBounds) win.setBounds(host.restoreBounds);
    if (host.restoreMax) win.maximize();
  }
  host.layout();
  host.updateBar();
  buildTrayMenu();
}

// F11 : plein écran de la fenêtre (la barre reste accessible en haut).
function toggleWindowFullscreen(host) {
  if (!host || host.win.isDestroyed()) return;
  if (host.floating) setFloating(host, false);
  host.windowFullscreen = !host.windowFullscreen;
  host.win.setFullScreen(host.windowFullscreen || !!host.fullscreenTab);
  host.layout();
  host.updateBar();
}

// Met en pause toutes les vidéos (quand on ferme la fenêtre).
function pauseAll() {
  for (const t of allTabs()) {
    if (t.p && alive(t)) t.view.webContents.executeJavaScript('window.__pellicule && window.__pellicule.action("pause")', true).catch(() => {});
  }
  setTimeout(poll, 300);
}

// ------------------------------------------------------------------
// Suivi de la lecture : une lecture par seconde, partagée entre la barre, Discord et la barre des tâches.
// Avec plusieurs onglets, on suit celui qui joue (en priorité celui qu'on suivait déjà).
// ------------------------------------------------------------------
let lastBarNp = null;
async function poll() {
  const tabs = allTabs().filter(t => t.p && alive(t));
  const states = await Promise.all(tabs.map(async t => {
    try { return await t.view.webContents.executeJavaScript('window.__pellicule ? window.__pellicule.state() : null', true); }
    catch { return null; }
  }));
  const playingIdx = tabs.map((t, i) => (states[i] && states[i].playing ? i : -1)).filter(i => i >= 0);
  let idx = tabs.indexOf(nowTab);
  if (!(idx >= 0 && states[idx] && states[idx].playing)) {
    if (playingIdx.length) {
      // priorité à l'onglet affiché dans la fenêtre principale, sinon le premier qui joue
      const act = mainHost && mainHost.active;
      idx = playingIdx.find(i => tabs[i] === act) ?? playingIdx[0];
    } else if (!(idx >= 0 && states[idx] && states[idx].title)) {
      const act = mainHost && mainHost.active;
      idx = act && act.p ? tabs.indexOf(act) : (tabs.length ? 0 : -1);
    }
  }
  nowTab = idx >= 0 ? tabs[idx] : null;
  const p = nowTab && nowTab.p;
  nowPlaying = {
    title: null, artist: null, album: null, art: null, playing: false, position: null, duration: null,
    ...((idx >= 0 && states[idx]) || {}),
    platform: p ? { id: p.id, name: p.name, accent: p.accent, color: p.color } : null,
  };
  const barKey = JSON.stringify(npForBar());
  if (barKey !== lastBarNp) { lastBarNp = barKey; for (const h of hosts) h.updateBar(); }
  updateThumbar();
  discord.update(nowPlaying);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1000);
  poll();
}

// Commande de lecture (précédent / lecture-pause / suivant) sur l'onglet qui joue.
async function mediaAction(action) {
  if (!alive(nowTab)) return;
  try {
    await nowTab.view.webContents.executeJavaScript(`window.__pellicule && window.__pellicule.action(${JSON.stringify(action)})`, true);
  } catch {}
  setTimeout(poll, 150);
}

// Ce que la barre affiche de la vidéo en cours (uniquement s'il y a un titre).
function npForBar() {
  const np = nowPlaying;
  if (!np || !np.title || !np.platform) return null;
  return {
    title: np.title, artist: np.artist || '', playing: !!np.playing,
    platform: np.platform.name, accent: np.platform.accent,
    prev: !(np.can && np.can.prev === false), next: !(np.can && np.can.next === false),
  };
}

// Actualiser la page affichée (Ctrl+F5 = sans le cache).
function reloadActive(host = mainHost, hard = false) {
  const t = host && host.active;
  if (!alive(t)) return;
  if (hard && t.p) {
    // Ctrl+F5 : recharge en vidant aussi le cache interne du site (utile si une page reste bloquée)
    repairSite(t.p).then(() => { if (alive(t)) t.view.webContents.reloadIgnoringCache(); });
    return;
  }
  hard ? t.view.webContents.reloadIgnoringCache() : t.view.webContents.reload();
}

// Boutons ⏮ ⏯ ⏭ dans l'aperçu de la barre des tâches Windows .
const thumbIcon = n => nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'thumbar', `${n}.png`));
let thumbKey = null;
function updateThumbar(force = false) {
  const np = npForBar();
  const key = np ? `${np.playing}|${np.prev}|${np.next}` : 'none';
  if (!force && key === thumbKey) return;
  thumbKey = key;
  const buttons = np ? [
    { tooltip: 'Précédent', icon: thumbIcon('prev'), flags: np.prev ? [] : ['disabled'], click: () => mediaAction('previoustrack') },
    { tooltip: np.playing ? 'Pause' : 'Lecture', icon: thumbIcon(np.playing ? 'pause' : 'play'), click: () => mediaAction('toggle') },
    { tooltip: 'Suivant', icon: thumbIcon('next'), flags: np.next ? [] : ['disabled'], click: () => mediaAction('nexttrack') },
  ] : [];
  for (const h of hosts) {
    if (h.win.isDestroyed() || typeof h.win.setThumbarButtons !== 'function') continue;
    try { h.win.setThumbarButtons(buttons); } catch {}
  }
}

// ------------------------------------------------------------------
// Discord
// ------------------------------------------------------------------
function setDiscord(on) {
  state.discord = on;
  discord.setEnabled(on);
  saveState();
  buildTrayMenu();
}

// ------------------------------------------------------------------
// Démarrage avec Windows
// ------------------------------------------------------------------
const loginArgs = ['--hidden'];
const startsWithWindows = () => app.getLoginItemSettings({ args: loginArgs }).openAtLogin;
function setStartWithWindows(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: loginArgs });
  buildTrayMenu();
}

// ------------------------------------------------------------------
// Mises à jour automatiques (depuis les Releases GitHub)
// ------------------------------------------------------------------
let autoUpdater = null;
function setupUpdater() {
  if (!app.isPackaged) return; // pas de mise à jour en mode dev (npm start)
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log(`Updater indisponible : ${e}`); return; }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: m => log(`[maj] ${m}`), warn: m => log(`[maj] ${m}`), error: m => log(`[maj] ${m}`), debug() {} };

  const setStatus = s => { updateStatus = s; buildTrayMenu(); };
  autoUpdater.on('checking-for-update', () => setStatus('Recherche de mise à jour…'));
  autoUpdater.on('update-not-available', () => setStatus(''));
  autoUpdater.on('download-progress', p => setStatus(`Téléchargement de la mise à jour… ${Math.round(p.percent)} %`));
  autoUpdater.on('error', err => { log(`[maj] erreur : ${err && err.message}`); setStatus(''); });
  autoUpdater.on('update-downloaded', async info => {
    setStatus(`Mise à jour ${info.version} prête`);
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Pellicule',
      message: `La version ${info.version} de Pellicule est prête.`,
      detail: 'Redémarrer maintenant pour l\'installer ? Sinon elle s\'installera quand tu quitteras Pellicule.',
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) { quitting = true; autoUpdater.quitAndInstall(); }
  });

  const check = () => autoUpdater.checkForUpdates().catch(err => log(`[maj] ${err && err.message}`));
  setTimeout(check, 10_000);               // un peu après le lancement
  setInterval(check, 6 * 60 * 60 * 1000);  // puis toutes les 6 h
}

// ------------------------------------------------------------------
// Icône de la zone de notif
// ------------------------------------------------------------------
let lastTrayLabels = [];
function buildTrayMenu() {
  if (!tray) return;
  const act = mainHost && mainHost.active && mainHost.active.p ? mainHost.active : null;
  tray.setToolTip(act ? `Pellicule — ${act.p.name}` : 'Pellicule');
  const openIds = new Set(allTabs().filter(t => t.p).map(t => t.p.id));
  const template = [
    { label: 'Afficher', click: showWin },
    { label: 'Accueil', click: () => goHome() },
    {
      label: 'Mode flottant (petite fenêtre au premier plan)', type: 'checkbox', accelerator: 'Ctrl+Shift+F',
      checked: !!(mainHost && mainHost.floating), enabled: !!mainHost,
      click: item => { showWin(); setFloating(mainHost, item.checked); },
    },
    {
      label: 'Plateforme',
      submenu: [
        ...PLATFORMS.map(p => tabsMode()
          ? (p.multi
            ? { label: `${p.name} (nouvel onglet)`, click: () => open(p.id) }
            : { label: p.name, type: 'checkbox', checked: openIds.has(p.id), click: () => open(p.id) })
          : { label: p.name, type: 'radio', checked: !!act && act.p.id === p.id, click: () => open(p.id) }),
        { type: 'separator' },
        { label: 'Accueil', click: () => goHome() },
      ],
    },
    {
      label: 'Mode onglets',
      type: 'checkbox',
      checked: tabsMode(),
      click: item => setTabsMode(item.checked),
    },
    { label: 'Recharger', enabled: !!act, click: () => act && alive(act) && act.view.webContents.reload() },
    {
      label: 'Se déconnecter de cette plateforme',
      enabled: !!act,
      click: async () => {
        const p = act.p;
        await sessionFor(p).clearStorageData();
        delete state.lastUrls[p.id];
        if (alive(act)) act.view.webContents.loadURL(p.url);
      },
    },
    { type: 'separator' },
    {
      label: discord.available() ? 'Afficher sur Discord' : 'Afficher sur Discord (ID à remplir dans config.js)',
      type: 'checkbox',
      checked: !!state.discord && discord.available(),
      enabled: discord.available(),
      click: item => setDiscord(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Bloquer les pubs (YouTube, Twitch)',
      type: 'checkbox',
      checked: state.adblock !== false,
      click: item => setAdblock(item.checked),
    },
    {
      label: 'Pubs Twitch',
      enabled: state.adblock !== false,
      submenu: [
        { label: 'Bloquer (TwitchAdSolutions)', type: 'radio', checked: (state.twitchAds || 'vaft') === 'vaft', click: () => setTwitchAds('vaft') },
        { label: 'Couper le son et masquer', type: 'radio', checked: state.twitchAds === 'mute', click: () => setTwitchAds('mute') },
      ],
    },
    { type: 'separator' },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: app.isPackaged && startsWithWindows(),
      enabled: app.isPackaged,
      click: item => setStartWithWindows(item.checked),
    },
    {
      label: updateStatus || `Vérifier les mises à jour (v${app.getVersion()})`,
      enabled: app.isPackaged && !updateStatus,
      click: () => autoUpdater && autoUpdater.checkForUpdates().catch(() => {}),
    },
    { label: 'Ouvrir le journal des crashs', click: () => shell.openPath(logFile()) },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
  ];
  lastTrayLabels = template.map(i => i.label);
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

// --- IPC de l'écran de choix ---
ipcMain.handle('platforms', e => {
  const pickerTab = findTab(t => !t.p && alive(t) && t.view.webContents === e.sender);
  const host = pickerTab && pickerTab.host;
  const back = host && (host.previous && host.previous.p && host.tabs.includes(host.previous)
    ? host.previous : [...host.tabs].reverse().find(t => t.p));
  return {
    list: PLATFORMS.map(({ id, name, color, accent, note }) => ({ id, name, color, accent, note })),
    last: state.platform || null,
    open: [...new Set(allTabs().filter(t => t.p).map(t => t.p.id))],
    back: back ? { id: back.p.id, name: tabName(back) } : null,
  };
});
ipcMain.on('picker:back', e => {
  const pickerTab = findTab(t => !t.p && alive(t) && t.view.webContents === e.sender);
  if (pickerTab) leaveHome(pickerTab);
});
ipcMain.on('choose', (e, id) => {
  if (!byId(id)) return;
  const pickerTab = findTab(t => !t.p && alive(t) && t.view.webContents === e.sender);
  open(id, { inHost: pickerTab && pickerTab.host, replace: pickerTab });
});

// Une seule instance : relancer l'appli ramène la fenêtre existante.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWin());

  // Touches multimédia + contrôles Windows (SMTC).
  app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');
  // On garde les « client hints » (sec-ch-ua, navigator.userAgentData) : Netflix et Disney+ coupent la connexion
  // quand un navigateur se dit Chrome sans les envoyer. Ils annoncent la même version que le user agent.
  // Seules les pages de connexion Google les perdent (voir sessionFor), pour ne pas trahir l'appli.
  app.userAgentFallback = CHROME_UA;

  app.on('child-process-gone', (_e, d) => {
    if (d.type === 'GPU' && d.reason !== 'clean-exit') {
      for (const h of hosts) if (h.active && h.active.p) recover(h.active, `GPU: ${d.reason}`);
    }
  });

  app.whenReady().then(async () => {
    if (components && components.whenReady) await components.whenReady(); // module Widevine prêt (Electron Castlabs)
    log(`Widevine prêt : ${components ? JSON.stringify(components.status()) : 'n/a'} — v${app.getVersion()}`);
    loadState();

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16 }));
    tray.on('click', () => showWin());

    // Premier lancement => écran de choix ; ensuite on rouvre la (ou les) dernière(s) plateforme(s).
    const saved = tabsMode()
      ? (state.tabs || []).map(x => (typeof x === 'string' ? { id: x } : x)).filter(x => x && byId(x.id))
      : [];
    if (saved.length) {
      // à lire AVANT de rouvrir : chaque ouverture réenregistre l'état
      const idx = typeof state.activeTab === 'number' ? state.activeTab
        : Math.max(0, saved.findIndex(x => x.id === state.activeTab));
      const opened = saved.map(x => open(x.id, { url: x.url || undefined, background: true }));
      const act = opened[Math.min(idx, opened.length - 1)];
      if (act && act.host) { act.host.activate(act); showHost(act.host); }
    } else {
      open(byId(state.platform) ? state.platform : null);
    }
    startHidden = false;
    setupUpdater();

    discord.setLogger(log);
    if (state.discord === undefined) state.discord = false; // désactivé par défaut : ce que tu regardes reste privé
    if (state.discord && discord.available()) discord.setEnabled(true);
    startPolling();
    buildTrayMenu();
  }).catch(err => log(`Erreur au démarrage : ${err && err.stack || err}`));

  app.on('before-quit', () => { quitting = true; saveState(); discord.setEnabled(false); });
  app.on('window-all-closed', () => {}); // on reste dans la zone de notif
}

process.on('uncaughtException', err => log(`Exception non gérée : ${err.stack || err}`));

// Accès interne pour les tests automatiques uniquement.
if (process.env.PELLICULE_TEST) {
  global.__pelliculeTest = {
    open, detach, attach, closeTab, setTabsMode, poll, goHome, leaveHome, goBack, goForward, reloadActive, mediaAction, npForBar,
    setFloating, toggleWindowFullscreen, pauseAll, ua: CHROME_UA, trayLabels: () => lastTrayLabels,
    hosts: () => [...hosts], main: () => mainHost, tabs: allTabs, nowTab: () => nowTab, state: () => state,
  };
}
