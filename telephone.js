// App téléphone du planning. Chargé AVANT le code de la page (index.html du PC, repris tel quel) :
// - remplace le serveur du PC : les appels /api/… sont servis par le téléphone (copie dans le téléphone, marche sans réseau) ;
// - synchronise avec le dépôt GitHub privé Vexark/Planning-donnees (même fusion « à trois » que synchro.py sur le PC) ;
// - premier lancement : mot de passe choisi sur le PC → déchiffre la clé GitHub publiée dans acces.json ;
// - petit écran : la semaine s'affiche un jour à la fois (barre des 7 jours) ; bouton « Installer l'app ».
(() => {
  const API = 'https://api.github.com/repos/Vexark/Planning-donnees/contents/donnees.json';
  const DEPOT = 'https://api.github.com/repos/Vexark/Planning-donnees';
  const AUTEUR = { name: 'vexark', email: 'vexark@users.noreply.github.com' };
  const CLES = { etat: 'planning-tel-etat', base: 'planning-tel-base', jeton: 'planning-tel-jeton', revs: 'planning-tel-revisions', info: 'planning-tel-info' };
  const lire = (k) => { try { const t = localStorage.getItem(k); return t ? JSON.parse(t) : null; } catch { return null; } };
  const ecrire = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage plein ou bloqué */ } };

  // ------------------------------------------------------------------ fusion à trois (même logique que synchro.py)
  const MANQUE = Symbol('manque');
  const texte = (v) => (v === MANQUE ? '∅' : JSON.stringify(trie(v)));
  const trie = (v) => (Array.isArray(v) ? v.map(trie) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, trie(v[k])])) : v);
  const valeur = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : MANQUE);
  function fusionCles(base, a, b) {
    const res = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(base)])) {
      const va = valeur(a, k), vb = valeur(b, k), vo = valeur(base, k);
      let v;
      if (texte(va) === texte(vb) || texte(vb) === texte(vo)) v = va;
      else if (texte(va) === texte(vo)) v = vb;
      else v = va;
      if (v !== MANQUE) res[k] = v;
    }
    return res;
  }
  const parId = (l) => Object.fromEntries((l || []).filter((x) => x && typeof x === 'object' && 'id' in x).map((x) => [x.id, x]));
  function fusionListe(base, a, b) {
    const m = fusionCles(parId(base), parId(a), parId(b));
    const ia = Object.keys(parId(a)), ib = Object.keys(parId(b)), io = Object.keys(parId(base));
    const commun = new Set(ia.filter((i) => io.includes(i)));
    const reordonne = ia.filter((i) => commun.has(i)).join('|') !== io.filter((i) => commun.has(i)).join('|');
    const ordre = [...new Set([...(reordonne ? ia : ib), ...(reordonne ? ib : ia)])].filter((i) => i in m);
    return [...ordre.map((i) => m[i]), ...Object.keys(m).filter((i) => !ordre.includes(i)).map((i) => m[i])];
  }
  const LISTES = ['taches', 'recurrentes', 'liste'], DICTS = ['occurrences', 'reglages'];
  const sauf = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !LISTES.includes(k) && !DICTS.includes(k)));
  function fusion(base, a, b) {
    base = base || {}; a = a || {}; b = b || {};
    const res = fusionCles(sauf(base), sauf(a), sauf(b));
    for (const k of LISTES) res[k] = fusionListe(base[k], a[k], b[k]);
    for (const k of DICTS) res[k] = fusionCles(base[k] || {}, a[k] || {}, b[k] || {});
    return res;
  }
  const identiques = (a, b) => texte(a) === texte(b);

  // ------------------------------------------------------------------ copie du planning dans le téléphone (avec numéros de version)
  let etat = lire(CLES.etat) || { donnees: {}, rev: 0 };
  let revisions = lire(CLES.revs) || {};
  const local = () => etat.donnees;
  function enregistrerLocal(d) {
    etat = { donnees: d, rev: etat.rev + 1 };
    revisions[etat.rev] = d;
    for (const r of Object.keys(revisions)) if (Number(r) <= etat.rev - 20) delete revisions[r];
    ecrire(CLES.etat, etat);
    ecrire(CLES.revs, revisions);
  }

  // ------------------------------------------------------------------ « serveur » du téléphone : la page croit parler au PC
  const fetchReseau = window.fetch.bind(window);
  const reponse = (code, objet, entetes = {}) => new Response(JSON.stringify(objet), { status: code, headers: { 'Content-Type': 'application/json', ...entetes } });
  window.fetch = async (url, options = {}) => {
    const chemin = typeof url === 'string' ? url : url.url;
    if (!chemin.startsWith('/api/')) return fetchReseau(url, options);
    const methode = (options.method || 'GET').toUpperCase();
    if (chemin.startsWith('/api/donnees') && methode === 'GET') return reponse(200, local(), { 'X-Planning-Rev': String(etat.rev), 'X-Planning-Dossier': 'telephone' });
    if (chemin.startsWith('/api/donnees') && methode === 'PUT') {
      const d = JSON.parse(options.body);
      const revPage = (options.headers || {})['X-Planning-Rev'];
      let final = d;
      if (revPage !== undefined && revPage !== '' && Number(revPage) !== etat.rev) final = fusion(revisions[revPage] || {}, d, local());
      enregistrerLocal(final);
      programmerSynchro();
      return reponse(200, { ok: true, rev: etat.rev, ...(identiques(final, d) ? {} : { donnees: final }) });
    }
    if (chemin === '/api/rev') return reponse(200, { rev: etat.rev });
    return reponse(404, { erreur: 'disponible seulement sur le PC' });
  };

  // ------------------------------------------------------------------ synchronisation avec GitHub
  let info = lire(CLES.info) || { derniere: null, erreur: '' };
  let minuterie = null, enCours = false;
  const jeton = () => lire(CLES.jeton) || '';
  const versBase64 = (objet) => { let s = ''; for (const o of new TextEncoder().encode(JSON.stringify(objet, null, 1))) s += String.fromCharCode(o); return btoa(s); };
  const depuisBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  const github = (url, methode = 'GET', corps) => fetchReseau(url, {
    method: methode, cache: 'no-store',
    headers: { Authorization: `Bearer ${jeton()}`, Accept: 'application/vnd.github+json', ...(corps ? { 'Content-Type': 'application/json' } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  function programmerSynchro(delai = 2500) { clearTimeout(minuterie); minuterie = setTimeout(synchroniser, delai); majIndicateur('attente'); }

  async function synchroniser() {
    if (!jeton()) return majIndicateur();
    if (enCours) return programmerSynchro(3000);
    if (!navigator.onLine) { info.erreur = 'hors connexion : tes changements partiront au retour du réseau'; return majIndicateur(); }
    enCours = true;
    majIndicateur('cours');
    try {
      let fait = false;
      for (let essai = 0; essai < 4 && !fait; essai++) {
        const r = await github(API);
        let distant = null, sha;
        if (r.status === 200) { const j = await r.json(); distant = JSON.parse(depuisBase64(j.content)); sha = j.sha; }
        else if (r.status === 401) throw new Error('clé refusée par GitHub : reconfigure l’app téléphone sur le PC (Réglages)');
        else if (r.status === 404) { if ((await github(DEPOT)).status !== 200) throw new Error('la clé n’a pas accès au dépôt Planning-donnees'); }
        else throw new Error(`GitHub a répondu ${r.status}`);
        const lu = local(), revLue = etat.rev;
        const base = lire(CLES.base);
        // première synchronisation : en cas de différence, le planning du PC l'emporte (réglages compris)
        const fusionne = !distant ? lu : base ? fusion(base, lu, distant) : fusion(null, distant, lu);
        if (!distant || !identiques(fusionne, distant)) {
          const w = await github(API, 'PUT', { message: 'Planning modifié depuis le téléphone', content: versBase64(fusionne), committer: AUTEUR, author: AUTEUR, ...(sha ? { sha } : {}) });
          if (w.status === 409 || w.status === 422) continue; // le PC a écrit en même temps : on recommence
          if (!w.ok) throw new Error(`GitHub a refusé l’enregistrement (${w.status})`);
        }
        const final = etat.rev !== revLue ? fusion(lu, local(), fusionne) : fusionne; // modifié pendant l'envoi
        if (!identiques(final, lu)) { enregistrerLocal(final); window.dispatchEvent(new Event('focus')); }
        if (!identiques(final, fusionne)) programmerSynchro(1000);
        ecrire(CLES.base, fusionne);
        info = { derniere: new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), erreur: '' };
        fait = true;
      }
      if (!fait) throw new Error('trop d’enregistrements simultanés, nouvel essai bientôt');
    } catch (e) {
      info.erreur = e.message === 'Failed to fetch' ? 'réseau indisponible : nouvel essai bientôt' : e.message;
    } finally {
      enCours = false;
      ecrire(CLES.info, info);
      majIndicateur();
    }
  }
  window.addEventListener('online', () => programmerSynchro(500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') programmerSynchro(300); });
  setInterval(() => { if (document.visibilityState === 'visible') synchroniser(); }, 60_000);

  // ------------------------------------------------------------------ connexion : mot de passe → clé GitHub (déchiffrée dans le téléphone)
  async function dechiffrerAcces(mdp) {
    const r = await fetchReseau('acces.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('l’app téléphone n’est pas encore configurée sur le PC (Réglages → App téléphone)');
    const a = await r.json();
    const octets = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(mdp), 'PBKDF2', false, ['deriveKey']);
    const cle = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: octets(a.sel), iterations: a.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    try {
      const clair = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: octets(a.iv), additionalData: enc.encode('planning-semaine-v1') }, cle, octets(a.donnees));
      return new TextDecoder().decode(clair);
    } catch { throw new Error('mot de passe incorrect'); }
  }

  function ecranConnexion() {
    if (document.getElementById('tel-connexion')) return;
    const voile = document.createElement('div');
    voile.id = 'tel-connexion';
    voile.innerHTML = `<form class="tel-carte">
        <h2>Connecte ton planning</h2>
        <p>Tape le mot de passe choisi sur le PC (Réglages → App téléphone). Tu ne le feras qu’une fois : tes tâches seront ensuite les mêmes sur le PC et ici.</p>
        <input id="tel-mot-de-passe" type="password" autocomplete="current-password" placeholder="Mot de passe" required>
        <p class="tel-erreur" hidden></p>
        <button type="submit" class="principal">Connecter</button>
        <button type="button" class="lien" data-plus-tard>Plus tard (le planning reste seulement sur ce téléphone)</button>
      </form>`;
    document.body.append(voile);
    const erreur = voile.querySelector('.tel-erreur');
    voile.querySelector('[data-plus-tard]').addEventListener('click', () => voile.remove());
    voile.querySelector('form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const bouton = voile.querySelector('button[type=submit]');
      bouton.disabled = true; bouton.textContent = 'Connexion…'; erreur.hidden = true;
      try {
        ecrire(CLES.jeton, await dechiffrerAcces(voile.querySelector("#tel-mot-de-passe").value));
        voile.remove();
        await synchroniser();
      } catch (e) {
        erreur.textContent = e.message === 'Failed to fetch' ? 'Pas de réseau : réessaie avec une connexion.' : `Impossible : ${e.message}.`;
        erreur.hidden = false;
      }
      bouton.disabled = false; bouton.textContent = 'Connecter';
    });
  }

  // ------------------------------------------------------------------ indicateur dans l'en-tête et section des réglages
  function majIndicateur(mode) {
    const el = document.getElementById('tel-sync');
    if (!el) return;
    const connecte = !!jeton();
    el.className = 'tel-sync';
    if (!connecte) { el.textContent = '📱 Seulement ici'; el.title = 'Toucher pour connecter au PC'; el.classList.add('attention'); }
    else if (mode === 'cours') el.textContent = '⟳ Synchro…';
    else if (mode === 'attente') el.textContent = '⟳ À envoyer';
    else if (info.erreur) { el.textContent = '⚠ Pas synchronisé'; el.title = info.erreur; el.classList.add('attention'); }
    else { el.textContent = '✓ Synchronisé'; el.title = info.derniere ? `Dernière synchronisation : ${info.derniere}` : ''; }
    const zone = document.getElementById('tel-reglage');
    if (zone) {
      zone.querySelector('[data-etat]').textContent = !connecte ? 'Ce téléphone n’est pas encore connecté au planning du PC.'
        : `Connecté au planning du PC${info.derniere ? ` · dernière synchronisation : ${info.derniere}` : ''}${info.erreur ? ` · ⚠ ${info.erreur}` : ''}`;
      zone.querySelector('[data-connecter]').hidden = connecte;
      zone.querySelector('[data-synchro]').hidden = !connecte;
      zone.querySelector('[data-deconnecter]').hidden = !connecte;
    }
  }

  function installerInterface() {
    // pastille de synchronisation dans l'en-tête
    const actions = document.querySelector('header .actions');
    if (actions) {
      const pastille = document.createElement('button');
      pastille.type = 'button'; pastille.id = 'tel-sync';
      pastille.addEventListener('click', () => (jeton() ? synchroniser() : ecranConnexion()));
      actions.prepend(pastille);
    }
    // section « Synchronisation » dans les réglages
    const reglages = document.querySelector('#dlg-reglages .contenu');
    if (reglages) {
      const zone = document.createElement('fieldset');
      zone.className = 'champ'; zone.id = 'tel-reglage';
      zone.innerHTML = `<legend>📱 Synchronisation avec le PC</legend><p class="aide" data-etat style="margin:0;font-weight:400"></p>
        <div class="ligne"><button type="button" data-synchro>↻ Synchroniser maintenant</button><button type="button" data-connecter class="principal">Connecter au PC</button><button type="button" data-deconnecter class="danger">Déconnecter ce téléphone</button></div>`;
      reglages.querySelector('h2').after(zone);
      zone.querySelector('[data-synchro]').addEventListener('click', synchroniser);
      zone.querySelector('[data-connecter]').addEventListener('click', () => { document.getElementById('dlg-reglages').close(); ecranConnexion(); });
      zone.querySelector('[data-deconnecter]').addEventListener('click', () => {
        if (!confirm('Déconnecter ce téléphone ? Le planning reste affiché ici, mais ne se synchronise plus avec le PC.')) return;
        ecrire(CLES.jeton, null); ecrire(CLES.base, null); majIndicateur();
      });
    }
    majIndicateur();
    vueUnJour();
    aideInstallation();
    if (!jeton()) ecranConnexion(); else programmerSynchro(300);
  }

  // ------------------------------------------------------------------ petit écran : un jour à la fois
  let jourChoisi = null;
  function vueUnJour() {
    const grille = document.getElementById('grille');
    const zone = document.querySelector('.zone-grille');
    if (!grille || !zone) return;
    const barre = document.createElement('nav');
    barre.className = 'tel-jours'; barre.setAttribute('aria-label', 'Jour affiché');
    zone.before(barre);
    const appliquer = () => {
      const tetes = [...grille.querySelectorAll('.tete-jour[data-jour]')];
      if (!tetes.length) return;
      const jours = tetes.map((t) => t.dataset.jour);
      const auj = tetes.find((t) => t.classList.contains('aujourdhui'))?.dataset.jour;
      if (!jours.includes(jourChoisi)) jourChoisi = auj || jours[0];
      barre.innerHTML = tetes.map((t) => `<button type="button" data-jour="${t.dataset.jour}" class="${t.dataset.jour === jourChoisi ? 'actif' : ''}${t.classList.contains('aujourdhui') ? ' aujourdhui' : ''}${t.classList.contains('complet') ? ' complet' : ''}">
        <span>${t.querySelector('.nom')?.textContent || ''}</span><b>${t.querySelector('.num')?.textContent || ''}</b><small>${t.querySelector('.compte')?.textContent.trim() || ''}</small></button>`).join('');
      for (const el of grille.querySelectorAll('[data-date], [data-jour]')) el.classList.toggle('tel-choisi', (el.dataset.date || el.dataset.jour) === jourChoisi);
    };
    barre.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-jour]');
      if (!b) return;
      jourChoisi = b.dataset.jour;
      appliquer();
    });
    new MutationObserver(appliquer).observe(grille, { childList: true });
    appliquer();
  }

  // ------------------------------------------------------------------ installation (bouton « Installer l'app »)
  function aideInstallation() {
    if (matchMedia('(display-mode: standalone)').matches) return;
    const zone = document.createElement('div');
    zone.className = 'tel-installer'; zone.hidden = true;
    document.body.append(zone);
    let proposition = null;
    const fermer = '<button type="button" class="lien" data-fermer-install>Plus tard</button>';
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); proposition = e;
      zone.innerHTML = `<b>Installe le planning sur ton téléphone</b><span>Icône dans tes applications, plein écran, marche sans réseau.</span><div class="ligne"><button type="button" class="principal" data-installer>📲 Installer l’app</button>${fermer}</div>`;
      zone.hidden = false;
    });
    window.addEventListener('appinstalled', () => { zone.hidden = true; });
    zone.addEventListener('click', async (ev) => {
      if (ev.target.closest('[data-fermer-install]')) zone.hidden = true;
      if (ev.target.closest('[data-installer]') && proposition) { proposition.prompt(); await proposition.userChoice.catch(() => null); proposition = null; zone.hidden = true; }
    });
    setTimeout(() => {
      if (proposition || document.getElementById('tel-connexion')) return;
      const integre = /Instagram|FBAN|FBAV|WhatsApp|Snapchat|TikTok|; wv\)/.test(navigator.userAgent);
      zone.innerHTML = `<b>Pour installer l’app</b><span>${integre ? 'Ce lien est ouvert dans une autre application : touche ⋮ puis « Ouvrir dans Chrome ».' : 'Menu ⋮ de Chrome → « Ajouter à l’écran d’accueil » → « Installer ».'}</span><div class="ligne">${fermer}</div>`;
      zone.hidden = false;
    }, 8000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installerInterface);
  else installerInterface();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.planningTelephone = { synchroniser, fusion }; // pour les tests
})();
