/* Vue — Remises marché : analyse, évolution, par produit, simulateur */
(function () {
  const F = window.fmt, C = window.Charts, S = window.Store;

  const KIND_LABELS = {
    marche: 'Remises marché', compensation: 'Compensations d\'augmentation', autre: 'Autres remises',
  };
  const KIND_COLORS = { marche: '#0d9b8a', compensation: '#7059e8', autre: '#aab0bf' };

  function render(view) {
    const months = S.visibleMonths();
    const T = S.periodTotals();
    const kinds = S.remisesByKind();
    const brutAbo = T.abo + T.remiseAbo;
    const brutConso = T.conso + T.remiseConso;
    const brut = brutAbo + brutConso;
    // Total de remises = celui de la facture (abonnements + consommations).
    // L'écran additionnait les seules remises d'abonnement plus les avoirs, et
    // annonçait 24 147 € là où le tableau de bord en affichait 24 724 €.
    const totalRem = T.remiseAbo + T.remiseConso;

    // par nature par mois
    const kindMonths = { marche: [], compensation: [], autre: [] };
    months.forEach((mk, i) => {
      const acc = { marche: 0, compensation: 0, autre: 0 };
      S.monthProducts(mk).forEach(p => {
        if (p.isRemise && p.montant && !p.isCredit) acc[p.kind || 'autre'] += -p.montant;
      });
      Object.keys(kindMonths).forEach(k => kindMonths[k][i] = +acc[k].toFixed(2));
    });

    // Rattachement lu sur la facture : plus aucun rapprochement de libellés.
    const rows = S.remiseRows();
    const credits = S.creditRows();
    const creditTotal = credits.reduce((a, c) => a + c.total, 0);

    // Remise obtenue offre par offre — l'unité qui se négocie.
    // Le calcul du manque vit dans le store : l'écran et le dossier de
    // réclamation exporté doivent afficher le même montant au centime.
    const offers = S.offerDiscounts();
    const SEUIL = S.SEUIL_NON_REMISEE;     // en deçà, l'offre est de fait non remisée
    const gap = S.discountGap();
    const nues = gap.offers;
    const refTaux = gap.refTaux;
    const gisement = gap.period;
    // régularisations qui reviennent : le mois isolé est normal, la répétition non
    const recurrents = credits.filter(c => c.months >= 3);
    // remise inscrite dans le nom même du produit, mais jamais portée en facture
    const unapplied = S.unappliedLabelDiscounts();
    const unappliedTotal = unapplied.reduce((a, o) => a + o.manque, 0);
    const unappliedYear = unappliedTotal / Math.max(months.length, 1) * 12;
    const maxRem = Math.max(...rows.map(r => r.total), 1);

    // Simulateur : ce que la période aurait coûté sans remise, frais ponctuels
    // compris — c'est la facture entière qu'on compare, pas ses seuls postes
    // remisables. Le KPI annonçait le brut seul, soit 1 103,60 € de moins que
    // la facture correspondante.
    const sansRem = brut + T.ponctuels;

    // marchés par compte
    const marches = [];
    (S.data.accounts || []).forEach(a => {
      if (S.account !== 'all' && S.account !== a.id) return;
      (a.marches || []).forEach(m => marches.push({ compte: a.id, ...m }));
    });

    view.innerHTML = `
      <div class="wrap">
        <div class="kpi-row mb-3" style="grid-template-columns:repeat(4,1fr)">
          <div class="kpi" style="--k-accent:#0d9b8a;--k-soft:var(--teal-soft)">
            <div class="kpi-ico">${Icons.svg('percent')}</div>
            <div class="kpi-label">Remises totales</div>
            <div class="kpi-value">${F.eur(totalRem, 0)}</div>
            <div class="kpi-delta">sur ${months.length} mois · ${F.eur(totalRem / Math.max(months.length, 1))} / mois</div>
          </div>
          <div class="kpi" style="--k-accent:#f2611b;--k-soft:var(--accent-soft)">
            <div class="kpi-ico">${Icons.svg('euro')}</div>
            <div class="kpi-label">Taux de remise moyen</div>
            <div class="kpi-value">${F.pct(brut > 0 ? (totalRem / brut) * 100 : 0, 1)}</div>
            <!-- brut − remises ne fait pas le total HT : la facture porte aussi
                 des frais ponctuels, qui ne sont ni remisés ni remisables.
                 L'écran posait « brut → net HT » et l'écart, 1 103,60 €, restait
                 sans explication. -->
            <div class="kpi-delta">brut ${F.eur(brut, 0)} → ${F.eur(brut - totalRem, 0)} d'abonnements
              et consommations${T.ponctuels > 0.005
                ? ` <span title="Frais ponctuels facturés en plus : mises en service, interventions, matériel. Hors remise.">+ ${F.eur(T.ponctuels, 0)} de frais ponctuels</span>` : ''}</div>
          </div>
          <div class="kpi" style="--k-accent:#7059e8;--k-soft:var(--violet-soft)">
            <div class="kpi-ico">${Icons.svg('tag')}</div>
            <div class="kpi-label">Remises marché</div>
            <div class="kpi-value">${F.eur(kinds.marche, 0)}</div>
            <div class="kpi-delta">${F.pct(totalRem > 0 ? (kinds.marche / totalRem) * 100 : 0)} des remises</div>
          </div>
          <div class="kpi" style="--k-accent:#2f6fed;--k-soft:var(--blue-soft)">
            <div class="kpi-ico">${Icons.svg('trend')}</div>
            <div class="kpi-label">Sans remises, la période aurait coûté</div>
            <div class="kpi-value">${F.eur(sansRem, 0)}</div>
            <div class="kpi-delta"><span class="up">économie de ${F.eur(totalRem, 0)}</span></div>
          </div>
        </div>

        <div class="grid cols-7-5 mb-3">
          <div class="card">
            <div class="card-title">Évolution des remises par nature</div>
            <div id="ch-rem"></div>
            <div class="legend">
              ${Object.keys(KIND_LABELS).map(k => `<span class="lg"><i style="background:${KIND_COLORS[k]}"></i>${KIND_LABELS[k]}</span>`).join('')}
            </div>
          </div>
          <div class="card">
            <div class="card-title">Marchés &amp; contrats</div>
            ${marches.map(m => `
              <div class="alert-item" style="margin-bottom:8px">
                <div class="alert-ico" style="background:var(--violet-soft);color:var(--violet)">${Icons.svg('tag')}</div>
                <div class="alert-body"><b>${F.esc(m.label)}</b><br>
                  <span class="text-muted">Compte ${m.compte} · ${F.monthLabelShort(m.from)} → ${F.monthLabelShort(m.to)}</span></div>
              </div>`).join('')}
            <div class="section-title">Impact par nature</div>
            ${Object.keys(KIND_LABELS).map(k => `
              <div class="hbar-row">
                <div class="hbar-label">${KIND_LABELS[k]}</div>
                <div class="hbar-track"><div class="hbar-fill" style="width:${(kinds[k] / maxRemKind(kinds)) * 100}%;background:${KIND_COLORS[k]}"></div></div>
                <div class="hbar-val">${F.eurShort(kinds[k])}</div>
              </div>`).join('')}
          </div>
        </div>

        ${unapplied.length ? `
        <div class="card mb-3" style="border-color:#f0b4a8">
          <div class="card-title">
            <span style="color:var(--red)">${Icons.svg('alert')} Remise annoncée par l'offre et jamais appliquée</span>
            <span class="flex" style="gap:10px;align-items:center">
              <span class="hint">${F.eur(unappliedTotal, 0)} sur la période · ${F.eur(unappliedYear, 0)}/an</span>
              <a class="btn btn-sm btn-primary" href="/api/export/reclamation"
                 title="Un poste réclamé par facture, chiffré — constats opposables en premier">
                ${Icons.svg('download')} Dossier de réclamation</a>
            </span>
          </div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Offre facturée</th><th class="num">Mois facturés</th><th class="num">Brut</th>
              <th class="num">Remise annoncée</th><th class="num">Remise appliquée</th>
              <th class="num">Trop facturé</th>
            </tr></thead>
            <tbody>
              ${unapplied.map(o => `<tr class="row-flag">
                <td class="strong">${F.esc(o.name)}</td>
                <td class="num" title="Mois où cette offre est facturée, sur les ${months.length} mois de la période">${o.months}${
                  o.months < months.length ? `<span class="sub"> / ${months.length}</span>` : ''}</td>
                <td class="num">${F.eur(o.brut)}</td>
                <td class="num">${F.pct(o.nominal, 1)}</td>
                <td class="num ${o.taux < 1 ? 'text-red strong' : ''}">${F.pct(o.taux, 1)}</td>
                <td class="num strong text-red">${F.eur(o.manque)}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          <div class="audit-note" style="background:var(--red-soft);color:#8a2c15">
            ${Icons.svg('alert')}
            <div>Le taux n'est pas déduit : il est <b>écrit dans le libellé du produit facturé</b>,
            et la facture ne porte aucune ligne de remise en regard. ${unapplied.every(o => o.months >= months.length)
              ? 'L\'offre est facturée au tarif plein tous les mois de la période.'
              : 'L\'offre est facturée au tarif plein sur chacun des mois où elle apparaît.'}
            C'est le constat le plus direct de cet écran —
            à réclamer avec les factures à l'appui.</div>
          </div>
        </div>` : ''}

        <div class="card mb-3">
          <div class="card-title">
            <span>Remise obtenue offre par offre</span>
            <span class="hint">toutes remises cumulées / brut de l'offre — rattachement lu sur la facture</span>
          </div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Offre facturée</th><th class="num">Brut période</th>
              <th class="num">Remises marché</th><th class="num">Compensations</th>
              <th class="num">Net payé</th><th class="num">Taux obtenu</th><th></th>
            </tr></thead>
            <tbody>
              ${offers.filter(o => o.brut > 50).map(o => {
                const nu = o.taux < SEUIL;
                return `<tr${nu ? ' class="row-flag"' : ''}>
                  <td class="strong">${F.esc(o.name)}</td>
                  <td class="num">${F.eur(o.brut, 0)}</td>
                  <td class="num text-teal">${o.marche ? '−' + F.eur(o.marche, 0) : '<span class="text-muted">—</span>'}</td>
                  <td class="num text-teal">${o.compensation ? '−' + F.eur(o.compensation, 0) : '<span class="text-muted">—</span>'}</td>
                  <td class="num strong">${F.eur(o.net, 0)}</td>
                  <td class="num strong ${nu ? 'text-red' : ''}">${F.pct(o.taux, 1)}</td>
                  <td style="width:110px"><div class="hbar-track"><div class="hbar-fill"
                    style="width:${Math.min(o.taux, 100)}%;background:${nu ? 'var(--red)' : 'var(--teal)'}"></div></div></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
          ${nues.length ? `
          <div class="audit-note">
            ${Icons.svg('alert')}
            <div><b>${nues.length} offre(s) facturée(s) sans remise réelle</b> —
            ${F.esc(nues.map(o => o.name).join(', '))} —
            pour ${F.eur(nues.reduce((a, o) => a + o.brut, 0), 0)} de brut sur la période, quand les
            offres remisées obtiennent ${F.pct(refTaux, 1)} en moyenne.
            Aligner ces offres sur ce taux représenterait <b>${F.eur(gisement, 0)}</b> sur la période,
            soit ${F.eur(gisement / Math.max(months.length, 1) * 12, 0)}/an.
            Le rattachement remise → offre est celui imprimé sur la facture : l'écart ne vient pas
            d'un rapprochement approximatif.</div>
          </div>` : ''}
        </div>

        ${recurrents.length ? `
        <div class="card mb-3">
          <div class="card-title">
            <span>Régularisations répétées — paramétrage à corriger</span>
            <span class="hint">${recurrents.length} libellé(s) revenant sur 3 mois ou plus</span>
          </div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Libellé</th><th class="num">Mois concernés</th><th class="num">Cumul</th></tr></thead>
            <tbody>
              ${recurrents.map(c => `<tr>
                <td class="strong">${F.esc(c.name)}</td>
                <td class="num">${c.months}</td>
                <td class="num strong text-teal">−${F.eur(Math.abs(c.total))}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          <div class="audit-note">
            ${Icons.svg('alert')}
            <div>Un avoir isolé corrige une erreur ponctuelle. Le même libellé qui revient
            ${recurrents[0].months} mois de suite signale un abonnement resté mal paramétré :
            l'opérateur rembourse chaque mois au lieu de corriger la ligne. C'est la cause qu'il
            faut faire traiter — les avoirs, eux, sont déjà à votre crédit.</div>
          </div>
        </div>` : ''}

        <div class="card mb-3">
          <div class="card-title">
            <span>Détail des remises par offre</span>
            <span class="flex" style="gap:10px;align-items:center">
              <span class="hint">offre remisée et taux lus sur la facture · cumul période</span>
              <a class="btn btn-ghost btn-sm" href="/api/export/remises"
                 title="Une ligne par remise, avec le n° de facture où elle figure — vérifiable sur le PDF">
                ${Icons.svg('download')} Export réclamation</a>
            </span>
          </div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Remise</th><th>Nature</th><th>Offre remisée</th>
              <th class="num">Brut remisé</th><th class="num">Remise</th>
              <th class="num">Taux obtenu</th><th class="num">Annoncé</th><th></th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `<tr>
                <td class="strong">${F.esc(r.name)}</td>
                <td><span class="badge ${r.kind === 'marche' ? 'b-ok' : r.kind === 'compensation' ? 'b-num' : 'b-mut'}">${KIND_LABELS[r.kind]}</span></td>
                <td>${r.base ? F.esc(r.base) : '<span class="text-muted">—</span>'}</td>
                <td class="num">${r.brut ? F.eur(r.brut) : '<span class="text-muted">—</span>'}</td>
                <td class="num strong text-teal">−${F.eur(r.total)}</td>
                <td class="num strong">${r.taux !== null ? F.pct(r.taux, 1) : '<span class="text-muted">—</span>'}</td>
                <td class="num ${r.nominal && r.taux !== null && r.nominal - r.taux > 1 ? 'text-red' : 'text-muted'}">${
                  r.nominal ? F.pct(r.nominal, 1) : '—'}</td>
                <td style="width:110px"><div class="hbar-track"><div class="hbar-fill" style="width:${(r.total / maxRem) * 100}%;background:${KIND_COLORS[r.kind]}"></div></div></td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          <div class="audit-note">
            ${Icons.svg('info')}
            <div>Le taux obtenu est inférieur au taux annoncé sur la plupart des lignes, et
            l'écart est <b>stable au centime d'un mois à l'autre</b> : la remise marché porte sur le
            tarif de référence du marché, pas sur le prix courant, et ce sont les lignes
            « compensation augmentation » qui rattrapent les hausses depuis. Une remise prise
            isolément n'est donc pas comparable à son libellé — c'est le
            <b>cumul par offre</b> ci-dessus qui fait foi.</div>
          </div>
          <!-- Ce tableau ne porte que les remises rattachées à une offre de
               l'annexe, c'est-à-dire les remises d'abonnement. Il annonçait
               « exactement la ligne remises de la facture » — 22 954,47 € contre
               24 723,76 € au compteur du haut, l'écart étant les remises de
               consommation, qui ne se rattachent à aucune offre. -->
          <div class="tbl-foot">Somme des remises d'abonnement : ${F.eur(rows.reduce((a, r) => a + r.total, 0))}
            — soit exactement la ligne « remises d'abonnement » des ${months.length} mois de factures.
            ${T.remiseConso > 0.005 ? `S'y ajoutent ${F.eur(T.remiseConso)} de remises sur les
              consommations, qui ne portent sur aucune offre de l'annexe : c'est la somme des deux
              qui fait le total de ${F.eur(totalRem)} affiché en haut de page.` : ''}</div>
        </div>

        ${credits.length ? `
        <div class="card">
          <div class="card-title">
            <span>Avoirs et régularisations</span>
            <span class="hint">${credits.length} libellé(s) · solde ${F.eur(creditTotal)} sur la période</span>
          </div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Libellé</th><th class="num">Occurrences</th><th class="num">Montant</th></tr></thead>
            <tbody>
              ${credits.slice(0, 12).map(c => `<tr>
                <td>${F.esc(c.name)}</td>
                <td class="num">${c.occurrences}</td>
                <td class="num strong ${c.total < 0 ? 'text-teal' : ''}">${c.total < 0 ? '−' : ''}${F.eur(Math.abs(c.total))}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          ${credits.length > 12 ? `<div class="tbl-foot">+ ${credits.length - 12} autre(s) libellé(s)</div>` : ''}
          <div class="audit-note">
            ${Icons.svg('info')}
            <div>Ce sont des lignes facturées pour elles-mêmes — quantité négative et prix unitaire
            propre — et non des remises sur une offre. Les compter comme des remises gonflait le
            taux de remise moyen sans qu'aucune offre n'ait été négociée.</div>
          </div>
        </div>` : ''}
      </div>`;

    C.bars(document.getElementById('ch-rem'), {
      labels: months.map(F.monthLabelShort),
      series: Object.keys(KIND_LABELS).map(k => ({
        name: KIND_LABELS[k], values: kindMonths[k], color: KIND_COLORS[k],
      })),
      stacked: true,
      fmtV: v => F.eur(v),
      ratio: .44,
    });
  }

  function maxRemKind(kinds) { return Math.max(kinds.marche, kinds.compensation, kinds.autre, 1); }

  window.Views = window.Views || {};
  window.Views.remises = { render, title: 'Remises marché' };
})();
