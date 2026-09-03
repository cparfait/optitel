/* Vue — Audit : leviers d'économie chiffrés et anomalies de facturation */
(function () {
  const F = window.fmt, C = window.Charts, S = window.Store;

  const FAM_COLORS = {
    t0: '#2f6fed', t0_ascenseur: '#d98c0d', numeris: '#7059e8',
    canal_sda: '#0d9b8a', internet: '#f2611b', residentiel: '#8b93a5',
  };

  function render(view) {
    const sav = S.savings();
    const fams = S.discountByFamily();
    const outliers = S.lineDiscountOutliers();
    const shifts = S.marketShifts();
    const events = S.priceEvents(10, 1);
    const regs = S.regularisations();
    const T = S.periodTotals();

    // référence de comparaison : meilleur taux obtenu toutes familles confondues
    const bestFam = fams.reduce((a, f) => (f.taux > (a ? a.taux : -1) ? f : a), null);
    const weak = fams.filter(f => bestFam && f.taux < bestFam.taux - 15 && f.brut > 100);

    view.innerHTML = `
      <div class="wrap">
        ${headline(sav, T)}

        <div class="grid cols-7-5 mb-3">
          ${discountCard(fams, bestFam, weak)}
          ${marketCard(shifts)}
        </div>

        ${outlierCard(outliers)}
        ${eventsCard(events)}
        ${regsCard(regs)}
      </div>`;

    // jauges de remise par famille
    fams.forEach(f => {
      const el = document.getElementById('gauge-' + f.family);
      if (el) el.style.width = Math.min(f.taux, 100) + '%';
    });
  }

  /* Bandeau d'ouverture : le chiffre qui décide de l'action. */
  function headline(sav, T) {
    const pct = T.ht > 0 ? (sav.total.yearly / (T.ht * (12 / Math.max(S.visibleMonths().length, 1)))) * 100 : 0;
    // Tout le gisement n'a pas le même degré de certitude : une remise annoncée
    // et non appliquée se réclame, une ligne dormante se décide en interne, un
    // écart de remise entre offres dépend de la grille du marché. Les additionner
    // sans le dire donnerait un chiffre qu'on ne peut pas défendre tel quel.
    const acquis = sav.unapplied.yearly + sav.dormant.yearly;
    return `
      <div class="audit-hero mb-3">
        <div class="ah-main">
          <div class="ah-label">Gisement d'économies identifié</div>
          <div class="ah-value">${F.eur(sav.total.yearly, 0)}<span>/an</span></div>
          <div class="ah-sub">${F.eur(sav.total.monthly)} par mois · ${F.pct(pct, 1)} de la dépense annualisée</div>
          <div class="ah-sub" style="margin-top:8px;opacity:.85">
            dont <b>${F.eur(acquis, 0)}/an</b> sans dépendre du marché
            (remise non appliquée + lignes dormantes)<br>
            et ${F.eur(sav.discount.yearly, 0)}/an suspendus à la grille de prix du marché
          </div>
        </div>
        <div class="ah-split">
          ${lever('Lignes dormantes', sav.dormant, 'phone-off', 'var(--amber)',
            'Aucun appel sur la période — résiliation ou mutualisation', '#/lines?filter=dormant')}
          ${sav.unapplied.n ? lever('Remise jamais appliquée', sav.unapplied, 'alert', 'var(--red)',
            'Remise annoncée dans le libellé du produit facturé et absente de la facture — réclamation directe', '#/remises', 'offre') : ''}
          ${lever('Offres non remisées', sav.discount, 'percent', 'var(--teal)',
            'Offres facturées sans remise là où les autres obtiennent 50 à 62 % — à confronter au marché', '#/remises', 'offre')}
          ${lever('Parc cuivre', sav.copper, 'swap', 'var(--accent)',
            'À migrer avant fermeture du RTC — coût actuel, non économisable en l\'état', '#/copper')}
        </div>
      </div>`;
  }

  function lever(title, v, ico, color, help, href, unit) {
    unit = unit || 'ligne';
    return `<a class="ah-lever" href="${href}" title="${F.esc(help)}">
      <span class="ahl-ico" style="color:${color}">${Icons.svg(ico)}</span>
      <span class="ahl-body">
        <span class="ahl-title">${title}</span>
        <span class="ahl-val">${F.eur(v.yearly, 0)}<small>/an</small></span>
        <span class="ahl-sub">${v.n} ${unit}${v.n > 1 ? 's' : ''} · ${F.eur(v.monthly)}/mois</span>
      </span></a>`;
  }

  /* Couverture des remises : c'est ici qu'on voit qu'une famille est mal négociée. */
  function discountCard(fams, bestFam, weak) {
    return `
      <div class="card">
        <div class="card-title">Couverture des remises par type de ligne
          <span class="hint">part du brut effacée par les remises marché · période retenue</span></div>
        ${fams.map(f => `
          <div class="gauge-row">
            <div class="gauge-head">
              <span class="gauge-name">
                <i style="background:${FAM_COLORS[f.family] || '#8b93a5'}"></i>${F.esc(f.label)}
                <span class="sub">${f.lines} ligne${f.lines > 1 ? 's' : ''}${f.noDiscount ? ` · ${f.noDiscount} sans remise` : ''}</span>
              </span>
              <span class="gauge-val ${bestFam && f.taux < bestFam.taux - 15 ? 'weak' : ''}">${F.pct(f.taux, 1)}</span>
            </div>
            <div class="gauge-track"><div class="gauge-fill" id="gauge-${f.family}"
              style="background:${FAM_COLORS[f.family] || '#8b93a5'}"></div></div>
            <div class="gauge-foot">brut ${F.eur(f.brut, 0)} · remisé ${F.eur(f.remise, 0)}</div>
          </div>`).join('')}
        ${weak.length ? `
          <div class="audit-note">
            ${Icons.svg('alert')}
            <div><b>${weak.map(f => F.esc(f.label)).join(', ')}</b> ${weak.length > 1 ? 'obtiennent' : 'obtient'}
            nettement moins que ${F.esc(bestFam.label)} (${F.pct(bestFam.taux, 1)}).
            Sur ${F.eur(weak.reduce((a, f) => a + f.brut, 0), 0)} de brut, aligner le taux représenterait
            <b>${F.eur(weak.reduce((a, f) => a + f.brut * (bestFam.taux - f.taux) / 100, 0), 0)}</b>
            sur la période — à confronter au bordereau du marché avant toute réclamation.</div>
          </div>` : ''}
      </div>`;
  }

  /* Effet d'un changement de marché, volume et prix séparés. */
  function marketCard(shifts) {
    if (!shifts.length) {
      return `<div class="card"><div class="card-title">Changement de marché</div>
        <div class="empty">${Icons.svg('check-c')}<div>Aucune bascule de marché sur la période.</div></div></div>`;
    }
    return `
      <div class="card">
        <div class="card-title">Effet des changements de marché
          <span class="hint">volume et tarif séparés</span></div>
        ${shifts.map(s => {
          const v = s.variance;
          const up = v.unitPct > 0;
          return `
          <div class="shift">
            <div class="shift-head">
              <span class="badge b-mut mono">${F.esc(s.account)}</span>
              <span class="shift-arrow">${F.esc(s.from.replace('MARCHE ', ''))} → <b>${F.esc(s.to.replace('MARCHE ', ''))}</b></span>
              <span class="sub">moyenne ${v.from.span} mois avant vs ${v.to.span} après</span>
            </div>
            <div class="shift-unit ${up ? 'up-bad' : 'down-good'}">
              ${Icons.svg(up ? 'trend-d' : 'trend')}
              <span><b>${up ? '+' : ''}${F.pct(v.unitPct, 1)}</b> sur le coût moyen par ligne
              <span class="sub">${F.eur(v.from.unit)} → ${F.eur(v.to.unit)}</span></span>
            </div>
            <div class="shift-split">
              <div><span class="kpi-label">Effet volume</span>
                <b class="${v.volume <= 0 ? 'text-green' : 'text-red'}">${v.volume > 0 ? '+' : ''}${F.eur(v.volume)}</b>
                <span class="sub">${v.to.n - v.from.n > 0 ? '+' : ''}${F.num1(v.to.n - v.from.n)} ligne(s)</span></div>
              <div><span class="kpi-label">Effet tarif</span>
                <b class="${v.price <= 0 ? 'text-green' : 'text-red'}">${v.price > 0 ? '+' : ''}${F.eur(v.price)}</b>
                <span class="sub">à parc constant</span></div>
              <div><span class="kpi-label">Écart facturé</span>
                <b class="${v.delta <= 0 ? 'text-green' : 'text-red'}">${v.delta > 0 ? '+' : ''}${F.eur(v.delta)}</b>
                <span class="sub">par mois</span></div>
            </div>
            ${s.volatile ? `<div class="shift-warn">${Icons.svg('alert')}
              <span>Écart sensible à la fenêtre retenue : un mois isolé donne un résultat très différent
              (avoir ou régularisation à cheval sur la bascule). À recouper avec le bordereau de prix.</span>
            </div>` : ''}
          </div>`;
        }).join('')}
        <div class="audit-note">
          ${Icons.svg('info')}
          <div>Une baisse du montant facturé peut masquer une hausse tarifaire quand des lignes
          sont résiliées en parallèle. L'<b>effet tarif</b> isole ce qui relève de la grille de prix.</div>
        </div>
      </div>`;
  }

  /* Contrôle ligne à ligne : deux lignes facturées pour la même offre doivent
     recevoir la même remise. Un tableau vide est un résultat, pas une absence —
     il faut le dire, sinon on ne sait pas si le contrôle a tourné. */
  function outlierCard(outliers) {
    if (!outliers.length) {
      const n = S.activeLines().length;
      // Ces taux étaient écrits en dur dans le texte — « Ligne Fixe Simple à
      // 50,5 % » quand les factures en donnaient 51,7 %. Un exemple chiffré doit
      // se lire dans les données, sinon l'écran affirme des chiffres que sa
      // propre page contredit.
      const remisees = S.offerDiscounts()
        .filter(o => o.taux >= S.SEUIL_NON_REMISEE).slice(0, 3);
      return `
        <div class="card mb-3">
          <div class="card-title">
            <span>Contrôle : remise identique à offre identique</span>
            <span class="hint">${n} lignes en service comparées à leurs jumelles</span>
          </div>
          <div class="empty">${Icons.svg('check-c')}
            <div><b>Aucune ligne sous-remisée par rapport à ses jumelles.</b><br>
            Pour chaque offre, toutes les lignes reçoivent le même taux${remisees.length
              ? ` — ${remisees.map(o => `${F.esc(o.name)} à ${F.pct(o.taux, 1)}`).join(', ')}` : ''}.
            L'écart de remise ne vient donc pas de lignes oubliées, mais des
            <a href="#/remises">offres non remisées</a>.</div>
          </div>
        </div>`;
    }
    const total = outliers.reduce((a, x) => a + x.manque, 0);
    return `
      <div class="card mb-3">
        <div class="card-title">
          <span style="color:var(--red)">${Icons.svg('alert')} Lignes moins remisées que leurs jumelles</span>
          <span class="hint">${outliers.length} ligne(s) · ${F.eur(total)} toutes factures confondues</span>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>N° de ligne</th><th>Site</th><th>Offre</th>
            <th class="num">Brut</th><th class="num">Taux obtenu</th>
            <th class="num">Taux des jumelles</th><th class="num">Écart</th></tr></thead>
          <tbody>
            ${outliers.slice(0, 15).map(x => `
              <tr class="row-flag">
                <td class="mono strong">${F.esc(x.line.number)}</td>
                <td>${F.esc(F.site(x.line))}<div class="sub mono">${F.esc(x.line.siteId)}</div></td>
                <td>${F.esc(x.offer)}</td>
                <td class="num">${F.eur(x.brut)}</td>
                <td class="num strong text-red">${F.pct(x.taux, 1)}</td>
                <td class="num">${F.pct(x.median, 1)}</td>
                <td class="num strong text-red">${F.eur(x.manque)}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
        ${outliers.length > 15 ? `<div class="tbl-foot">+ ${outliers.length - 15} autre(s) ligne(s)</div>` : ''}
      </div>`;
  }

  function eventsCard(events) {
    if (!events.length) return '';
    return `
      <div class="card mb-3">
        <div class="card-title">
          <span>Événements tarifaires</span>
          <span class="hint">mois où plusieurs lignes renchérissent d'un coup — signe d'un changement de grille</span>
        </div>
        ${events.slice(0, 4).map(e => `
          <div class="evt">
            <div class="evt-month">${F.monthLabel(e.month)}</div>
            <div class="evt-bar">
              <div class="evt-count">${e.lines.length} ligne(s) en hausse</div>
              <div class="evt-track"><div class="evt-fill"
                style="width:${Math.min(e.lines.length / events[0].lines.length * 100, 100)}%"></div></div>
            </div>
            <div class="evt-delta">+${F.eur(e.delta)}<span class="sub">/mois</span></div>
          </div>`).join('')}
      </div>`;
  }

  function regsCard(regs) {
    if (!regs.length) return '';
    const net = regs.reduce((a, r) => a + r.total, 0);
    return `
      <div class="card">
        <div class="card-title">
          <span>Régularisations facturées</span>
          <span class="hint">${regs.length} libellé(s) · solde net ${net >= 0 ? '+' : ''}${F.eur(net)} toutes factures confondues</span>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Libellé</th><th class="num">Lignes touchées</th><th class="num">Montant cumulé</th></tr></thead>
          <tbody>
            ${regs.slice(0, 10).map(r => `
              <tr>
                <td>${F.esc(r.name)}</td>
                <td class="num">${r.lines}</td>
                <td class="num strong ${r.total < 0 ? 'text-teal' : ''}">${r.total < 0 ? '−' : ''}${F.eur(Math.abs(r.total))}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
        <div class="audit-note">
          ${Icons.svg('info')}
          <div>Une régularisation isolée est normale. Un libellé qui revient chaque mois
          traduit un abonnement mal paramétré : c'est la cause qu'il faut faire corriger, pas l'écriture.</div>
        </div>
      </div>`;
  }

  window.Views = window.Views || {};
  window.Views.audit = { render, title: 'Audit & économies' };
})();
