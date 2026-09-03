/* Vue — Fin du cuivre : parc RTC restant, priorisation et suivi de migration */
(function () {
  const F = window.fmt, C = window.Charts, S = window.Store;

  /* Effort de migration par technologie. Un T0 se remplace par une ligne VoIP ;
     un accès Numéris demande un trunk SIP et une reprise du PABX ; une ligne
     d'ascenseur est réglementée (secours autonome) et se traite à part. */
  const MIGRATION = {
    t0: { label: 'T0 analogique', target: 'VoIP / ligne SIP', effort: 1, note: 'Remplacement direct par une ligne VoIP sur l\'accès internet du site.' },
    residentiel: { label: 'Ligne résidentielle', target: 'VoIP / ligne SIP', effort: 1, note: 'Même traitement qu\'un T0 analogique.' },
    t0_ascenseur: { label: 'T0 ascenseur', target: 'Ligne de sécurité GSM/SIP', effort: 2, note: 'Téléalarme réglementée : prévoir un secours autonome et le test avec l\'ascensoriste.' },
    canal_sda: { label: 'Canal / SDA Numéris', target: 'Trunk SIP', effort: 3, note: 'Migre avec son accès de base : à traiter en même temps que le Numéris porteur.' },
    numeris: { label: 'Numéris accès de base', target: 'Trunk SIP + reprise PABX', effort: 3, note: 'Nécessite un trunk SIP et la compatibilité du PABX ; conserver les SDA.' },
    internet: { label: 'Accès internet xDSL', target: 'Fibre (FTTH / FTTO)', effort: 2, note: 'L\'ADSL/SDSL passe sur la paire de cuivre : l\'accès doit être basculé sur fibre, ce qui conditionne la VoIP du site.' },
  };

  /* Étiquette de technologie d'accès, affichée sur les lignes internet. */
  function techBadge(l) {
    if (l.family !== 'internet' || !l.accessTech) return '';
    const label = S.TECH_LABELS[l.accessTech] || l.accessTech;
    const cls = l.accessTech === 'fibre' ? 'b-ok'
      : l.accessTech === 'xdsl_presume' ? 'b-asc' : 'b-web';
    const hint = l.accessTech === 'xdsl_presume'
      ? 'Aucune mention de fibre sur la facture : accès xDSL présumé, à confirmer auprès de l\'opérateur'
      : `Accès ${label}`;
    return `<span class="badge ${cls}" title="${F.esc(hint)}">${label}</span>`;
  }
  const EFFORT_LABEL = { 1: 'Simple', 2: 'Encadré', 3: 'Complexe' };
  const EFFORT_CLASS = { 1: 'b-ok', 2: 'b-asc', 3: 'b-num' };

  function render(view) {
    const months = S.visibleMonths();
    const copper = S.copperLines();
    const active = S.activeLines();
    const monthlyCost = copper.reduce((a, l) => a + l.lastNet, 0);

    // Regroupement par site : c'est l'unité d'intervention réelle sur le terrain.
    // index des accès internet par numéro, pour connaître la techno du porteur
    const netByNumber = {};
    S.allLines().forEach(l => { if (l.family === 'internet') netByNumber[l.number] = l; });

    const bySite = {};
    copper.forEach(l => {
      const k = l.siteId;
      const s = bySite[k] || (bySite[k] = {
        id: k, name: l.siteName, dept: l.siteDept, address: l.siteAddress,
        placeKey: l.placeKey, lines: [], cost: 0, internet: null, maxEffort: 0,
      });
      s.lines.push(l);
      s.cost += l.lastNet;
      if (l.siteInternet) s.internet = l.siteInternet;
      // un accès xDSL du site est lui-même à migrer : il porte la techno du site
      if (l.family === 'internet') s.internet = s.internet || l.number;
      s.maxEffort = Math.max(s.maxEffort, (MIGRATION[l.family] || {}).effort || 1);
    });
    const sites = Object.values(bySite).sort((a, b) => b.cost - a.cost);
    sites.forEach(s => {
      s.suivi = S.migrationOf(s.id);
      s.net = s.internet ? netByNumber[s.internet] : null;
      s.lines.sort((a, b) => b.lastNet - a.lastNet);
      // Le suivi se tient ligne par ligne : sur un site mixte, le T0 bascule en
      // VoIP pendant que l'ascenseur attend son ascensoriste. L'état du site est
      // donc déduit de ses lignes, et non l'inverse.
      s.lineStates = s.lines.map(l => S.migrationOfLine(l));
      s.doneLines = s.lineStates.filter(x => x.state === 'migrated').length;
      s.openLines = s.lineStates.filter(x => !['migrated', 'kept'].includes(x.state)).length;
      // Une ligne cuivre sans le moindre appel se résilie au lieu de se migrer —
      // sauf celles dont l'absence de trafic est normale : un accès internet ne
      // passe pas d'appels et une ligne d'ascenseur ne sonne qu'en cas de panne.
      // Les compter ici reviendrait à proposer de couper une téléalarme.
      s.silent = s.lines.filter(l =>
        !S.NO_TRAFFIC_BY_DESIGN.has(l.family) && l.totals.calls === 0);
    });
    const silentLines = sites.reduce((a, s) => a + s.silent.length, 0);
    const silentCost = sites.reduce((a, s) =>
      a + s.silent.reduce((b, l) => b + l.lastNet, 0), 0);

    // Avancement déclaré, compté en lignes : c'est l'unité de commande, et un
    // site à moitié migré ne devait pas compter pour zéro comme auparavant.
    const lineStates = copper.map(l => ({ line: l, st: S.migrationOfLine(l) }));
    const byState = st => lineStates.filter(x => x.st.state === st);
    const doneLines = byState('migrated');
    const engagedLines = lineStates.filter(x => ['study', 'ordered'].includes(x.st.state));
    const doneCost = doneLines.reduce((a, x) => a + x.line.lastNet, 0);
    const progress = copper.length ? (doneLines.length / copper.length) * 100 : 0;
    // un site est traité quand toutes ses lignes le sont
    const done = sites.filter(s => s.openLines === 0);

    // répartition par technologie
    const byFam = {};
    copper.forEach(l => {
      const e = byFam[l.family] || (byFam[l.family] = { n: 0, cost: 0 });
      e.n += 1; e.cost += l.lastNet;
    });

    // Trajectoire : c'est une histoire, pas un état. Elle doit compter les lignes
    // facturées chaque mois, y compris celles depuis résiliées — sinon la courbe
    // est plate et le chantier paraît à l'arrêt.
    const everCopper = S.allLines().filter(l => l.isCopper);
    const trend = months.map(m => everCopper.filter(l => l.months[m]).length);
    const startCount = trend[0] || 0;
    const removed = startCount - (trend[trend.length - 1] || 0);

    view.innerHTML = `
      <div class="wrap">
        <div class="kpi-row mb-3">
          ${kpi('Lignes cuivre en service', F.num(copper.length),
            `<span>${F.num(copper.filter(l => l.family !== 'internet').length)} voix RTC · ${F.num(copper.filter(l => l.family === 'internet').length)} accès xDSL</span>`,
            'phone', 'var(--accent)', 'var(--accent-soft)')}
          ${kpi('Coût du parc cuivre', F.eur(monthlyCost, 0) + ' <span style="font-size:13px;font-weight:500">/mois</span>',
            `<span>${F.eur(monthlyCost * 12, 0)} par an</span>`,
            'euro', 'var(--blue)', 'var(--blue-soft)')}
          ${kpi('Sites à traiter', F.num(sites.length),
            `<span>${F.num(copper.length)} ligne(s) réparties</span>`,
            'building', 'var(--violet)', 'var(--violet-soft)')}
          ${kpi('Lignes sans aucun appel', F.num(silentLines),
            `<span class="up">${F.eur(silentCost)} /mois · à résilier plutôt qu'à migrer</span>`,
            'phone-off', 'var(--teal)', 'var(--teal-soft)')}
          ${kpi('Migration déclarée', F.pct(progress),
            `<span>${doneLines.length}/${copper.length} lignes · ${engagedLines.length} en cours · ${done.length}/${sites.length} sites soldés</span>`,
            'check-c', 'var(--green)', 'var(--green-soft)')}
        </div>

        <div class="card mb-3">
          <div class="flex-between" style="align-items:center;gap:16px;flex-wrap:wrap">
            <div style="min-width:220px;flex:1">
              <div class="card-title" style="margin-bottom:8px">Avancement du chantier
                <span class="hint">${F.num(removed > 0 ? removed : 0)} ligne(s) cuivre retirée(s) depuis ${F.monthLabelShort(months[0])}</span></div>
              <div class="progress"><i style="width:${progress}%"></i></div>
            </div>
            <div class="flex" style="gap:20px;flex-wrap:wrap">
              ${S.MIGRATION_STATES.map(st => {
                const n = byState(st.id).length;
                return `<div><div class="kpi-label">${st.label}</div>
                  <div style="font-size:19px;font-weight:700">${n}</div>
                  <div class="kpi-label" style="font-size:9.5px">ligne(s)</div></div>`;
              }).join('')}
              <div><div class="kpi-label">Économie déclarée</div>
                <div style="font-size:19px;font-weight:700;color:var(--green)">${F.eur(doneCost * 12, 0)}<span style="font-size:12px;font-weight:500">/an</span></div></div>
            </div>
          </div>
        </div>

        <div class="grid cols-7-5 mb-3">
          <div class="card">
            <div class="card-title">Trajectoire du parc cuivre
              <span class="hint">lignes RTC facturées par mois</span></div>
            <div id="ch-copper"></div>
          </div>
          <div class="card">
            <div class="card-title">Par technologie <span class="hint">et cible de migration</span></div>
            <div class="tbl-wrap"><table class="tbl">
              <thead><tr><th>Technologie</th><th>Cible</th><th class="num">Lignes</th><th class="num">€/mois</th></tr></thead>
              <tbody>
                ${Object.entries(byFam).sort((a, b) => b[1].cost - a[1].cost).map(([f, e]) => {
                  const m = MIGRATION[f] || { label: f, target: '—', effort: 1 };
                  return `<tr title="${F.esc(m.note || '')}">
                    <td><span class="badge ${EFFORT_CLASS[m.effort]}">${EFFORT_LABEL[m.effort]}</span>
                      <div style="margin-top:3px">${F.esc(m.label)}</div></td>
                    <td class="sub">${F.esc(m.target)}</td>
                    <td class="num strong">${e.n}</td>
                    <td class="num">${F.eur(e.cost)}</td></tr>`;
                }).join('')}
              </tbody>
            </table></div>
          </div>
        </div>

        <div class="card mb-3">
          <div class="card-title">Plan de migration par site
            <span class="hint">priorisé par coût — un accès internet sur place permet de basculer en VoIP sans attendre</span></div>
          <div class="flex" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
            <span class="chip on" data-copper-tab="all">Tous les sites (${sites.length})</span>
            <span class="chip" data-copper-tab="open">Reste à faire (${sites.filter(s => s.openLines > 0).length})</span>
            <span class="chip" data-copper-tab="silent">Avec ligne sans appel (${sites.filter(s => s.silent.length).length})</span>
            <select id="cu-state-filter" class="mini-select" style="margin-left:auto">
              <option value="">Tous les statuts</option>
              ${S.MIGRATION_STATES.map(s => `<option value="${s.id}">${s.label}</option>`).join('')}
            </select>
            <a class="btn btn-ghost btn-sm" href="/api/export/migration">${Icons.svg('download')} Exporter le plan</a>
          </div>
          <div class="tbl-wrap"><table class="tbl" id="copper-tbl">
            <thead><tr>
              <th>Site</th><th>Lignes cuivre &amp; consommation</th>
              <th>Complexité</th><th class="num">€/mois</th><th>Suivi</th>
            </tr></thead>
            <tbody id="copper-body"></tbody>
          </table></div>
        </div>
      </div>`;

    C.stackedArea(document.getElementById('ch-copper'), {
      labels: months.map(F.monthLabelShort),
      series: [{ name: 'Lignes cuivre', values: trend, color: '#f2611b' }],
      fmt: v => F.num(v) + ' lignes',
    });

    let tab = 'all', stateFilter = '';

    /* Une ligne du plan : n°, technologie d'accès et trafic réellement observé. */
    const trafficCell = (l) => {
      if (l.family === 'internet') return '<span class="text-muted">accès data</span>';
      if (l.totals.calls) return `${F.num(l.totals.calls)} appels · ${F.eur(l.totals.conso)}`;
      // une téléalarme d'ascenseur ne sonne qu'en cas de panne : son silence est
      // le fonctionnement attendu, pas un signal de résiliation
      if (S.NO_TRAFFIC_BY_DESIGN.has(l.family)) {
        return '<span class="text-muted">téléalarme — aucun appel attendu</span>';
      }
      return '<b>aucun appel sur la période</b>';
    };

    /* Statut d'une ligne, avec l'origine de la saisie. « hérité » dit que la
       ligne suit la déclaration faite au niveau du site : sans cette mention on
       ne saurait pas si la ligne a été traitée pour elle-même. */
    const lineState = (l) => {
      const st = S.migrationOfLine(l);
      const def = S.MIGRATION_STATES.find(x => x.id === st.state) || S.MIGRATION_STATES[0];
      const herite = st.level === 'site';
      return `<span class="cu-line-state">
        ${st.level === 'none' ? '' : `<span class="badge ${def.cls}"${herite
          ? ' title="Déclaré au niveau du site"' : ''}>${def.label}${herite ? ' ·' : ''}</span>`}
        ${herite ? '<span class="sub">hérité</span>' : ''}
        <button class="btn btn-ghost btn-xs" data-edit-line="${F.esc(l.key)}"
          title="Déclarer l'avancement de cette ligne">${Icons.svg('edit')}</button>
      </span>`;
    };

    const lineRow = (l) => {
      const mute = !S.NO_TRAFFIC_BY_DESIGN.has(l.family) && l.totals.calls === 0;
      const st = S.migrationOfLine(l);
      const cls = st.state === 'migrated' ? ' is-done'
        : st.state === 'kept' ? ' is-kept' : '';
      return `<div class="cu-line${mute ? ' is-mute' : ''}${cls}">
        <span class="mono strong">${F.esc(l.number)}</span>
        <span class="badge b-mut">${F.esc((MIGRATION[l.family] || {}).label || l.familyLabel)}</span>
        ${techBadge(l)}
        <span class="cu-line-conso">${trafficCell(l)}</span>
        <span class="cu-line-cost">${F.eur(l.lastNet)}</span>
        ${lineState(l)}
      </div>${l.family === 'internet' ? supportRows(l) : ''}`;
    };

    /* Un accès xDSL s'appuie sur une paire de cuivre : les lignes voix du même
       bâtiment sont les supports candidats. Sans trafic, elles partent avec lui. */
    const supportRows = (net) => {
      const supports = S.allLines().filter(v =>
        v.isActive && v.family !== 'internet' && v.placeKey && v.placeKey === net.placeKey);
      if (!supports.length) return '';
      return `<div class="cu-support">
        <div class="cu-support-head">${Icons.svg('link')} Ligne(s) support au même bâtiment</div>
        ${supports.sort((a, b) => b.totals.calls - a.totals.calls).map(v => `
          <div class="cu-line${v.totals.calls === 0 && !S.NO_TRAFFIC_BY_DESIGN.has(v.family) ? ' is-mute' : ''}">
            <span class="mono">${F.esc(v.number)}</span>
            <span class="sub">${F.esc(v.familyLabel)}${v.siteId !== net.siteId ? ` · sous-compte ${F.esc(v.siteId)}` : ''}</span>
            <span class="cu-line-conso">${trafficCell(v)}</span>
            <span class="cu-line-cost">${F.eur(v.lastNet)}</span>
          </div>`).join('')}
      </div>`;
    };

    const stateBadge = (st) => {
      const def = S.MIGRATION_STATES.find(x => x.id === st.state) || S.MIGRATION_STATES[0];
      const bits = [st.ref && `réf. ${F.esc(st.ref)}`, st.date && F.dateISO(st.date)]
        .filter(Boolean).join(' · ');
      return `<span class="badge ${def.cls}">${def.label}</span>` +
        (bits ? `<div class="sub">${bits}</div>` : '') +
        (st.note ? `<div class="sub" title="${F.esc(st.note)}">${F.esc(st.note.slice(0, 42))}${st.note.length > 42 ? '…' : ''}</div>` : '');
    };

    const paint = () => {
      let list = tab === 'silent' ? sites.filter(s => s.silent.length)
        : tab === 'open' ? sites.filter(s => s.openLines > 0)
        : sites;
      // le filtre de statut porte sur les lignes : un site n'a plus un état
      // unique, il en a autant que de lignes
      if (stateFilter) {
        list = list.filter(s => s.lineStates.some(x => x.state === stateFilter));
      }
      document.getElementById('copper-body').innerHTML = list.map(s => `
        <tr data-site="${F.esc(s.id)}" class="cu-row${s.openLines === 0 ? ' st-migrated' : ''}">
          <td><b>${F.esc(F.site(s))}</b>
            <div class="sub mono">${F.esc(s.id)}</div>
            ${F.siteRenamed(s) ? `<div class="sub" title="Nom porté par la facture">sur facture : ${F.esc(F.siteBilled(s))}</div>` : ''}
            <div class="sub">${F.esc(F.titleCase(s.address || ''))}</div></td>
          <td>${s.lines.map(lineRow).join('')}</td>
          <td><span class="badge ${EFFORT_CLASS[s.maxEffort]}">${EFFORT_LABEL[s.maxEffort]}</span></td>
          <td class="num strong">${F.eur(s.cost)}<div class="sub">${F.eur(s.cost * 12)}/an</div></td>
          <td>
            <div class="strong">${s.doneLines}/${s.lines.length} migrée${s.lines.length > 1 ? 's' : ''}</div>
            ${stateBadge(s.suivi)}
            <button class="btn btn-ghost btn-sm mt-1" data-edit="${F.esc(s.id)}"
              title="Déclarer d'un coup toutes les lignes de ce site">
              ${Icons.svg('edit')} ${s.suivi.state === 'todo' && !s.suivi.ref ? 'Tout le site' : 'Modifier le site'}</button></td>
        </tr>`).join('') ||
        `<tr><td colspan="5"><div class="empty">${Icons.svg('check-c')}<div>Aucun site dans cette catégorie.</div></div></td></tr>`;
      document.querySelectorAll('[data-copper-tab]').forEach(c =>
        c.classList.toggle('on', c.dataset.copperTab === tab));
      document.querySelectorAll('[data-edit]').forEach(b =>
        b.addEventListener('click', () => openEditor(bySite[b.dataset.edit], () => render(view))));
      document.querySelectorAll('[data-edit-line]').forEach(b =>
        b.addEventListener('click', () => {
          const l = copper.find(x => x.key === b.dataset.editLine);
          if (l) openLineEditor(l, () => render(view));
        }));
    };
    paint();
    document.querySelectorAll('[data-copper-tab]').forEach(c =>
      c.addEventListener('click', () => { tab = c.dataset.copperTab; paint(); }));
    document.getElementById('cu-state-filter').addEventListener('change', e => {
      stateFilter = e.target.value; paint();
    });
  }

  /* Saisie de l'avancement d'une ligne. Le formulaire est celui du site ; seuls
     l'intitulé et la destination de l'enregistrement changent. */
  function openLineEditor(line, onSaved) {
    if (!line) return;
    const st = S.migrationOfLine(line);
    const m = MIGRATION[line.family] || {};
    openTracker({
      icon: famTrackIcon(line.family),
      title: F.esc(line.number),
      sub: `${F.esc(m.label || line.familyLabel)} · ${F.esc(F.site(line))} · ${F.eur(line.lastNet)}/mois`,
      // une ligne qui n'a jamais été déclarée pour elle-même part de l'état
      // hérité du site : on ne repart pas de zéro à l'ouverture
      current: st,
      hint: st.level === 'site'
        ? 'Cette ligne suit pour l\'instant la déclaration faite sur le site. Enregistrer ici la détache et ne vaudra que pour elle.'
        : (m.note || ''),
      save: payload => S.setMigrationLine(line.key, payload),
      saved: `Suivi enregistré pour ${line.number}`,
    }, onSaved);
  }

  function famTrackIcon(f) {
    return f === 'internet' ? 'wifi' : f === 't0_ascenseur' ? 'swap' : 'phone';
  }

  /* Saisie de l'avancement pour un site : vaut pour toutes ses lignes qui n'ont
     pas de déclaration propre. */
  function openEditor(site, onSaved) {
    if (!site) return;
    openTracker({
      icon: 'swap',
      title: F.esc(F.site(site)),
      sub: `${F.esc(site.id)} · ${site.lines.length} ligne(s) cuivre · ${F.eur(site.cost)}/mois`,
      current: site.suivi || S.migrationOf(site.id),
      hint: 'Vaut pour toutes les lignes du site qui n\'ont pas de déclaration propre.',
      save: payload => S.setMigration(site.id, payload),
      saved: 'Suivi enregistré pour ' + F.site(site),
    }, onSaved);
  }

  /* Formulaire de suivi, partagé par le site et la ligne : statut, référence de
     commande, date, note. Un seul endroit à corriger le jour où la saisie
     change. */
  function openTracker(cfg, onSaved) {
    const st = cfg.current || {};
    const box = document.createElement('div');
    box.className = 'palette-backdrop open';
    box.innerHTML = `
      <div class="palette" style="max-width:520px" role="dialog" aria-modal="true">
        <div class="palette-head" style="gap:12px">
          <span class="palette-ico">${Icons.svg(cfg.icon)}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:650">${cfg.title}</div>
            <div class="sub">${cfg.sub}</div>
          </div>
          <button class="icon-btn" data-cancel>${Icons.svg('x')}</button>
        </div>
        <div class="palette-body" style="padding:16px">
          <div class="field mb-2">
            <label>Statut de migration</label>
            <div class="flex" style="gap:6px;flex-wrap:wrap" id="cu-states">
              ${S.MIGRATION_STATES.map(x => `
                <span class="chip ${x.id === st.state ? 'on' : ''}" data-state="${x.id}">${x.label}</span>`).join('')}
            </div>
          </div>
          <div class="flex" style="gap:12px">
            <div class="field grow"><label>Référence de commande</label>
              <input id="cu-ref" type="text" placeholder="n° de commande, ticket…" value="${F.esc(st.ref || '')}"></div>
            <div class="field"><label>Date</label>
              <input id="cu-date" type="date" value="${F.esc(st.date || '')}"></div>
          </div>
          <div class="field mt-2"><label>Note</label>
            <textarea id="cu-note" rows="3" placeholder="Contexte, interlocuteur, contrainte technique…">${F.esc(st.note || '')}</textarea></div>
          ${cfg.hint ? `<div class="audit-note" style="margin-top:12px">${Icons.svg('info')}
            <div>${F.esc(cfg.hint)}</div></div>` : ''}
        </div>
        <div class="palette-foot" style="justify-content:flex-end;gap:8px">
          <button class="btn btn-ghost btn-sm" data-cancel>Annuler</button>
          <button class="btn btn-sm btn-primary" id="cu-save">Enregistrer</button>
        </div>
      </div>`;
    document.body.appendChild(box);

    let chosen = st.state || 'todo';
    box.querySelectorAll('[data-state]').forEach(c => c.addEventListener('click', () => {
      chosen = c.dataset.state;
      box.querySelectorAll('[data-state]').forEach(o => o.classList.toggle('on', o === c));
    }));
    const close = () => box.remove();
    box.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', close));
    box.addEventListener('mousedown', e => { if (e.target === box) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    box.querySelector('#cu-save').addEventListener('click', async () => {
      const btn = box.querySelector('#cu-save');
      btn.disabled = true; btn.textContent = 'Enregistrement…';
      try {
        await cfg.save({
          state: chosen,
          ref: box.querySelector('#cu-ref').value,
          date: box.querySelector('#cu-date').value,
          note: box.querySelector('#cu-note').value,
        });
        close();
        window.toast(cfg.saved);
        onSaved && onSaved();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Enregistrer';
        window.toast(err.message, 'err');
      }
    });
    setTimeout(() => box.querySelector('#cu-ref').focus(), 30);
  }

  function kpi(label, value, deltaHtml, icon, color, soft) {
    return `<div class="kpi" style="--k-accent:${color};--k-soft:${soft}">
      <div class="kpi-ico">${Icons.svg(icon)}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      ${deltaHtml ? `<div class="kpi-delta">${deltaHtml}</div>` : ''}
    </div>`;
  }

  window.Views = window.Views || {};
  window.Views.copper = { render, title: 'Fin du cuivre' };
})();
