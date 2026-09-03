/* Vue — Consommations : catégories, évolution, top lignes, sans conso */
(function () {
  const F = window.fmt, C = window.Charts, S = window.Store;

  // familles tarifaires -> groupes visuels
  /* L'ordre des tests compte : les libellés Orange cumulent les mots-clés.
     « services spéciaux durée depuis un fixe » contient « fixe », « fixes Europe
     proche » aussi, « mobiles Caraïbes » contient « mobile ». Tester la
     destination et la nature du service AVANT le support évite de ranger un
     appel vers l'international dans les fixes France. */
  function catGroup(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('remise')) return null;
    if (n.includes('gratuit')) return 'gratuits';
    if (n.includes('spécial') || n.includes('spé') || n.includes('valeur ajoutée') || n.includes('acte')) return 'services';
    if (n.includes('internat') || n.includes('europe') || n.includes('amérique') ||
        n.includes('am. du nord') || n.includes('caraïbes') || n.includes('outre-mer') ||
        n.includes('réunion') || n.includes('antilles')) return 'international';
    if (n.includes('mobile')) return 'mobiles';
    if (n.includes('fixe') || n.includes('métropole')) return 'fixes';
    return 'autres';
  }
  const GROUP_LABELS = { mobiles: 'Mobiles France', fixes: 'Fixes France', international: 'International, Europe & outre-mer', services: 'Services & numéros spéciaux', gratuits: 'Appels gratuits', autres: 'Autres' };
  const GROUP_COLORS = { mobiles: '#2f6fed', fixes: '#0d9b8a', international: '#d98c0d', services: '#7059e8', gratuits: '#aab0bf', autres: '#8b93a5' };

  function render(view) {
    const months = S.visibleMonths();

    // agrégats par catégorie (hors remises)
    const cats = S.consoCats().filter(c => !c.isRemise && c.name.toLowerCase() !== 'remises');
    const withGroups = cats.map(c => ({ ...c, group: catGroup(c.name) || 'autres' }));
    const byGroup = {};
    withGroups.forEach(c => {
      const g = byGroup[c.group] = byGroup[c.group] || { calls: 0, duration: 0, montant: 0 };
      g.calls += c.calls || 0; g.duration += c.duration || 0; g.montant += c.montant || 0;
    });
    const totalMontant = Object.values(byGroup).reduce((a, g) => a + g.montant, 0);
    const totalCalls = Object.values(byGroup).reduce((a, g) => a + g.calls, 0);
    const totalDur = Object.values(byGroup).reduce((a, g) => a + g.duration, 0);
    const remisesConso = S.periodTotals().remiseConso;
    // Le coût à la minute ne se calcule que sur ce qui se compte en minutes :
    // un achat à l'acte ou des frais ponctuels facturés dans la même rubrique
    // gonfleraient le prix de la minute d'appel.
    const dureeMontant = withGroups.filter(c => c.duration > 0)
      .reduce((a, c) => a + (c.montant || 0), 0);
    // Le détail par famille est une synthèse de la facture, pas son total : il
    // ne recolle exactement ni au brut ni aux remises. On mesure les deux écarts
    // et on les affiche, plutôt que de poser deux chiffres côte à côte sans
    // expliquer pourquoi ils diffèrent.
    const brutFacture = S.periodTotals().conso + remisesConso;
    const ecartDetail = totalMontant - brutFacture;
    const remisesDetail = S.consoCats()
      .filter(c => c.isRemise).reduce((a, c) => a - (c.montant || 0), 0);
    const ecartRemises = remisesDetail - remisesConso;

    // séries par groupe par mois (via consoCats mensuel)
    const groupMonths = {};
    months.forEach(mk => {
      const m = S.monthConsoCats(mk).filter(c => !c.isRemise);
      m.forEach(c => {
        const g = catGroup(c.name) || 'autres';
        groupMonths[g] = groupMonths[g] || months.map(() => 0);
        groupMonths[g][months.indexOf(mk)] += c.montant || 0;
      });
    });

    // top lignes consommatrices (période)
    // consommation déjà facturée : les lignes résiliées en font partie
    const topLines = S.allLines().filter(l => l.totals.conso > 0)
      .sort((a, b) => b.totals.conso - a.totals.conso).slice(0, 10);
    const topMax = Math.max(...topLines.map(l => l.totals.conso), 1);

    // lignes sans conso au mois affiché
    const noConso = S.linesNoConso().slice().sort((a, b) => (b.months[S.month]?.net || 0) - (a.months[S.month]?.net || 0));
    const noConsoTotal = noConso.reduce((a, l) => a + (l.months[S.month]?.net || 0), 0);

    view.innerHTML = `
      <div class="wrap">
        <div class="kpi-row mb-3" style="grid-template-columns:repeat(4,1fr)">
          <div class="kpi" style="--k-accent:#0d9b8a;--k-soft:var(--teal-soft)">
            <div class="kpi-ico">${Icons.svg('wave')}</div>
            <div class="kpi-label">Consommations nettes</div>
            <div class="kpi-value">${F.eur(S.periodTotals().conso, 0)}</div>
            <div class="kpi-delta">brut ${F.eur(S.periodTotals().conso + remisesConso, 0)} − remises ${F.eur(remisesConso, 0)}</div>
          </div>
          <div class="kpi" style="--k-accent:#2f6fed;--k-soft:var(--blue-soft)">
            <div class="kpi-ico">${Icons.svg('phone')}</div>
            <div class="kpi-label">Appels émis</div>
            <div class="kpi-value">${F.num(totalCalls)}</div>
            <div class="kpi-delta">sur ${months.length} mois</div>
          </div>
          <div class="kpi" style="--k-accent:#7059e8;--k-soft:var(--violet-soft)">
            <div class="kpi-ico">${Icons.svg('clock')}</div>
            <div class="kpi-label">Durée totale</div>
            <div class="kpi-value">${F.durH(totalDur)}</div>
            <div class="kpi-delta">≈ ${F.durH(totalDur / Math.max(months.length, 1))} / mois</div>
          </div>
          <div class="kpi" style="--k-accent:#d98c0d;--k-soft:var(--amber-soft)">
            <div class="kpi-ico">${Icons.svg('euro')}</div>
            <div class="kpi-label">Coût moyen / minute</div>
            <div class="kpi-value">${totalDur > 0 ? F.eur(dureeMontant / (totalDur / 60)) : '—'}</div>
            <div class="kpi-delta">appels à la durée, avant remises</div>
          </div>
        </div>

        <div class="grid cols-7-5 mb-3">
          <div class="card">
            <div class="card-title">Évolution par destination <span class="hint">montants bruts</span></div>
            <div id="ch-conso"></div>
            <div class="legend">
              ${Object.entries(GROUP_COLORS).map(([g, c]) =>
                groupMonths[g] ? `<span class="lg"><i style="background:${c}"></i>${GROUP_LABELS[g]}</span>` : '').join('')}
            </div>
          </div>
          <div class="card">
            <div class="card-title">Répartition des coûts <span class="hint">détail par famille, brut</span></div>
            <div id="ch-donut"></div>
            <div class="legend" style="justify-content:center">
              ${Object.entries(byGroup).sort((a, b) => b[1].montant - a[1].montant).map(([g, v]) =>
                `<span class="lg"><i style="background:${GROUP_COLORS[g]}"></i>${GROUP_LABELS[g]}</span>`).join('')}
            </div>
            ${Math.abs(ecartDetail) > 1 || Math.abs(ecartRemises) > 1 ? `
              <div class="tbl-foot">
                <b>Rapprochement avec la facture</b> — les KPI ci-dessus sont pris sur les
                totaux de facture ; ce détail est la synthèse par famille, qui n'y recolle pas
                exactement.
                <table class="tbl" style="margin-top:8px">
                  <tbody>
                    <tr><td>Brut : détail par famille</td><td class="num">${F.eur(totalMontant)}</td>
                        <td>facture</td><td class="num">${F.eur(brutFacture)}</td>
                        <td class="num strong">${ecartDetail >= 0 ? '+' : '−'}${F.eur(Math.abs(ecartDetail))}</td></tr>
                    <tr><td>Remises : détail par famille</td><td class="num">${F.eur(remisesDetail)}</td>
                        <td>facture</td><td class="num">${F.eur(remisesConso)}</td>
                        <td class="num strong">${ecartRemises >= 0 ? '+' : '−'}${F.eur(Math.abs(ecartRemises))}</td></tr>
                  </tbody>
                </table>
                Le brut du détail est plus élevé : la rubrique porte aussi des lignes qui ne sont
                pas des appels (achats à l'acte, frais ponctuels). Les remises du détail sont
                incomplètes : quelques lignes de la synthèse ne sont pas extraites.
                <b>Ne pas utiliser ce tableau pour un total</b> — les KPI font foi.
              </div>` : ''}
          </div>
        </div>

        <div class="grid cols-2 mb-3">
          <div class="card">
            <div class="card-title">Détail par famille tarifaire <span class="hint">période, avant remises</span></div>
            <div class="tbl-wrap"><table class="tbl">
              <thead><tr><th>Catégorie</th><th class="num">Appels</th><th class="num">Durée</th><th class="num">Montant</th></tr></thead>
              <tbody>
                ${cats.sort((a, b) => (b.montant || 0) - (a.montant || 0)).map(c => `
                  <tr>
                    <td>${F.esc(c.name)}</td>
                    <td class="num">${c.calls ? F.num(c.calls) : '<span class="text-muted">—</span>'}</td>
                    <td class="num">${c.duration ? F.durHM(c.duration) : '<span class="text-muted">—</span>'}</td>
                    <td class="num strong">${F.eur(c.montant)}</td>
                  </tr>`).join('')}
              </tbody>
            </table></div>
          </div>
          <div class="card">
            <div class="card-title">Top lignes consommatrices <span class="hint">cumul période</span></div>
            ${topLines.map(l => `
              <div class="hbar-row">
                <div class="hbar-label" title="${F.esc(prettifySite(l))} — sous-compte ${F.esc(l.siteId)}">
                  <span class="mono" style="font-weight:600">${F.esc(l.number)}</span>
                  <span class="mono sub" style="margin-left:6px">${F.esc(l.siteId)}</span>
                  <div class="sub">${F.esc(prettifySite(l))}</div></div>
                <div class="hbar-track"><div class="hbar-fill" style="width:${(l.totals.conso / topMax) * 100}%"></div></div>
                <div class="hbar-val">${F.eur(l.totals.conso)}</div>
              </div>`).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>Lignes sans consommation — ${F.monthLabel(S.month)}</span>
            <span class="hint">${noConso.length} lignes · ${F.eur(noConsoTotal)} d'abonnements nets ce mois</span>
          </div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>N° ligne</th><th>Type</th><th>Site</th><th class="num">Abo net / mois</th><th class="num">Mois sans conso</th></tr></thead>
            <tbody>
              ${noConso.slice(0, 24).map(l => `<tr>
                <td class="mono strong">${F.esc(l.number)}</td>
                <td><span class="badge b-mut">${l.familyLabel}</span></td>
                <td>${F.esc(prettifySite(l))}<div class="sub mono">${F.esc(l.siteId)}</div></td>
                <td class="num strong">${F.eur(l.months[S.month]?.net || 0)}</td>
                <td class="num">${l.monthsNoConso} / ${Object.keys(l.months).length}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          ${noConso.length > 24 ? `<div class="tbl-foot">+ ${noConso.length - 24} autres lignes sans consommation</div>` : ''}
        </div>
      </div>`;

    C.bars(document.getElementById('ch-conso'), {
      labels: months.map(F.monthLabelShort),
      series: Object.entries(groupMonths).map(([g, vals]) => ({
        name: GROUP_LABELS[g], values: vals.map(v => +v.toFixed(2)), color: GROUP_COLORS[g],
      })),
      stacked: true,
      fmtV: v => F.eur(v),
      ratio: .46,
    });
    C.donut(document.getElementById('ch-donut'), {
      items: Object.entries(byGroup).sort((a, b) => b[1].montant - a[1].montant)
        .map(([g, v]) => ({ name: GROUP_LABELS[g], value: v.montant, color: GROUP_COLORS[g] })),
      center: { label: F.eurShort(totalMontant), sub: 'brut période' },
      fmt: v => F.eur(v), size: 200,
    });
  }

  window.Views = window.Views || {};
  window.Views.conso = { render, title: 'Consommations' };
})();
