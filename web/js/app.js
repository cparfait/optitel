/* App — routeur, filtres globaux, drawer, toasts */

/* Session expirée : le serveur répond 401 sur /api/*. Sans cette interception,
   une session échue se traduisait par un écran d'erreur illisible au milieu de
   l'application. On enveloppe fetch une fois pour toutes, plutôt que de traiter
   le cas dans chaque appel — et pour que le code écrit plus tard en hérite. */
(function () {
  const raw = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const r = await raw(input, init);
    if (r.status === 401) {
      const back = location.pathname + location.search + location.hash;
      location.href = '/login?next=' + encodeURIComponent(back);
    }
    return r;
  };
})();

(function () {
  const F = window.fmt, S = window.Store;

  const App = {
    route: 'dashboard',
    params: {},

    async init() {
      // chargement
      const view = document.getElementById('view');
      view.innerHTML = `<div class="loading-view"><div class="spinner"></div><div>Chargement du dataset…</div></div>`;
      try {
        await S.load();
        await S.loadMigration();
      } catch (e) {
        view.innerHTML = `<div class="loading-view" style="color:var(--red)">
          <div>${Icons.svg('alert')}</div>
          <div><b>Impossible de joindre le serveur.</b><br>Lancez <code>python server.py</code> puis rechargez.</div></div>`;
        return;
      }
      this.buildFilters();
      this.bindShell();
      this.routeFromHash();
      this.fillEntity();
      this.fillUser();
      window.addEventListener('hashchange', () => this.routeFromHash());
    },

    buildFilters() {
      const accSel = document.getElementById('f-account');
      (S.data.accounts || []).forEach(a => {
        const o = document.createElement('option');
        o.value = a.id;
        const m = (a.marches || []).slice(-1)[0];
        o.textContent = `${a.id} · ${m ? m.label.replace('MARCHE ', '') : 'compte'}`;
        accSel.appendChild(o);
      });
      accSel.value = S.account;
      accSel.addEventListener('change', () => {
        S.account = accSel.value;
        // la plage retenue doit rester dans les mois du nouveau compte
        const ms = S.accountMonths();
        if (S.rangeFrom && !ms.includes(S.rangeFrom)) S.rangeFrom = null;
        if (S.rangeTo && !ms.includes(S.rangeTo)) S.rangeTo = null;
        const vs = S.visibleMonths();
        if (!vs.includes(S.month)) S.month = vs[vs.length - 1];
        this.rebuildRangePicker();
        this.rebuildMonthSelect();
        this.render();
      });

      this.buildRangePicker();

      // parc : seulement ce qui est facturé sur la dernière facture de son compte
      const actBtn = document.getElementById('f-active');
      actBtn.addEventListener('click', () => {
        S.activeOnly = !S.activeOnly;
        this.syncActiveSwitch();
        // la vue Lignes a son propre sélecteur de parc : on l'aligne sur le switch
        if (window.Views.lines.setLife) {
          window.Views.lines.setLife(S.activeOnly ? 'active' : 'all');
        }
        this.render();
        window.toast(S.activeOnly
          ? 'Parc limité aux lignes en service sur la dernière facture'
          : 'Toutes les lignes affichées, y compris résiliées');
      });
      this.syncActiveSwitch();
      this.rebuildMonthSelect();
    },

    syncActiveSwitch() {
      const b = document.getElementById('f-active');
      b.classList.toggle('on', S.activeOnly);
      b.setAttribute('aria-checked', S.activeOnly ? 'true' : 'false');
    },

    /* ───────────────────────────────────────────────────────────────
       Sélecteur de période : presets rapides + calendrier de mois.
       Clic 1 = mois de début, clic 2 = mois de fin, la plage s'applique.
       ─────────────────────────────────────────────────────────────── */
    buildRangePicker() {
      const btn = document.getElementById('f-range');
      btn.addEventListener('click', () => this.toggleRangePicker());
      const pop = document.createElement('div');
      pop.className = 'range-pop';
      pop.id = 'range-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'Choisir la période analysée');
      document.body.appendChild(pop);
      this._rangePop = pop;
      // fermeture au clic extérieur
      document.addEventListener('mousedown', e => {
        if (pop.classList.contains('open') &&
            !pop.contains(e.target) && !btn.contains(e.target)) {
          this.closeRangePicker();
        }
      });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && pop.classList.contains('open')) this.closeRangePicker();
      });
      window.addEventListener('resize', () => { if (pop.classList.contains('open')) this.closeRangePicker(); });
      this.rebuildRangePicker();
      this.syncRangeLabel();
    },

    toggleRangePicker() {
      const pop = this._rangePop;
      if (!pop) return;
      if (pop.classList.contains('open')) { this.closeRangePicker(); return; }
      this.rebuildRangePicker();      // reconstruit au cas où les mois ont changé
      pop.classList.add('open');
      document.getElementById('f-range').setAttribute('aria-expanded', 'true');
      // ancrage sous le bouton, aligné à droite
      const r = document.getElementById('f-range').getBoundingClientRect();
      const w = Math.min(pop.offsetWidth || 460, window.innerWidth - 16);
      pop.style.top = (r.bottom + 8) + 'px';
      pop.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
      // état de sélection temporaire = plage courante
      this._selStart = S.rangeFrom;
      this._selEnd = S.rangeTo;
      this.paintRangeCalendar();
    },

    closeRangePicker() {
      const pop = this._rangePop;
      if (!pop) return;
      pop.classList.remove('open');
      document.getElementById('f-range').setAttribute('aria-expanded', 'false');
    },

    /* Presets disponibles selon les mois facturés du compte courant. */
    rangePresets() {
      const ms = S.accountMonths();
      if (!ms.length) return [];
      const last = ms[ms.length - 1];
      const idx = m => ms.indexOf(m);
      const presets = [
        { id: 'all', label: 'Tout', from: null, to: null },
        { id: '3', label: '3 mois', from: ms[Math.max(0, ms.length - 3)], to: last },
        { id: '6', label: '6 mois', from: ms[Math.max(0, ms.length - 6)], to: last },
        { id: '12', label: '12 mois', from: ms[Math.max(0, ms.length - 12)], to: last },
      ];
      // années civiles couvertes par les factures
      const years = [...new Set(ms.map(m => m.slice(0, 4)))].sort();
      years.forEach(y => {
        const yms = ms.filter(m => m.startsWith(y));
        if (yms.length >= 3) {   // une année à peine entamée n'aide pas la lecture
          presets.push({ id: 'Y' + y, label: y, from: yms[0], to: yms[yms.length - 1] });
        }
      });
      return presets;
    },

    rebuildRangePicker() {
      const pop = this._rangePop;
      if (!pop) return;
      const ms = S.accountMonths();
      const years = [...new Set(ms.map(m => m.slice(0, 4)))].sort();
      const MONTH_SHORT = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

      pop.innerHTML = `
        <div class="rp-presets">
          ${this.rangePresets().map(p =>
            `<button class="chip" data-preset="${p.id}">${p.label}</button>`).join('')}
        </div>
        <div class="rp-cal">
          ${years.map(y => `
            <div class="rp-year" data-year="${y}">
              <div class="rp-year-label">${y}</div>
              <div class="rp-months">
                ${MONTH_SHORT.map((lb, i) => {
                  const mk = `${y}-${String(i + 1).padStart(2, '0')}`;
                  const has = ms.includes(mk);
                  return `<button class="rp-month${has ? '' : ' off'}" data-m="${mk}"
                          ${has ? '' : 'disabled'} title="${has ? F.monthLabel(mk) : 'aucune facture'}">${lb}</button>`;
                }).join('')}
              </div>
            </div>`).join('')}
        </div>
        <div class="rp-foot">
          <span class="rp-hint" id="rp-hint">Cliquez un mois de <b>début</b> puis un mois de <b>fin</b></span>
          <div class="flex" style="gap:6px">
            <button class="btn btn-ghost btn-sm" id="rp-clear">Effacer</button>
            <button class="btn btn-sm btn-primary" id="rp-apply">Appliquer</button>
          </div>
        </div>`;

      pop.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
        const p = this.rangePresets().find(x => x.id === b.dataset.preset);
        if (!p) return;
        S.rangeFrom = p.from; S.rangeTo = p.to;
        this._selStart = p.from; this._selEnd = p.to;
        this.paintRangeCalendar();
        this.syncRangeLabel();
        this.applyRange(false);
      }));
      pop.querySelectorAll('.rp-month:not(.off)').forEach(b => {
        b.addEventListener('click', () => this.onMonthClick(b.dataset.m));
        b.addEventListener('mouseenter', () => this.paintRangeCalendar(b.dataset.m));
      });
      pop.querySelector('#rp-clear').addEventListener('click', () => {
        S.rangeFrom = S.rangeTo = null;
        this._selStart = this._selEnd = null;
        this.paintRangeCalendar();
        this.syncRangeLabel();
        this.applyRange(false);
      });
      pop.querySelector('#rp-apply').addEventListener('click', () => {
        S.rangeFrom = this._selStart || null;
        S.rangeTo = this._selEnd || null;
        this.applyRange(true);
      });
    },

    onMonthClick(mk) {
      if (!this._selStart || (this._selStart && this._selEnd)) {
        // nouveau départ
        this._selStart = mk; this._selEnd = null;
      } else {
        // deuxième clic = fin (réordonne si besoin)
        this._selEnd = mk < this._selStart ? this._selStart : mk;
        if (mk < this._selStart) this._selStart = mk;
        S.rangeFrom = this._selStart;
        S.rangeTo = this._selEnd;
        this.syncRangeLabel();
        this.applyRange(true);
        return;
      }
      this.paintRangeCalendar();
      const hint = document.getElementById('rp-hint');
      if (hint) hint.innerHTML = `Début : <b>${F.monthLabel(this._selStart)}</b> — choisissez le mois de fin`;
    },

    /* Repeint le calendrier : plage appliquée, sélection en cours, survol.
       Attention : 'YYYY-MM' se compare en chaînes, jamais via Math.min/max
       (qui rendraient NaN sur ce format). */
    paintRangeCalendar(hoverM) {
      const pop = this._rangePop;
      if (!pop) return;
      const a = this._selStart, b = this._selEnd;
      const h = hoverM && a && !b ? hoverM : null;
      const lo = h ? (a < h ? a : h) : (b ? (a < b ? a : b) : a);
      const hi = h ? (a < h ? h : a) : (b ? (a < b ? b : a) : a);
      pop.querySelectorAll('.rp-month').forEach(el => {
        const m = el.dataset.m;
        el.classList.toggle('in-range', !!a && m >= lo && m <= hi);
        el.classList.toggle('sel-start', !!a && m === a);
        el.classList.toggle('sel-end', !!b && m === b);
      });
      pop.querySelectorAll('[data-preset]').forEach(el => {
        const p = this.rangePresets().find(x => x.id === el.dataset.preset);
        el.classList.toggle('on', !!p &&
          (p.from || null) === (S.rangeFrom || null) &&
          (p.to || null) === (S.rangeTo || null));
      });
    },

    /* Applique la plage : reclamp le mois affiché, met à jour les vues. */
    applyRange(close) {
      const vs = S.visibleMonths();
      if (vs.length && !vs.includes(S.month)) S.month = vs[vs.length - 1];
      this.syncRangeLabel();
      this.rebuildMonthSelect();
      this.render();
      if (close) setTimeout(() => this.closeRangePicker(), 140);
    },

    /* Libellé du bouton : nom du preset si la plage correspond, sinon bornes. */
    syncRangeLabel() {
      const el = document.getElementById('f-range-label');
      if (!el) return;
      if (!S.rangeFrom && !S.rangeTo) { el.textContent = 'Tout'; return; }
      const p = this.rangePresets().find(x =>
        (x.from || null) === (S.rangeFrom || null) && (x.to || null) === (S.rangeTo || null));
      if (p) { el.textContent = p.label; return; }
      if (!S.rangeFrom) el.textContent = `jusqu'à ${F.monthLabelShort(S.rangeTo)}`;
      else if (!S.rangeTo) el.textContent = `depuis ${F.monthLabelShort(S.rangeFrom)}`;
      else el.textContent = `${F.monthLabelShort(S.rangeFrom)} → ${F.monthLabelShort(S.rangeTo)}`;
    },

    afterRangeChange() {
      const ms = S.visibleMonths();
      if (ms.length && !ms.includes(S.month)) S.month = ms[ms.length - 1];
      this.syncRangeLabel();
      this.rebuildMonthSelect();
      this.render();
    },

    rebuildMonthSelect() {
      const sel = document.getElementById('f-month');
      const ms = S.visibleMonths();
      sel.innerHTML = ms.map(m => `<option value="${m}">${F.monthLabel(m)}</option>`).join('');
      if (S.month && ms.includes(S.month)) sel.value = S.month;
      else S.month = ms[ms.length - 1];
      sel.onchange = () => { S.month = sel.value; this.render(); };
    },

    bindShell() {
      document.getElementById('search-btn').addEventListener('click', () => window.Search.show());
      document.getElementById('menu-btn').addEventListener('click', () =>
        document.getElementById('sidebar').classList.toggle('open'));
      document.getElementById('drawer-close').addEventListener('click', closeDrawer);
      document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
    },

    routeFromHash() {
      const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
      const [name, qs] = h.split('?');
      this.route = name || 'dashboard';
      this.params = {};
      if (qs) qs.split('&').forEach(p => {
        const [k, v] = p.split('=');
        this.params[k] = decodeURIComponent(v || '');
      });
      document.querySelectorAll('.nav-item').forEach(a =>
        a.classList.toggle('active', a.dataset.route === this.route));
      if (!window.Views[this.route]) this.route = 'dashboard';
      // Les paramètres d'URL s'appliquent à la navigation, pas à chaque rendu :
      // `render()` est aussi déclenché par un redimensionnement ou un changement
      // de filtre global, où réinitialiser écraserait la sélection de l'utilisateur.
      // Sans remise à zéro ici, revenir sur Lignes par le menu rouvrait la vue
      // sur le dernier filtre d'anomalie suivi depuis une alerte.
      const v = window.Views[this.route];
      if (v.setFilter) v.setFilter(this.params.filter || null);
      if (v.setQuery) v.setQuery(this.params.q || '');
      this.render();
      document.getElementById('sidebar').classList.remove('open');
      document.querySelector('.content').scrollTop = 0;
    },

    render() {
      const v = window.Views[this.route];
      if (!v) return;
      document.getElementById('page-title').textContent = v.title || '';
      const ms = S.visibleMonths();
      const T = S.periodTotals();
      document.getElementById('page-sub').textContent =
        ms.length ? `${F.monthLabelShort(ms[0])} → ${F.monthLabelShort(ms[ms.length - 1])} · ${F.eur(T.ht, 0)} HT cumulés` : '';
      const view = document.getElementById('view');
      view.innerHTML = '';
      try {
        v.render(view);
      } catch (e) {
        console.error(e);
        view.innerHTML = `<div class="wrap"><div class="card"><div class="empty" style="color:var(--red)">
          ${Icons.svg('alert')}<div><b>Erreur d'affichage :</b> ${F.esc(e.message)}</div></div></div></div>`;
      }
      // ré-injecte les icônes dynamiques
      document.querySelectorAll('#view span, #view button, #view div').forEach(el => {
        const txt = (el.childNodes.length === 1 && el.textContent || '').trim();
        if (/^svg:[\w-]+$/.test(txt)) el.innerHTML = Icons.svg(txt.slice(4));
      });
    },

    refresh() {
      this.fillEntity();
      this.rebuildRangePicker();
      this.syncRangeLabel();
      this.rebuildMonthSelect();
      this.render();
    },

    /* Identité connectée + rappel visible tant que le compte livré par défaut
       n'a pas été remplacé : un mot de passe « test » oublié en production ne
       doit pas pouvoir passer inaperçu. */
    async fillUser() {
      let me;
      try {
        me = await (await fetch('/api/me', { cache: 'no-store' })).json();
      } catch (e) { return; }
      if (!me || !me.user) return;
      const row = document.getElementById('user-row');
      document.getElementById('user-name').textContent = me.user;
      row.hidden = false;
      row.querySelectorAll('span, a').forEach(el => {
        const t = (el.childNodes.length === 1 && el.textContent || '').trim();
        if (/^svg:[\w-]+$/.test(t)) el.innerHTML = Icons.svg(t.slice(4));
      });
      if (me.defaultCredentials) {
        window.toast('Compte par défaut test/test — à remplacer avant usage réel', 'err');
      }
    },

    fillEntity() {
      document.getElementById('entity-name').textContent = 'Commune de Châtillon';
      const n = S.data.meta.counts;
      document.getElementById('entity-meta').innerHTML =
        `${n.invoices} factures · ${n.lines} lignes<br>${n.sites} sites télécoms`;
      document.getElementById('dataset-meta').innerHTML =
        `Dataset généré le ${new Date(S.data.meta.generatedAt).toLocaleString('fr-FR')}<br>` +
        `${S.data.months.length} mois · Orange Business`;
      const badge = document.getElementById('nav-lines-count');
      if (badge) badge.textContent = S.activeLines().length || '';
      const cu = document.getElementById('nav-copper-count');
      if (cu) cu.textContent = S.copperLines().length || '';
    },
  };

  function closeDrawer() {
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('drawer-backdrop').classList.remove('open');
  }

  window.toast = function (msg, kind) {
    const t = document.createElement('div');
    t.className = `toast t-${kind || 'ok'}`;
    t.innerHTML = `${Icons.svg(kind === 'err' ? 'alert' : 'check-c')}<span>${msg}</span>`;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 3200);
  };

  window.addEventListener('resize', (() => {
    let t;
    return () => { clearTimeout(t); t = setTimeout(() => App.render(), 220); };
  })());

  window.App = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})();
