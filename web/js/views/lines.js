/* Vue — Lignes : inventaire complet, filtres, tri, drawer détail */
(function () {
  const F = window.fmt, C = window.Charts, S = window.Store;

  const FAM_ORDER = ['t0', 't0_ascenseur', 'numeris', 'canal_sda', 'residentiel', 'internet'];
  const FAM_LABELS = {
    t0: 'T0 analogique', t0_ascenseur: 'T0 ascenseur', numeris: 'Numéris accès base',
    canal_sda: 'Canal / SDA', residentiel: 'Résidentiel', internet: 'Accès internet', autre: 'Autre',
  };
  const FAM_BADGE = { t0: 'b-t0', t0_ascenseur: 'b-asc', numeris: 'b-num', canal_sda: 'b-sda', residentiel: 'b-res', internet: 'b-web', autre: 'b-mut' };

  const state = {
    // par défaut on ne montre que le parc réellement en service : les lignes
    // résiliées restent consultables via le filtre « cycle de vie ».
    q: '', fams: new Set(), status: 'all', life: 'active', sort: 'net', dir: -1,
    onlyAttached: false,
  };

  const LIFE_LABELS = {
    active: 'en service', copper: 'cuivre en service, à migrer',
    ended: 'résiliées / transférées', all: 'tout l\'historique',
  };

  function famBadge(fam) {
    return `<span class="badge ${FAM_BADGE[fam] || 'b-mut'}">${FAM_LABELS[fam] || fam}</span>`;
  }

  function lineStatus(l) {
    if (l.isTerminated) {
      return `<span class="row-status" title="Dernière facturation : ${F.monthLabel(l.endedAt)}">
        <span class="dot dot-off"></span>résiliée ${F.monthLabelShort(l.endedAt)}</span>`;
    }
    const v = l.months[S.month];
    if (!v) return `<span class="row-status"><span class="dot dot-off"></span>absente ce mois</span>`;
    // un accès internet ne passe pas d'appels : « sans conso » n'y veut rien dire
    if (S.NO_TRAFFIC_BY_DESIGN.has(l.family)) {
      return `<span class="row-status"><span class="dot dot-ok"></span>en service</span>`;
    }
    if ((v.calls || 0) === 0) return `<span class="row-status"><span class="dot dot-warn"></span>sans conso</span>`;
    return `<span class="row-status"><span class="dot dot-ok"></span>active</span>`;
  }

  /* Un tableau vide sur un filtre d'anomalie est un bon résultat, pas une erreur :
     le message doit le dire, sinon on croit à un bug. */
  function emptyState() {
    if (state.q || state.fams.size) {
      return { ico: 'search', msg: 'Aucune ligne ne correspond aux filtres.' };
    }
    if (state.status === 'netconso') {
      return { ico: 'check-c', msg: '<b>Aucun accès internet ne facture de consommation</b> sur la période — ' +
        'rien à corriger de ce côté.' };
    }
    if (state.status === 'dormant') {
      return { ico: 'check-c', msg: '<b>Aucune ligne voix dormante</b> : toutes ont émis au moins un appel.' };
    }
    if (state.status === 'noconso') {
      return { ico: 'check-c', msg: '<b>Aucune ligne voix sans consommation</b> sur le mois affiché.' };
    }
    return { ico: 'search', msg: 'Aucune ligne ne correspond aux filtres.' };
  }

  /* Résumé du rattachement, en une ligne de tableau. */
  function attachCell(l) {
    if (l.attachedTo) {
      return `<span class="badge b-mut">${Icons.svg('link')} ${F.esc(l.attachedTo)}</span>`;
    }
    if (l.family === 'numeris') {
      const n = (l.channels || []).length || l.sdaCount;
      return n ? `<span class="badge b-sda" title="Canaux et SDA portés par cet accès de base"
        >${n} canal${n > 1 ? 'aux' : ''} / SDA</span>` : '<span class="text-muted">—</span>';
    }
    if (l.family === 'internet') {
      const n = (l.sharedWith || []).length;
      return n ? `<span class="badge b-mut" title="Lignes voix situées dans le même bâtiment"
        >${Icons.svg('link')} ${n} ligne${n > 1 ? 's' : ''}</span>` : '<span class="text-muted">—</span>';
    }
    if (l.siteInternet) {
      return `<span class="badge b-net" title="Accès internet du même bâtiment">${Icons.svg('wifi')} ${F.esc(l.siteInternet)}</span>`;
    }
    return '<span class="text-muted">—</span>';
  }

  function filtered(lines) {
    const mk = S.month;
    const dormantKeys = state.status === 'dormant'
      ? new Set(S.linesDormant().map(l => l.key)) : null;
    const netConsoKeys = state.status === 'netconso'
      ? new Set(S.internetWithConso().map(x => x.line.key)) : null;
    let out = lines.filter(l => {
      if (state.life === 'active' && !l.isActive) return false;
      if (state.life === 'ended' && !l.isTerminated) return false;
      if (state.life === 'copper' && !(l.isActive && l.isCopper)) return false;
      if (state.fams.size && !state.fams.has(l.family)) return false;
      if (state.onlyAttached && !l.attachedTo && !l.siteInternet &&
          !(l.channels || []).length && !(l.sharedWith || []).length) return false;
      if (state.q) {
        const q = state.q.toLowerCase();
        // nom d'usage inclus : chercher le nom qu'on a donné à un site doit
        // ramener ses lignes, pas seulement le nom porté par la facture
        const hay = [l.number, F.siteOverride(l), l.siteName, l.siteDept,
          l.siteAddress, l.siteId, l.familyLabel, l.attachedTo,
          l.siteInternet].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const v = l.months[mk];
      const byDesign = S.NO_TRAFFIC_BY_DESIGN.has(l.family);
      if (state.status === 'noconso' && (byDesign || !v || (v.calls || 0) > 0)) return false;
      if (state.status === 'dormant' && !dormantKeys.has(l.key)) return false;
      if (state.status === 'netconso' && !netConsoKeys.has(l.key)) return false;
      if (state.status === 'conso' && (!v || (v.calls || 0) === 0)) return false;
      if (state.status === 'dead' && v) return false;
      return true;
    });
    const key = state.sort;
    out.sort((a, b) => {
      let va, vb;
      if (key === 'number') { va = a.number || ''; vb = b.number || ''; return va.localeCompare(vb) * state.dir; }
      if (key === 'site') { va = a.siteName || ''; vb = b.siteName || ''; return va.localeCompare(vb) * state.dir; }
      if (key === 'family') { va = FAM_ORDER.indexOf(a.family); vb = FAM_ORDER.indexOf(b.family); return (va - vb) * state.dir; }
      // Trier sur la valeur affichée : les colonnes montrent des moyennes
      // mensuelles, trier sur le cumul mettrait une ligne présente 13 mois
      // au-dessus d'une ligne plus chère mais résiliée au bout de trois.
      if (key === 'calls') { va = a.totals.calls; vb = b.totals.calls; }
      else if (key === 'conso') { va = a.totals.avgConso; vb = b.totals.avgConso; }
      else { va = a.totals.avgAbo; vb = b.totals.avgAbo; }
      return (va - vb) * state.dir;
    });
    return out;
  }

  function render(view) {
    // cette vue a son propre sélecteur de parc : elle part du jeu complet
    const lines = S.allLines();
    const months = S.visibleMonths();
    const rows = filtered(lines);
    // les compteurs par type doivent refléter le parc choisi, pas tout l'historique
    const scope = lines.filter(l =>
      state.life === 'all' ||
      (state.life === 'active' && l.isActive) ||
      (state.life === 'ended' && l.isTerminated) ||
      (state.life === 'copper' && l.isActive && l.isCopper));
    const famCounts = {};
    scope.forEach(l => { famCounts[l.family] = (famCounts[l.family] || 0) + 1; });

    const attachedCount = scope.filter(l => l.attachedTo).length;
    const netTotal = rows.reduce((a, l) => a + l.totals.abo, 0);
    // le coût qui compte pour un arbitrage est celui encore facturé aujourd'hui
    const monthlyNow = rows.reduce((a, l) => a + (l.isActive ? l.lastNet : 0), 0);

    view.innerHTML = `
      <div class="wrap">
        <div class="card mb-2">
          <div class="flex" style="flex-wrap:wrap;gap:12px">
            <div class="field grow" style="max-width:340px">
              <label>Recherche</label>
              <input type="search" id="lq" placeholder="N° de ligne, site, accès…" value="${F.esc(state.q)}">
            </div>
            <div class="field">
              <label>Au mois de</label>
              <div class="flex" style="height:34px">${F.monthLabel(S.month)}</div>
            </div>
            <div class="field">
              <label>Parc</label>
              <select id="llife">
                <option value="active">En service</option>
                <option value="copper">En service — cuivre à migrer</option>
                <option value="ended">Résiliées / transférées</option>
                <option value="all">Tout l'historique</option>
              </select>
            </div>
            <div class="field">
              <label>Affichage</label>
              <select id="lstatus">
                <option value="all">Toutes les lignes</option>
                <option value="conso">Avec consommation</option>
                <option value="noconso">Sans conso ce mois (voix)</option>
                <option value="dormant">Dormantes sur la période (voix)</option>
                <option value="netconso">Accès internet avec consommation</option>
                <option value="dead">Absentes du mois</option>
              </select>
            </div>
            <div class="field">
              <label>&nbsp;</label>
              <label class="chip ${state.onlyAttached ? 'on' : ''}" id="lattach" style="height:34px;display:inline-flex;align-items:center">
                ${Icons.svg('link')} Rattachées / accès
              </label>
            </div>
          </div>
          <div class="chip-row mt-2" id="fams">
            <span class="chip ${state.fams.size === 0 ? 'on' : ''}" data-fam="">Tous <span class="cnt">${scope.length}</span></span>
            ${FAM_ORDER.filter(f => famCounts[f]).map(f => `
              <span class="chip ${state.fams.has(f) ? 'on' : ''}" data-fam="${f}">${FAM_LABELS[f]} <span class="cnt">${famCounts[f]}</span></span>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>${rows.length} ligne${rows.length > 1 ? 's' : ''} · ${LIFE_LABELS[state.life]}
              · ${monthlyNow > 0 ? `${F.eur(monthlyNow)} / mois` : `${F.eur(netTotal)} cumulés`}</span>
            <span class="hint">cliquez une ligne pour le détail · ${attachedCount} canaux rattachés à un accès</span>
          </div>
          <div class="tbl-wrap">
            <table class="tbl" id="ltbl">
              <thead><tr>
                <th class="sortable" data-k="number">N° de ligne <span class="arr"></span></th>
                <th class="sortable" data-k="family">Type <span class="arr"></span></th>
                <th class="sortable" data-k="site">Site <span class="arr"></span></th>
                <th>Rattachement</th>
                <th class="num sortable" data-k="net">Abo net / mois <span class="arr"></span></th>
                <th class="num sortable" data-k="conso">Conso / mois <span class="arr"></span></th>
                <th class="num sortable" data-k="calls">Appels <span class="arr"></span></th>
                <th>Tendance abo</th>
                <th>Statut</th>
              </tr></thead>
              <tbody id="lbody"></tbody>
            </table>
          </div>
        </div>
      </div>`;

    const body = document.getElementById('lbody');
    body.innerHTML = rows.map(l => {
      const spark = C.sparkline(months.map(m => l.months[m]?.net || 0), famColor(l.family));
      const avgAbo = l.totals.avgAbo, avgConso = l.totals.avgConso;
      // un accès internet qui consomme sort du forfait : on le signale d'emblée
      const netAnomaly = l.family === 'internet' && (l.totals.conso > 0.005 || l.totals.calls > 0);
      return `<tr class="clickable${netAnomaly ? ' row-flag' : ''}" data-key="${l.key}">
        <td class="mono strong">${F.esc(l.number)}</td>
        <td>${famBadge(l.family)}${l.family === 'internet' && l.accessTech
          ? `<div style="margin-top:3px"><span class="badge ${l.accessTech === 'fibre' ? 'b-ok' : 'b-asc'}"
               title="${l.accessTech === 'xdsl_presume' ? 'Aucune mention de fibre sur la facture : xDSL présumé, à confirmer' : ''}"
             >${S.TECH_LABELS[l.accessTech] || l.accessTech}</span></div>` : ''}</td>
        <td>${F.esc(prettifySite(l))}<div class="sub">${F.esc(l.siteId)}</div></td>
        <td>${attachCell(l)}</td>
        <td class="num strong">${F.eur(avgAbo)}</td>
        <td class="num ${avgConso > 0 ? '' : 'text-muted'}">${F.eur(avgConso)}${netAnomaly ? ` <span class="flag-dot" title="Consommation sur un accès internet — à vérifier">${Icons.svg('alert')}</span>` : ''}</td>
        <td class="num ${l.totals.calls > 0 ? '' : 'text-muted'}">${F.num(l.totals.calls)}</td>
        <td>${spark}</td>
        <td>${lineStatus(l)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="9"><div class="empty">${Icons.svg(emptyState().ico)}<div>${emptyState().msg}</div></div></td></tr>`;

    // events
    const bind = () => {
      document.getElementById('lq').addEventListener('input', e => { state.q = e.target.value; rerender(view); });
      document.getElementById('llife').value = state.life;
      document.getElementById('llife').addEventListener('change', e => { state.life = e.target.value; rerender(view); });
      document.getElementById('lstatus').value = state.status;
      document.getElementById('lstatus').addEventListener('change', e => { state.status = e.target.value; rerender(view); });
      document.getElementById('lattach').addEventListener('click', () => { state.onlyAttached = !state.onlyAttached; rerender(view); });
      document.querySelectorAll('#fams .chip').forEach(ch => ch.addEventListener('click', () => {
        const f = ch.dataset.fam;
        if (!f) state.fams.clear(); else if (state.fams.has(f)) state.fams.delete(f); else state.fams.add(f);
        rerender(view);
      }));
      document.querySelectorAll('#ltbl th.sortable').forEach(th => th.addEventListener('click', () => {
        const k = th.dataset.k;
        if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === 'site' || k === 'number' ? 1 : -1; }
        rerender(view);
      }));
      body.querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', () => {
        const l = lines.find(x => x.key === tr.dataset.key);
        if (l) openDrawer(l);
      }));
    };
    bind();

    function rerender(view2) {
      render(view2);
      const q = document.getElementById('lq');
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  }

  function famColor(f) {
    return { t0: '#2f6fed', t0_ascenseur: '#d98c0d', numeris: '#7059e8', canal_sda: '#0d9b8a', internet: '#f2611b', residentiel: '#8b93a5' }[f] || '#8b93a5';
  }

  /* Voisinage technique de la ligne : accès de base, canaux, accès internet
     du même bâtiment. C'est ce qui permet de savoir ce qu'on peut résilier. */
  function attachHtml(l) {
    const all = S.data.lines || [];
    const at = k => all.find(x => x.key === k || x.number === k);
    const chip = (num, role) => {
      const o = at(num);
      if (!o) return '';
      return `<button class="link-chip" data-goto="${F.esc(o.key)}">
        ${Icons.svg(famIcon(o.family))}
        <span><b>${F.esc(o.number)}</b><span class="sub">${role}</span></span></button>`;
    };
    const parts = [];
    if (l.attachedTo) parts.push(chip(l.attachedTo, 'accès de base ' +
      (l.attachedKind === 'numeris_autre_site' ? '(autre sous-compte)' : 'du site')));
    (l.channels || []).forEach(c => parts.push(chip(c, 'canal / SDA rattaché')));
    if (l.siteInternet) parts.push(chip(l.siteInternet, 'accès internet ' +
      (l.siteInternetSameAccount ? 'du sous-compte' : 'du même bâtiment')));
    (l.sharedWith || []).slice(0, 12).forEach(c => parts.push(chip(c, 'ligne du même bâtiment')));
    if (!parts.filter(Boolean).length) return '';
    const more = (l.sharedWith || []).length > 12
      ? `<div class="sub" style="margin-top:6px">+ ${l.sharedWith.length - 12} autre(s) ligne(s) au même bâtiment</div>` : '';
    return `<div class="section-title">Rattachements</div>
      <div class="link-chips">${parts.join('')}</div>${more}`;
  }

  /* ══ Drawer détail ligne ══ */
  function openDrawer(l) {
    const months = S.data.months;
    const d = document.getElementById('drawer');
    document.getElementById('drawer-title').innerHTML =
      `${Icons.svg(famIcon(l.family))}&nbsp; ${F.esc(l.number)}`;
    const body = document.getElementById('drawer-body');

    const consoMonths = months.filter(m => l.months[m] && l.months[m].calls > 0).length;
    const maxNet = Math.max(...months.map(m => l.months[m]?.net || 0), 0.01);
    const totalCalls = l.totals.calls;

    body.innerHTML = `
      <div class="flex" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
        ${famBadge(l.family)}
        ${l.attachedTo ? `<span class="badge b-sda">${Icons.svg('link')} rattachée à ${F.esc(l.attachedTo)}</span>` : ''}
        ${l.sdaCount ? `<span class="badge b-num">${l.sdaCount} SDA déclarés</span>` : ''}
      </div>
      ${attachHtml(l)}
      <div class="dl" style="grid-template-columns:auto 1fr">
        <dt>Site</dt><dd style="text-align:right">${F.esc(prettifySite(l))}</dd>
        ${l.siteAddress ? `<dt>Adresse</dt><dd style="text-align:right">${F.esc(F.titleCase(l.siteAddress))}</dd>` : ''}
        <dt>Sous-compte</dt><dd class="mono">${F.esc(l.siteId)}</dd>
        <dt>Compte de facturation</dt><dd class="mono">${F.esc(l.account)}</dd>
        <dt>Présence</dt><dd>${F.monthLabelShort(l.first)} → ${F.monthLabelShort(l.last)}</dd>
        <dt>Abo net total</dt><dd>${F.eur(l.totals.abo)}</dd>
        <dt>Conso totale</dt><dd>${F.eur(l.totals.conso)}</dd>
        <dt>Appels cumulés</dt><dd>${F.num(totalCalls)} (${consoMonths} mois actifs)</dd>
        <dt>Mois sans conso</dt><dd>${l.monthsNoConso} / ${Object.keys(l.months).length}</dd>
      </div>

      <div class="section-title">Abonnement net par mois</div>
      <div class="month-strip" id="d-strip"></div>

      <div class="section-title">Produits &amp; remises (cumul période)</div>
      <div id="d-prods">
        ${l.products.filter(p => Math.abs(p.total) > 0.005).map(p => `
          <div class="prod-row ${p.total < 0 ? 'is-remise' : ''}">
            <span class="p-name">${F.esc(p.name)}${p.months > 1 ? ` <span class="sub">×${p.months} mois</span>` : ''}</span>
            <span class="p-val">${p.total < 0 ? '−' : ''}${F.eur(Math.abs(p.total))}</span>
          </div>`).join('') || '<div class="text-muted">—</div>'}
      </div>

      <div class="section-title">Détail mensuel</div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Mois</th><th class="num">Abo net</th><th class="num">Conso</th><th class="num">Appels</th></tr></thead>
        <tbody>
          ${months.map(m => {
            const v = l.months[m];
            if (!v) return '';
            return `<tr><td>${F.monthLabelShort(m)}</td><td class="num">${F.eur(v.net)}</td>
              <td class="num">${v.conso ? F.eur(v.conso) : '<span class="text-muted">—</span>'}</td>
              <td class="num">${v.calls ? F.num(v.calls) : '<span class="text-muted">0</span>'}</td></tr>`;
          }).join('')}
        </tbody>
      </table></div>`;

    // strip mensuel
    const strip = body.querySelector('#d-strip');
    strip.innerHTML = months.map(m => {
      const v = l.months[m];
      const h = v ? Math.max((v.net / maxNet) * 100, 3) : 0;
      const hasConso = v && v.calls > 0;
      return `<div class="ms-col" title="${F.monthLabel(m)}${v ? ` · ${F.eur(v.net)}${hasConso ? ` · ${v.calls} appels` : ' · sans conso'}` : ''}">
        <div class="ms-bar" style="height:${h}%;background:${hasConso ? famColor(l.family) : 'linear-gradient(180deg,#e3b23c,#e3b23c)'};opacity:${v ? 1 : .25}"></div>
        <div class="ms-lab">${F.monthLabelShort(m).split(' ')[0].slice(0, 3)}</div>
      </div>`;
    }).join('');

    body.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => {
      const t = (S.data.lines || []).find(x => x.key === b.dataset.goto);
      if (t) openDrawer(t);
    }));

    d.classList.add('open');
    document.getElementById('drawer-backdrop').classList.add('open');
  }

  function famIcon(f) {
    return { t0: 'phone', t0_ascenseur: 'phone', numeris: 'net', canal_sda: 'sda', internet: 'wifi', residentiel: 'phone' }[f] || 'phone';
  }

  window.Views = window.Views || {};
  window.Views.lines = {
    render,
    title: 'Lignes',
    setFilter(f) {
      state.status = ['noconso', 'dormant', 'netconso'].includes(f) ? f : 'all';
    },
    // le switch global « Parc » pilote le défaut de cette vue, sans le verrouiller
    setLife(mode) { state.life = mode; },
    life() { return state.life; },
    setQuery(q) { state.q = q || ''; },
    // ouvre le détail d'une ligne depuis l'extérieur (recherche globale)
    openLine(key) {
      const l = (S.data.lines || []).find(x => x.key === key);
      if (l) openDrawer(l);
    },
  };
})();
