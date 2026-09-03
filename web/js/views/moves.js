/* Vue — Mouvements du parc : ce qui a disparu et ce qui est apparu entre deux
   mois de facture.

   La vue Lignes sait dire qu'une ligne est « résiliée », mais toujours par
   rapport à la dernière facture de son compte. Pour contrôler une résiliation
   demandée en avril, ou expliquer une marche d'escalier sur la courbe du parc,
   il faut pouvoir fixer soi-même les deux bornes. */
(function () {
  const F = window.fmt, S = window.Store;

  // null = on prend les bornes de la période visible tant que l'utilisateur
  // n'a pas choisi ; un mois disparu du filtre ne doit pas rester collé.
  const state = { from: null, to: null, fams: new Set() };

  const FAM_ORDER = ['t0', 't0_ascenseur', 'numeris', 'canal_sda', 'residentiel',
    'internet', 'autre'];

  function bounds() {
    const ms = S.visibleMonths();
    if (!ms.length) return { ms, from: null, to: null };
    const from = ms.includes(state.from) ? state.from : ms[0];
    const to = ms.includes(state.to) ? state.to : ms[ms.length - 1];
    // deux bornes inversées donneraient des listes vides sans rien expliquer
    return { ms, from: from <= to ? from : to, to: from <= to ? to : from };
  }

  function compare(from, to) {
    const lines = S.allLines();
    const gone = [], added = [], kept = [];
    lines.forEach(l => {
      const a = l.months[from], b = l.months[to];
      if (a && !b) gone.push({ line: l, net: a.net, at: a });
      else if (!a && b) added.push({ line: l, net: b.net, at: b });
      else if (a && b) kept.push({ line: l, from: a.net, to: b.net });
    });
    gone.sort((x, y) => y.net - x.net);
    added.sort((x, y) => y.net - x.net);
    return { gone, added, kept };
  }

  /* Le filtre de type porte sur toute la comparaison — mouvements ET parc :
     restreindre les seules listes laisserait les compteurs de parc annoncer un
     effectif que le tableau en dessous ne montre pas. */
  /* Deux effectifs par type, et ils ne disent pas la même chose : les
     mouvements (ce que les tableaux montrent) et le parc concerné (ce sur quoi
     portent les compteurs de parc). Le chip affiche les mouvements — il
     annonçait « T0 ascenseur 7 » alors qu'aucune de ces sept lignes n'avait
     bougé, et on cliquait pour tomber sur deux tableaux vides. */
  function famCounts(cmp) {
    const counts = {};
    const get = (x) => {
      const f = x.line.family || 'autre';
      return counts[f] || (counts[f] = {
        fam: f, label: x.line.familyLabel || f, mv: 0, parc: 0,
      });
    };
    [cmp.gone, cmp.added].forEach(rows => rows.forEach(x => {
      const e = get(x); e.mv += 1; e.parc += 1;
    }));
    cmp.kept.forEach(x => { get(x).parc += 1; });
    return counts;
  }

  function restrict(cmp) {
    if (!state.fams.size) return cmp;
    const keep = rows => rows.filter(x => state.fams.has(x.line.family || 'autre'));
    return { gone: keep(cmp.gone), added: keep(cmp.added), kept: keep(cmp.kept) };
  }

  function monthOptions(ms, sel) {
    return ms.map(m => `<option value="${m}"${m === sel ? ' selected' : ''}>${F.monthLabel(m)}</option>`).join('');
  }

  function table(rows, kind) {
    if (!rows.length) {
      return `<div class="empty">${Icons.svg('check-c')}<div>${
        kind === 'gone' ? 'Aucune ligne retirée entre ces deux mois.'
                        : 'Aucune ligne ajoutée entre ces deux mois.'}</div></div>`;
    }
    return `<div class="tbl-wrap"><table class="tbl">
      <thead><tr>
        <th>N° de ligne</th><th>Type</th><th>Site</th>
        <th class="num">${kind === 'gone' ? 'Coût au départ' : 'Coût à l\'arrivée'}</th>
        <th>${kind === 'gone' ? 'Dernière facture' : 'Première facture'}</th>
      </tr></thead>
      <tbody>
        ${rows.map(x => `<tr>
          <td class="mono strong">${F.esc(x.line.number)}</td>
          <td><span class="badge b-mut">${F.esc(x.line.familyLabel)}</span></td>
          <td>${F.esc(F.site(x.line))}<div class="sub mono">${F.esc(x.line.siteId)}</div></td>
          <td class="num strong">${F.eur(x.net)}</td>
          <td class="sub">${F.monthLabelShort(kind === 'gone' ? x.line.last : x.line.first)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  }

  function render(view) {
    const { ms, from, to } = bounds();
    if (!from || !to) {
      view.innerHTML = `<div class="wrap"><div class="card"><div class="empty">
        ${Icons.svg('alert')}<div>Aucun mois facturé sur la période retenue.</div></div></div></div>`;
      return;
    }
    const all = compare(from, to);
    const counts = famCounts(all);
    // un type disparu de la comparaison ne doit pas rester coché en silence
    state.fams.forEach(f => { if (!counts[f]) state.fams.delete(f); });
    const { gone, added, kept } = restrict(all);
    const totalMv = all.gone.length + all.added.length;
    const totalParc = totalMv + all.kept.length;
    const famChips = FAM_ORDER.filter(f => counts[f])
      .concat(Object.keys(counts).filter(f => !FAM_ORDER.includes(f)));
    // les effectifs de parc suivent le filtre : le dire, sinon on croit lire
    // le parc entier
    const famNote = !state.fams.size ? ''
      : state.fams.size === 1 ? ` · ${F.esc(counts[[...state.fams][0]].label)}`
      : ` · ${state.fams.size} types`;
    const goneCost = gone.reduce((a, x) => a + x.net, 0);
    const addedCost = added.reduce((a, x) => a + x.net, 0);
    const nFrom = gone.length + kept.length;
    const nTo = added.length + kept.length;

    view.innerHTML = `
      <div class="wrap">
        <div class="card mb-2">
          <div class="flex" style="gap:14px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label>Mois de départ</label>
              <select id="mv-from">${monthOptions(ms, from)}</select></div>
            <div class="field" style="align-self:center;padding-top:14px">${Icons.svg('arrow-r')}</div>
            <div class="field"><label>Mois d'arrivée</label>
              <select id="mv-to">${monthOptions(ms, to)}</select></div>
            <div class="flex" style="gap:22px;margin-left:auto;align-items:flex-end">
              <div><div class="kpi-label">Parc au départ${famNote}</div>
                <div style="font-size:20px;font-weight:700">${F.num(nFrom)}</div></div>
              <div><div class="kpi-label">Parc à l'arrivée${famNote}</div>
                <div style="font-size:20px;font-weight:700">${F.num(nTo)}</div></div>
              <div><div class="kpi-label">Écart</div>
                <div style="font-size:20px;font-weight:700;color:${nTo - nFrom <= 0 ? 'var(--green)' : 'var(--red)'}">
                  ${nTo - nFrom > 0 ? '+' : ''}${F.num(nTo - nFrom)}</div></div>
              <a class="btn btn-ghost btn-sm" id="mv-export">${Icons.svg('download')} Exporter</a>
            </div>
          </div>
          <div class="chip-row mt-2" id="mv-fams">
            <span class="chip ${state.fams.size === 0 ? 'on' : ''}" data-fam=""
              title="${F.num(totalMv)} mouvement(s) · ${F.num(totalParc)} ligne(s) concernées au total"
              >Tous les types <span class="cnt">${F.num(totalMv)}</span></span>
            ${famChips.map(f => {
              const c = counts[f];
              return `<span class="chip ${c.mv ? '' : 'chip-quiet'} ${state.fams.has(f) ? 'on' : ''}" data-fam="${f}"
                title="${c.mv ? `${F.num(c.mv)} mouvement(s)` : 'aucun mouvement entre ces deux mois'} · ${F.num(c.parc)} ligne(s) de ce type au parc"
                >${F.esc(c.label)} <span class="cnt">${F.num(c.mv)}</span></span>`;
            }).join('')}
          </div>
        </div>

        <div class="kpi-row mb-3" style="grid-template-columns:repeat(3,1fr)">
          <div class="kpi" style="--k-accent:var(--green);--k-soft:var(--green-soft)">
            <div class="kpi-ico">${Icons.svg('phone-off')}</div>
            <div class="kpi-label">Lignes retirées</div>
            <div class="kpi-value">${F.num(gone.length)}</div>
            <div class="kpi-delta"><span class="up">${F.eur(goneCost)}/mois de moins · ${F.eur(goneCost * 12, 0)}/an</span></div>
          </div>
          <div class="kpi" style="--k-accent:var(--red);--k-soft:var(--red-soft)">
            <div class="kpi-ico">${Icons.svg('phone')}</div>
            <div class="kpi-label">Lignes ajoutées</div>
            <div class="kpi-value">${F.num(added.length)}</div>
            <div class="kpi-delta"><span class="down">${F.eur(addedCost)}/mois de plus</span></div>
          </div>
          <div class="kpi" style="--k-accent:var(--blue);--k-soft:var(--blue-soft)">
            <div class="kpi-ico">${Icons.svg('phone')}</div>
            <div class="kpi-label">Lignes présentes aux deux dates</div>
            <div class="kpi-value">${F.num(kept.length)}</div>
            <div class="kpi-delta"><span>parc stable</span></div>
          </div>
        </div>

        <div class="card mb-3">
          <div class="card-title">
            <span>Lignes présentes en ${F.monthLabel(from)} et absentes en ${F.monthLabel(to)}</span>
            <span class="hint">résiliations ou transferts · ${F.eur(goneCost)}/mois</span>
          </div>
          ${table(gone, 'gone')}
        </div>

        <div class="card">
          <div class="card-title">
            <span>Lignes apparues entre ${F.monthLabelShort(from)} et ${F.monthLabelShort(to)}</span>
            <span class="hint">${added.length} ligne(s) · ${F.eur(addedCost)}/mois</span>
          </div>
          ${table(added, 'added')}
        </div>
      </div>`;

    const rerender = () => render(view);
    document.getElementById('mv-from').addEventListener('change', e => {
      state.from = e.target.value; rerender();
    });
    document.getElementById('mv-to').addEventListener('change', e => {
      state.to = e.target.value; rerender();
    });
    document.querySelectorAll('#mv-fams .chip').forEach(ch => ch.addEventListener('click', () => {
      const f = ch.dataset.fam;
      if (!f) state.fams.clear();
      else if (state.fams.has(f)) state.fams.delete(f);
      else state.fams.add(f);
      rerender();
    }));
    document.getElementById('mv-export').addEventListener('click', () => {
      // le CSV exporte ce que l'écran montre : un export plus large que le
      // filtre affiché ne se relit pas
      const q = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
        + (S.account !== 'all' ? `&account=${encodeURIComponent(S.account)}` : '')
        + (state.fams.size ? `&family=${encodeURIComponent([...state.fams].join(','))}` : '');
      window.open('/api/export/mouvements' + q, '_blank');
    });
  }

  window.Views = window.Views || {};
  window.Views.moves = { render, title: 'Mouvements du parc' };
})();
