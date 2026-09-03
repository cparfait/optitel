/* Vue — Sites : sous-comptes (écoles, services, bâtiments) */
(function () {
  const F = window.fmt, C = window.Charts, S = window.Store;
  const FAM_LABELS = { t0: 'T0', t0_ascenseur: 'Ascenseur', numeris: 'Numéris', canal_sda: 'SDA', residentiel: 'Résid.', internet: 'Internet', autre: 'Autre' };
  const FAM_BADGE = { t0: 'b-t0', t0_ascenseur: 'b-asc', numeris: 'b-num', canal_sda: 'b-sda', residentiel: 'b-res', internet: 'b-web', autre: 'b-mut' };

  const state = { q: '', open: null, ambOpen: false };

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
      // le nom d'usage est cherché au même titre que celui de la facture :
      // un site renommé doit se retrouver sous le nom qu'on lui a donné
      sites = sites.filter(x => [F.siteOverride(x.s), x.s.name, x.s.dept,
        x.s.address, x.s.id, x.s.entity].join(' ').toLowerCase().includes(q));
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

        ${ambiguousCard()}

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
    const ambBtn = document.getElementById('amb-toggle');
    if (ambBtn) ambBtn.addEventListener('click', () => { state.ambOpen = !state.ambOpen; render(view); });
    document.querySelectorAll('[data-rename]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      const s = (S.data.sites || []).find(x => x.id === btn.dataset.rename);
      if (s) openRename(s, () => render(view));
    }));
  }

  /* Saisie du nom d'usage. Le nom facturé est rappelé et jamais modifié :
     c'est lui qui permet de retrouver le sous-compte sur le PDF. */
  function openRename(site, onSaved) {
    const box = document.createElement('div');
    box.className = 'palette-backdrop open';
    box.innerHTML = `
      <div class="palette" style="max-width:480px" role="dialog" aria-modal="true">
        <div class="palette-head" style="gap:12px">
          <span class="palette-ico">${Icons.svg('building')}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:650">Renommer un site</div>
            <div class="sub">${F.esc(site.id)} · ${F.esc(F.titleCase(site.address || ''))}</div>
          </div>
          <button class="icon-btn" data-cancel>${Icons.svg('x')}</button>
        </div>
        <div class="palette-body" style="padding:16px">
          <div class="field mb-2">
            <label>Nom sur la facture</label>
            <div class="flex" style="min-height:34px;align-items:center;color:var(--muted)">
              ${F.esc(F.siteBilled(site)) || '—'}</div>
          </div>
          <div class="field">
            <label>Nom d'usage</label>
            <input id="sr-name" type="text" maxlength="80"
                   placeholder="Ex. Mairie — Service Jeunesse"
                   value="${F.esc(F.siteOverride(site))}">
          </div>
          <div class="sub" style="margin-top:8px">Laisser vide pour revenir au nom de la facture.</div>
        </div>
        <div class="palette-foot" style="justify-content:flex-end;gap:8px">
          <button class="btn btn-ghost btn-sm" data-cancel>Annuler</button>
          <button class="btn btn-sm btn-primary" id="sr-save">Enregistrer</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    const close = () => box.remove();
    box.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', close));
    box.addEventListener('mousedown', e => { if (e.target === box) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    const input = box.querySelector('#sr-name');
    const save = async () => {
      const btn = box.querySelector('#sr-save');
      btn.disabled = true; btn.textContent = 'Enregistrement…';
      try {
        await S.setSiteName(site.id, input.value);
        close();
        window.toast(input.value.trim()
          ? `Site renommé : ${input.value.trim()}`
          : 'Nom de la facture rétabli');
        onSaved && onSaved();
        window.App.fillEntity();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Enregistrer';
        window.toast(err.message, 'err');
      }
    };
    box.querySelector('#sr-save').addEventListener('click', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    setTimeout(() => input.focus(), 30);
  }

  /* Rappel des sites que la facture nomme de façon ambiguë.

     C'est un rappel, pas le contenu de la page : replié, il tient sur une ligne.
     Déplié il occupait tout l'écran et repoussait les fiches de sites — avec
     leurs lignes et leurs consommations — largement sous le pli. */
  function ambiguousCard() {
    const groups = S.ambiguousSiteGroups()
      .map(g => ({ ...g, sites: g.sites.filter(s => S.account === 'all' || s.account === S.account) }))
      .filter(g => g.sites.length > 1);
    if (!groups.length) return '';
    const n = groups.reduce((a, g) => a + g.sites.length, 0);
    return `
      <div class="notice mb-2">
        <span class="notice-ico">${Icons.svg('alert')}</span>
        <div class="notice-body">
          <b>${groups.length} nom${groups.length > 1 ? 's' : ''} de site</b>
          port${groups.length > 1 ? 'és' : 'é'} par plusieurs bâtiments
          — ${n} sous-comptes qu'on ne peut pas distinguer sur une liste.
        </div>
        <button class="btn btn-ghost btn-sm" id="amb-toggle">
          ${state.ambOpen ? 'Masquer' : 'Voir et renommer'}</button>
      </div>
      ${state.ambOpen ? `
      <div class="card mb-2">
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Nom sur la facture</th><th>Sous-compte</th><th>Adresse</th><th></th></tr></thead>
          <tbody>
            ${groups.map(g => g.sites.map((s, i) => `
              <tr>
                <td>${i === 0 ? `<b>${F.esc(F.titleCase(g.name))}</b>
                  <div class="sub">${g.sites.length} bâtiments</div>` : ''}</td>
                <td class="mono sub">${F.esc(s.id)}</td>
                <td>${F.esc(F.titleCase(s.address || ''))}</td>
                <td style="width:120px"><button class="btn btn-ghost btn-sm"
                  data-rename="${F.esc(s.id)}">${Icons.svg('edit')} Renommer</button></td>
              </tr>`).join('')).join('')}
          </tbody>
        </table></div>
        <div class="audit-note">
          ${Icons.svg('info')}
          <div>Le nom saisi ne remplace pas celui de la facture : il s'affiche à sa
          place dans l'application, et le nom facturé reste visible en dessous pour
          retrouver le sous-compte sur le PDF. Un site renommé sort de cette liste.</div>
        </div>
      </div>` : ''}`;
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
            <div style="font-weight:650;font-size:14px;letter-spacing:-.01em">
              ${F.esc(prettifySite(s))}
              <button class="icon-btn site-rename" data-rename="${F.esc(s.id)}"
                title="Renommer ce site">${Icons.svg('edit')}</button>
            </div>
            ${F.siteRenamed(s) ? `<div class="sub text-muted" style="font-size:11px;margin-top:2px"
              title="Nom porté par la facture">sur facture : ${F.esc(F.siteBilled(s))}</div>` : ''}
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
