/* Vue — Factures & Import : historique complet + ajout de PDF */
(function () {
  const F = window.fmt, S = window.Store;

  // Le compte rendu d'import doit survivre au re-render déclenché par le
  // rechargement du dataset, sinon il disparaît avant d'avoir été lu.
  const state = { report: '' };

  /* Les PDF source restent la pièce justificative : le détail affiché ici est
     une lecture, elle doit pouvoir être confrontée à l'original en un clic. */
  function pdfLink(name, label) {
    if (!name) return '';
    return `<a class="btn btn-ghost btn-sm" style="margin-right:6px"
       href="/factures/${encodeURIComponent(name)}" target="_blank" rel="noopener"
       title="${F.esc(name)}">${Icons.svg('file')} ${label}</a>`;
  }

  function render(view) {
    const invs = (S.data.invoices || []).slice().sort((a, b) => (b.month + b.compte).localeCompare(a.month + a.compte));
    const months = new Set(S.visibleMonths());
    const rows = invs.filter(i =>
      (S.account === 'all' || i.compte === S.account) && months.has(i.month));

    view.innerHTML = `
      <div class="wrap">
        <div class="grid cols-5-7 mb-3">
          <div class="card">
            <div class="card-title">Ajouter des factures</div>
            <div class="dropzone" id="dz">
              <div class="dz-ico">${Icons.svg('upload')}</div>
              <h4>Déposez vos PDF ici</h4>
              <p>ou cliquez pour parcourir — paires <b>.A.</b> (annexe) + <b>.F.</b> (facture)<br>Orange Business, tout compte confondu</p>
              <input type="file" id="dz-input" multiple accept=".pdf" class="hidden">
            </div>
            <div class="upload-list" id="ul"></div>
            <div class="flex mt-2" style="gap:8px">
              <button class="btn btn-ghost" id="btn-rescan">${Icons.svg('refresh')} Relancer l'analyse</button>
              <button class="btn btn-ghost" id="btn-export">${Icons.svg('download')} Exports CSV</button>
            </div>
            <div id="op-status" class="mt-2">${state.report}</div>
          </div>

          <div class="card">
            <div class="card-title">Couverture du dataset</div>
            <div id="cover-grid" class="grid" style="grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:8px"></div>
            <div class="tbl-foot" id="cover-foot"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>Historique des factures</span>
            <span class="hint">${rows.length} factures · la facture et son annexe s'ouvrent en PDF</span>
          </div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Mois</th><th>Compte</th><th>N° facture</th><th>Date</th><th>Marché</th>
              <th class="num">Abonnements</th><th class="num">Conso</th><th class="num">Remises</th>
              <th class="num">Total HT</th><th class="num">TTC</th><th>PDF</th>
            </tr></thead>
            <tbody id="inv-body">
              ${rows.map(i => {
                const t = i.totals;
                const rem = (t.remiseAbo || 0) + (t.remiseConso || 0);
                const f = i.files || {};
                return `<tr>
                  <td class="strong">${F.monthLabelShort(i.month)}</td>
                  <td><span class="mono sub">${i.compte}</span></td>
                  <td class="mono">${F.esc(i.numero)}</td>
                  <td class="sub">${F.dateFR(i.date)}</td>
                  <td>${i.marche ? `<span class="badge b-num">${F.esc(i.marche)}</span>` : '<span class="text-muted">—</span>'}</td>
                  <td class="num">${F.eur(t.abonnements)}</td>
                  <td class="num">${t.consommations ? F.eur(t.consommations) : '<span class="text-muted">—</span>'}</td>
                  <td class="num text-teal">${rem ? '−' + F.eur(rem) : '—'}</td>
                  <td class="num strong">${F.eur(t.ht)}</td>
                  <td class="num">${F.eur(t.ttc)}</td>
                  <td class="nowrap">${pdfLink(f.f, 'Facture')}${pdfLink(f.a, 'Annexe')}
                    ${!f.f && !f.a ? '<span class="text-muted">—</span>' : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
        </div>
      </div>`;

    renderCover();

    // ── interactions import
    const dz = document.getElementById('dz');
    const input = document.getElementById('dz-input');
    const ul = document.getElementById('ul');
    const status = document.getElementById('op-status');

    dz.addEventListener('click', () => input.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('drag');
      handleFiles(e.dataTransfer.files);
    });
    input.addEventListener('change', () => handleFiles(input.files));

    async function handleFiles(files) {
      if (!files || !files.length) return;
      const list = Array.from(files).filter(f => /\.pdf$/i.test(f.name));
      if (!list.length) { toast('Aucun PDF reçu', 'err'); return; }
      ul.innerHTML = list.map(f => `<div class="upload-item" data-n="${F.esc(f.name)}">
        ${Icons.svg('file')} <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${F.esc(f.name)}</span>
        <span class="u-status text-muted">envoi…</span></div>`).join('');
      const fd = new FormData();
      list.forEach(f => fd.append('files', f, f.name));
      status.innerHTML = `<div class="flex" style="gap:10px"><div class="spinner" style="width:18px;height:18px;border-width:2.5px"></div>
        Analyse en cours — extraction et rapprochement des paires A/F…</div>`;
      try {
        const r = await fetch('/api/import', { method: 'POST', body: fd });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'erreur');
        // un fichier reçu n'est pas un fichier exploité : on distingue les deux,
        // sinon un PDF en attente de son jumeau passe pour intégré
        const rejected = j.rejected || [];
        const badNames = new Set(rejected.map(x => x.file));
        ul.querySelectorAll('.upload-item').forEach(it => {
          const nm = it.dataset.n;
          it.querySelector('.u-status').innerHTML = badNames.has(nm)
            ? `<span style="color:var(--red)">nom non reconnu</span>`
            : `<span style="color:var(--green)">reçu ✓</span>`;
        });
        const added = j.added || 0;
        const errs = (j.errors || []).length;
        const ok = added > 0;
        state.report = `<div class="alert-item" style="border-color:var(--${ok ? 'green' : 'amber'}-soft);background:var(--${ok ? 'green' : 'amber'}-soft)">
          <div class="alert-ico" style="background:#fff;color:var(--${ok ? 'green' : 'amber'})">${Icons.svg(ok ? 'check-c' : 'alert')}</div>
          <div class="alert-body">
            <b>${j.saved.length} fichier(s) reçu(s) · ${added > 0 ? `${added} nouvelle(s) facture(s)` : 'aucune nouvelle facture'}</b>
            — dataset : ${j.meta.counts.invoices} factures, ${j.meta.counts.lines} lignes, ${j.meta.counts.sites} sites.
            ${rejected.length ? `<div style="margin-top:4px;color:var(--red)">${rejected.length} fichier(s) au nom non reconnu : attendu <code>compte.numero.A|F.date.id.pdf</code></div>` : ''}
            ${!added && !rejected.length ? `<div style="margin-top:4px">Déjà présentes, ou l'annexe (<code>.A.</code>) et la facture (<code>.F.</code>) doivent être déposées ensemble.</div>` : ''}
            ${errs ? `<div style="margin-top:4px;color:var(--amber)">${errs} avertissement(s) de lecture.</div>` : ''}
          </div>
        </div>`;
        status.innerHTML = state.report;
        toast(added > 0 ? `${added} facture(s) ajoutée(s)` : 'Aucune nouvelle facture', added > 0 ? 'ok' : 'err');
        await S.reload();
        window.App.refresh();   // re-render : state.report est ré-injecté
      } catch (e) {
        state.report = `<div class="alert-item" style="border-color:var(--red-soft);background:var(--red-soft)">
          <div class="alert-ico" style="background:#fff;color:var(--red)">${Icons.svg('alert')}</div>
          <div class="alert-body"><b>Échec de l'import</b> — ${F.esc(e.message)}</div></div>`;
        status.innerHTML = state.report;
        toast('Import en échec', 'err');
      }
    }

    document.getElementById('btn-rescan').addEventListener('click', async () => {
      status.innerHTML = `<div class="flex" style="gap:10px"><div class="spinner" style="width:18px;height:18px;border-width:2.5px"></div> Reconstruction du dataset…</div>`;
      try {
        const r = await fetch('/api/rescan', { method: 'POST' });
        const j = await r.json();
        await S.reload();
        window.App.refresh();
        state.report = '';
        status.innerHTML = '';
        toast(`Dataset reconstruit — ${j.meta.counts.invoices} factures`, 'ok');
      } catch (e) { toast('Rescan impossible', 'err'); state.report = ''; status.innerHTML = ''; }
    });

    document.getElementById('btn-export').addEventListener('click', () => {
      ['lines', 'sites', 'invoices', 'remises'].forEach((n, i) =>
        setTimeout(() => window.open(`/api/export/${n}`, '_blank'), i * 350));
    });

    function renderCover() {
      const grid = document.getElementById('cover-grid');
      const months = S.data.months;
      const foot = document.getElementById('cover-foot');
      grid.innerHTML = months.map(mk => {
        const accs = Object.keys(S.data.monthly[mk].accounts);
        const ok = accs.length;
        return `<div title="${F.monthLabel(mk)} — ${ok} compte(s)" style="
          border-radius:8px;padding:7px 6px;text-align:center;
          background:${ok >= 3 ? 'var(--green-soft)' : ok >= 2 ? 'var(--amber-soft)' : 'var(--red-soft)'};
          color:${ok >= 3 ? 'var(--green)' : ok >= 2 ? 'var(--amber)' : 'var(--red)'};
          font-size:11px;font-weight:650">
          ${F.monthLabelShort(mk)}<div style="font-size:9.5px;opacity:.75">${ok}/3 comptes</div>
        </div>`;
      }).join('');
      foot.innerHTML = `Vert = 3 comptes facturés · orange = 2 · rouge = 1 — <b>${S.data.meta.counts.invoices} factures</b> au total.`;
    }
  }

  window.Views = window.Views || {};
  window.Views.invoices = { render, title: 'Factures & import' };
})();
