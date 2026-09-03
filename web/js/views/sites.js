/* Vue — Sites : sous-comptes (écoles, services, bâtiments) */
(function () {
  const F = window.fmt, C = window.Charts, S = window.Store;
  const FAM_LABELS = { t0: 'T0', t0_ascenseur: 'Ascenseur', numeris: 'Numéris', canal_sda: 'SDA', residentiel: 'Résid.', internet: 'Internet', autre: 'Autre' };
  const FAM_BADGE = { t0: 'b-t0', t0_ascenseur: 'b-asc', numeris: 'b-num', canal_sda: 'b-sda', residentiel: 'b-res', internet: 'b-web', autre: 'b-mut' };

  const state = { q: '', open: null };

  function render(view) {
    const months = S.visibleMonths();
    let sites = S.sites().map(s => {
      let abo = 0, conso = 0;
      months.forEach(m => { abo += s.months[m]?.abo || 0; conso += s.months[m]?.conso || 0; });
      const nLines = S.lines().filter(l => l.siteId === s.id).length;
      return { s, abo, conso, total: abo + conso, nLines };
    });
    if (state.q) {
      const q = state.q.toLowerCase();
      sites = sites.filter(x => [x.s.name, x.s.dept, x.s.address, x.s.id, x.s.entity]
        .join(' ').toLowerCase().includes(q));
    }
    sites.sort((a, b) => b.total - a.total);
    // le switch « Parc » peut retirer des sites : le dire évite de croire à une perte
    const hidden = state.q ? 0 : S.allSites().length - S.sites().length;
    const grandAbo = sites.reduce((a, x) => a + x.abo, 0);
    const grandConso = sites.reduce((a, x) => a + x.conso, 0);

    view.innerHTML = `
      <div class="wrap">
        <div class="card mb-2">
          <div class="flex" style="flex-wrap:wrap;gap:12px">
            <div class="field grow" style="max-width:360px">
              <label>Rechercher un site</label>
              <input type="search" id="sq" placeholder="École, service, adresse, n° sous-compte…" value="${F.esc(state.q)}">
            </div>
            <div class="flex" style="gap:22px;margin-left:auto;align-items:flex-end">
              <div><div class="kpi-label">Sites</div>
                <div style="font-size:20px;font-weight:700">${sites.length}</div>
                ${hidden > 0 ? `<div class="sub">${hidden} sans ligne en service — masqué${hidden > 1 ? 's' : ''}</div>` : ''}</div>
              <div><div class="kpi-label" title="Abonnements nets et frais ponctuels rattachés aux lignes du site, tels que l'annexe les ventile">Facturé hors conso</div><div style="font-size:20px;font-weight:700">${F.eur(grandAbo, 0)}</div></div>
              <div><div class="kpi-label">Consommations</div><div style="font-size:20px;font-weight:700">${F.eur(grandConso, 0)}</div></div>
            </div>
          </div>
        </div>

        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px" id="sites-grid">
          ${sites.map(x => siteCard(x, months)).join('')}
        </div>
      </div>`;

    document.getElementById('sq').addEventListener('input', e => {
      state.q = e.target.value;
      render(view);
      const q = document.getElementById('sq');
      q.focus(); q.setSelectionRange(q.value.length, q.value.length);
    });
    document.querySelectorAll('[data-site-toggle]').forEach(btn => btn.addEventListener('click', () => {
      state.open = state.open === btn.dataset.siteToggle ? null : btn.dataset.siteToggle;
      render(view);
    }));
  }

  /* Un même bâtiment porte souvent plusieurs sous-comptes facturés séparément :
     le signaler évite de croire qu'un site n'a qu'une ligne. */
  function neighbourHtml(s) {
    if (!s.placeKey) return '';
    const others = S.sites().filter(o => o.placeKey === s.placeKey && o.id !== s.id);
    if (!others.length) return '';
    return `<div class="site-neigh" title="${F.esc(others.map(o => o.id + ' · ' + F.site(o)).join('\n'))}">
      ${Icons.svg('building')} ${others.length} autre${others.length > 1 ? 's' : ''} sous-compte${others.length > 1 ? 's' : ''} à cette adresse</div>`;
  }

  function siteCard(x, months) {
    const s = x.s;
    const fams = Object.entries(s.families || {}).filter(([k]) => k !== 'autre');
    const spark = C.sparkline(months.map(m => (s.months[m]?.abo || 0) + (s.months[m]?.conso || 0)), 'var(--accent)');
    const isOpen = state.open === s.id;
    const lines = S.lines().filter(l => l.siteId === s.id);
    return `
      <div class="card" style="padding:16px 18px">
        <div class="flex-between" style="align-items:flex-start">
          <div style="min-width:0">
            <div style="font-weight:650;font-size:14px;letter-spacing:-.01em">${F.esc(prettifySite(s))}</div>
            <div class="sub text-muted" style="font-size:11.5px;margin-top:2px">${F.esc(F.titleCase(s.address || ''))}</div>
          </div>
          <span class="badge b-mut mono">${s.id}</span>
        </div>
        ${neighbourHtml(s)}
        <div class="flex mt-2" style="gap:6px;flex-wrap:wrap">
          ${fams.map(([k, v]) => `<span class="badge ${FAM_BADGE[k] || 'b-mut'}">${FAM_LABELS[k] || k} × ${v}</span>`).join('')}
        </div>
        <div class="grid mt-2" style="grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:14px">
          <div><div class="kpi-label">Total période</div><div style="font-weight:700;font-size:16px">${F.eur(x.total, 0)}</div></div>
          <div><div class="kpi-label" title="Abonnements nets et frais ponctuels, moyennés sur la période analysée">Hors conso/mois</div><div style="font-weight:600;font-size:14px">${F.eur(x.abo / months.length)}</div></div>
          <div><div class="kpi-label">Conso cumulée</div><div style="font-weight:600;font-size:14px">${F.eur(x.conso)}</div></div>
        </div>
        <div class="mt-2" style="margin-top:10px">${spark}</div>
        ${isOpen ? `
          <div class="section-title" style="margin-top:14px">Lignes du site (${lines.length})</div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>N°</th><th>Type</th><th class="num">Abo net cumulé</th><th class="num">Appels</th></tr></thead>
            <tbody>${lines.map(l => `<tr>
              <td class="mono">${F.esc(l.number)}</td>
              <td><span class="badge ${FAM_BADGE[l.family] || 'b-mut'}">${FAM_LABELS[l.family] || l.family}</span></td>
              <td class="num">${F.eur(l.totals.abo)}</td>
              <td class="num">${F.num(l.totals.calls)}</td></tr>`).join('')}
            </tbody></table></div>`
        : ''}
        <button class="btn btn-ghost btn-sm mt-2" style="margin-top:12px" data-site-toggle="${s.id}">
          ${isOpen ? 'Masquer les lignes' : `Voir les ${x.nLines} ligne${x.nLines > 1 ? 's' : ''}`}
        </button>
      </div>`;
  }

  window.Views = window.Views || {};
  window.Views.sites = {
    render, title: 'Sites',
    setQuery(q) { state.q = q || ''; },
  };
})();
