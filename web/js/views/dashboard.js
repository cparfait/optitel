/* Vue — Dashboard : KPIs, évolution mensuelle, répartition, top sites, alertes */
(function () {
  const F = window.fmt, C = window.Charts, S = window.Store;
  const FAM_COLORS = {
    t0: '#2f6fed', t0_ascenseur: '#d98c0d', numeris: '#7059e8',
    canal_sda: '#0d9b8a', internet: '#f2611b', residentiel: '#8b93a5', autre: '#8b93a5',
  };

  function kpi(label, value, deltaHtml, icon, color, soft) {
    return `<div class="kpi" style="--k-accent:${color};--k-soft:${soft}">
      <div class="kpi-ico">${Icons.svg(icon)}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      ${deltaHtml ? `<div class="kpi-delta">${deltaHtml}</div>` : ''}
    </div>`;
  }

  function render(view) {
    const months = S.visibleMonths();
    const last = months[months.length - 1];
    const prev = months[months.length - 2];
    const T = S.periodTotals();
    const nMonths = months.length;
    const linesAll = S.lines();
    // le parc historique reste la référence pour compter résiliations et rotation,
    // même quand le switch « Parc » restreint l'affichage aux lignes en service
    const linesEver = S.allLines();
    const alive = linesEver.filter(l => l.isActive);
    // linesNoConso() porte sur le mois affiché : le coût et le libellé doivent
    // porter sur le même mois, sinon on chiffre un constat de février avec les
    // montants d'août dès que l'utilisateur change « Mois affiché ».
    const noConso = S.linesNoConso();
    const noConsoCost = S.monthlyCost(noConso, S.month);
    const dormant = S.linesDormant();
    const dormantCost = S.monthlyCost(dormant, last);
    const remises = S.remisesByKind();
    const brutAbo = T.abo + T.remiseAbo;
    const remPct = brutAbo > 0 ? (T.remiseAbo / brutAbo) * 100 : 0;

    // deltas
    const tl = S.monthTotals(last, S.account), tp = prev ? S.monthTotals(prev, S.account) : null;
    const dHt = tp && tp.ht ? ((tl.ht - tp.ht) / tp.ht) * 100 : null;
    const dHtHtml = dHt === null ? `<span>${F.monthLabel(last)}</span>` :
      `${dHt <= 0 ? '<span class="up">' + Icons.svg('trend') + ' −' + F.num1(Math.abs(dHt)) + ' %</span>' : '<span class="down">' + Icons.svg('trend-d') + ' +' + F.num1(dHt) + ' %</span>'} <span>vs ${F.monthLabelShort(prev)}</span>`;

    // chantier cuivre (KPI + bannière) : la fermeture du RTC conditionne tout le parc
    const copper = S.copperLines();
    const copperCost = copper.reduce((a, l) => a + l.lastNet, 0);
    const copperVoice = copper.filter(l => l.family !== 'internet').length;
    const copperSites = new Set(copper.map(l => l.siteId)).size;
    const cuStates = Object.values(S.migration || {});
    const cuDone = cuStates.filter(x => x.state === 'migrated').length;
    const cuProgress = copperSites ? Math.min((cuDone / copperSites) * 100, 100) : 0;

    // séries mensuelles
    const labels = months.map(F.monthLabelShort);
    const aboS = months.map(m => +S.monthTotals(m, S.account).abo.toFixed(2));
    const consoS = months.map(m => +S.monthTotals(m, S.account).conso.toFixed(2));
    // frais ponctuels : jusqu'à 225 € sur un mois. Les omettre faisait terminer
    // la courbe sous le total HT annoncé dans l'en-tête de page.
    const ponctS = months.map(m => +S.monthTotals(m, S.account).ponctuels.toFixed(2));
    const hasPonct = ponctS.some(v => Math.abs(v) > 0.5);
    const remS = months.map(m => +(S.monthTotals(m, S.account).remiseAbo + S.monthTotals(m, S.account).remiseConso).toFixed(2));

    // donut familles (coût abo net total par famille)
    // Répartition d'une dépense déjà engagée : elle doit inclure les lignes
    // résiliées en cours de période, sinon le donut ne recolle plus au total HT.
    const famCost = {};
    linesEver.forEach(l => {
      famCost[l.family] = famCost[l.family] || 0;
      months.forEach(m => { famCost[l.family] += l.months[m]?.net || 0; });
    });
    const famLabels = { t0: 'T0 analogiques', t0_ascenseur: 'Ascenseurs', numeris: 'Numéris accès base', canal_sda: 'Canaux / SDA', internet: 'Accès internet', residentiel: 'Résidentiel', autre: 'Autres' };
    const famItems = Object.entries(famCost).filter(([, v]) => v > 0.5)
      .map(([k, v]) => ({ name: famLabels[k] || k, value: v, color: FAM_COLORS[k] || '#8b93a5' }))
      .sort((a, b) => b.value - a.value);

    // top sites
    const siteCost = S.allSites().map(s => {
      let abo = 0, conso = 0;
      months.forEach(m => { abo += s.months[m]?.abo || 0; conso += s.months[m]?.conso || 0; });
      return { name: prettifySite(s), total: abo + conso, lines: s.lineCount };
    }).sort((a, b) => b.total - a.total).slice(0, 7);
    const siteMax = Math.max(...siteCost.map(s => s.total), 1);

    // alertes
    const alerts = [];
    // chantier cuivre : toujours en tête — c'est la décision structurante du parc
    {
      const cu = S.copperLines();
      if (cu.length) {
        const cuCost = cu.reduce((a, l) => a + l.lastNet, 0);
        const cuVoice = cu.filter(l => l.family !== 'internet').length;
        alerts.push({ ico: 'swap', color: 'var(--accent)', soft: 'var(--accent-soft)', first: true,
          html: `<b>Fin du cuivre — ${F.num(cuVoice)} lignes RTC + ${F.num(cu.length - cuVoice)} accès xDSL</b> encore sur la paire de cuivre (${F.eur(cuCost)}/mois). Le réseau RTC ferme : chaque site doit être migré en SIP/fibre. <a href="#/copper">Ouvrir le plan de migration →</a>` });
      }
    }
    const nDead = linesEver.filter(l => l.isTerminated).length;
    if (dormant.length) alerts.push({ ico: 'phone-off', color: 'var(--amber)', soft: 'var(--amber-soft)',
      html: `<b>${dormant.length} ligne${dormant.length > 1 ? 's' : ''} voix sans un seul appel</b> sur les ${nMonths} mois — ${F.eur(dormantCost)}/mois, soit ${F.eur(dormantCost * 12)}/an. À arbitrer en priorité. <a href="#/lines?filter=dormant">Voir →</a>` });
    else if (noConso.length) alerts.push({ ico: 'phone-off', color: 'var(--amber)', soft: 'var(--amber-soft)',
      html: `<b>${noConso.length} ligne${noConso.length > 1 ? 's' : ''} voix sans consommation</b> en ${F.monthLabel(S.month)} — ${F.eur(noConsoCost)} d'abonnements nets. <a href="#/lines?filter=noconso">Voir →</a>` });
    const netConso = S.internetWithConso();
    if (netConso.length) {
      const tot = netConso.reduce((a, x) => a + x.conso, 0);
      alerts.push({ ico: 'wifi', color: 'var(--red)', soft: 'var(--red-soft)',
        html: `<b>${netConso.length} accès internet factur${netConso.length > 1 ? 'ent' : 'e'} de la consommation</b> — ${F.eur(tot)} sur la période, hors forfait. <a href="#/lines?filter=netconso">Voir →</a>` });
    }
    const sdaNoAttach = linesEver.filter(l => l.family === 'canal_sda' && l.isActive && !l.attachedTo).length;
    if (sdaNoAttach) alerts.push({ ico: 'link', color: 'var(--teal)', soft: 'var(--teal-soft)',
      html: `<b>${sdaNoAttach} canal(aux) SDA</b> sans accès Numéris de base identifié sur le même site.` });
    const marchéChange = (S.data.accounts || []).some(a => a.marches && a.marches.length > 1);
    if (marchéChange) alerts.push({ ico: 'tag', color: 'var(--violet)', soft: 'var(--violet-soft)',
      html: `<b>Changement de marché</b> détecté pendant la période — comparez les niveaux de remises avant / après.` });
    if (nDead) alerts.push({ ico: 'info', color: 'var(--blue)', soft: 'var(--blue-soft)',
      html: `<b>${nDead} ligne${nDead > 1 ? 's' : ''} absente${nDead > 1 ? 's' : ''}</b> de la dernière facture (résiliation ou transfert).` });

    view.innerHTML = `
      <div class="wrap">
        <div class="kpi-row kpi-row-6 mb-2">
          ${kpi('Total période HT', F.eur(T.ht, 0), `<span>${nMonths} mois · moyenne ${F.eur(T.ht / nMonths)}/mois</span>`, 'euro', 'var(--accent)', 'var(--accent-soft)')}
          ${kpi('Facture du dernier mois', F.eur(tl.ht, 0), dHtHtml, 'invoice', 'var(--blue)', 'var(--blue-soft)')}
          ${kpi('Remises cumulées', F.eur(T.remiseAbo + T.remiseConso, 0), `<span class="up">${F.pct(remPct, 1)} du brut abonnements</span>`, 'percent', 'var(--teal)', 'var(--teal-soft)')}
          ${kpi('Lignes en service', F.num(alive.length), `<span>${F.num(linesEver.length)} vues sur la période</span>`, 'phone', 'var(--violet)', 'var(--violet-soft)')}
          ${kpi('Cuivre à migrer', F.num(copperVoice), `<span class="down">${F.eur(copperCost)} /mois · ${copperSites} sites</span>`, 'swap', '#e05a1a', 'var(--accent-soft)')}
          ${kpi('Lignes voix dormantes', F.num(dormant.length), `<span class="down">${F.eur(dormantCost)} / mois · 0 appel sur ${nMonths} mois</span>`, 'phone-off', 'var(--amber)', 'var(--amber-soft)')}
        </div>

        <div class="copper-banner">
          <div class="cb-ico">${Icons.svg('swap')}</div>
          <div>
            <div class="cb-title">Chantier fin du cuivre — fermeture du réseau RTC</div>
            <div class="cb-sub">${F.num(copperVoice)} lignes voix + ${F.num(copper.length - copperVoice)} accès xDSL passent encore par la paire de cuivre.
              Chaque site doit basculer en trunk SIP / fibre avant l'extinction du réseau.</div>
          </div>
          <div class="cb-stats">
            <div class="cb-stat"><div class="kpi-label">Coût / mois</div><b>${F.eur(copperCost, 0)}</b></div>
            <div class="cb-stat"><div class="kpi-label">Sites à traiter</div><b>${F.num(copperSites)}</b></div>
            <div class="cb-stat"><div class="kpi-label">Avancement</div><b>${F.pct(cuProgress)}</b></div>
          </div>
          <a class="btn btn-primary btn-sm cb-cta" href="#/copper">Plan de migration →</a>
        </div>

        <div class="grid cols-7-5 mb-3">
          <div class="card">
            <div class="card-title">Évolution mensuelle — coût HT
              <span class="hint">total facturé, ventilé</span></div>
            <div id="ch-evolution"></div>
            <div class="legend">
              <span class="lg"><i style="background:#f2611b"></i>Abonnements &amp; options (net)</span>
              <span class="lg"><i style="background:#0d9b8a"></i>Consommations (net)</span>
              ${hasPonct ? '<span class="lg"><i style="background:#d98c0d"></i>Frais ponctuels</span>' : ''}
              <span class="lg"><i style="background:#7059e8"></i>Remises accordées</span>
            </div>
          </div>
          <div class="card">
            <div class="card-title">Répartition par type de ligne <span class="hint">abonnements nets, période</span></div>
            <div id="ch-donut"></div>
            <div class="legend" style="justify-content:center">
              ${famItems.map(i => `<span class="lg"><i style="background:${i.color}"></i>${i.name}</span>`).join('')}
            </div>
          </div>
        </div>

        <div class="grid cols-7-5 mb-3">
          <div class="card">
            <div class="card-title">Top sites par coût <span class="hint">abonnements + consommations, période</span></div>
            ${siteCost.map(s => `
              <div class="hbar-row">
                <div class="hbar-label" title="${F.esc(s.name)}">${F.esc(s.name)}</div>
                <div class="hbar-track"><div class="hbar-fill" style="width:${(s.total / siteMax) * 100}%"></div></div>
                <div class="hbar-val">${F.eurShort(s.total)}</div>
              </div>`).join('')}
          </div>
          <div class="card">
            <div class="card-title">Points d'attention</div>
            ${alerts.slice().sort((a, b) => (b.first ? 1 : 0) - (a.first ? 1 : 0)).map(a => `
              <div class="alert-item"${a.first ? ' style="border-color:#f3c9ae;background:linear-gradient(100deg,rgba(242,97,27,.07),#fbfbfd 45%)"' : ''}>
                <div class="alert-ico" style="background:${a.soft};color:${a.color}">${Icons.svg(a.ico)}</div>
                <div class="alert-body">${a.html}</div>
              </div>`).join('') || '<div class="empty">Rien à signaler ✨</div>'}
          </div>
        </div>
      </div>`;

    // charts
    C.stackedArea(document.getElementById('ch-evolution'), {
      labels,
      series: [
        { name: 'Abonnements (net)', values: aboS, color: '#f2611b' },
        { name: 'Consommations (net)', values: consoS, color: '#0d9b8a' },
        ...(hasPonct ? [{ name: 'Frais ponctuels', values: ponctS, color: '#d98c0d' }] : []),
        { name: 'Remises', values: remS, color: '#7059e8', type: 'line', dash: true, hideTip: false },
      ],
      fmtV: v => F.eur(v),
      fmtCat: lb => lb,
      ratio: .46,
    });
    C.donut(document.getElementById('ch-donut'), {
      items: famItems,
      // Ce total est celui des abonnements nets rattachés à une ligne : il est
      // par construction inférieur au total HT de la période (ponctuels, frais
      // et régularisations non rattachés à un numéro). L'annoncer « coût total »
      // à côté d'un KPI de 55 347 € faisait croire à une perte de 1 500 €.
      center: { label: F.eurShort(famItems.reduce((a, i) => a + i.value, 0)), sub: 'abonnements nets' },
      fmt: v => F.eur(v),
      size: 200,
    });
  }

  // Accepte un site complet {name,dept} ou une ligne {siteName,siteDept}.
  function prettifySite(site) {
    return F.site(typeof site === 'string' ? { name: site } : site);
  }
  window.prettifySite = prettifySite;

  window.Views = window.Views || {};
  window.Views.dashboard = { render, title: 'Vue d\'ensemble' };
})();
