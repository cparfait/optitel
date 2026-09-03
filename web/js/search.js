/* Recherche globale — palette Ctrl+K sur lignes, sites, factures, offres, remises */
(function () {
  const F = window.fmt, S = window.Store;
  const MAX = 40;

  let el = {}, results = [], cursor = 0, open = false;

  function mount() {
    const box = document.createElement('div');
    box.className = 'palette-backdrop';
    box.id = 'palette';
    box.innerHTML = `
      <div class="palette" role="dialog" aria-modal="true" aria-label="Recherche globale">
        <div class="palette-head">
          <span class="palette-ico">${Icons.svg('search')}</span>
          <input id="palette-input" type="search" autocomplete="off" spellcheck="false"
                 placeholder="Rechercher un numéro, un site, une facture, une offre…"
                 aria-label="Rechercher">
          <kbd class="palette-esc">Échap</kbd>
        </div>
        <div class="palette-body" id="palette-body"></div>
        <div class="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span>
          <span><kbd>↵</kbd> ouvrir</span>
          <span id="palette-count"></span>
        </div>
      </div>`;
    document.body.appendChild(box);
    el.box = box;
    el.input = box.querySelector('#palette-input');
    el.body = box.querySelector('#palette-body');
    el.count = box.querySelector('#palette-count');

    box.addEventListener('mousedown', e => { if (e.target === box) close(); });
    el.input.addEventListener('input', () => run(el.input.value));
    el.input.addEventListener('keydown', onKey);
    el.body.addEventListener('mousemove', e => {
      const row = e.target.closest('.pal-item');
      if (row && +row.dataset.i !== cursor) { cursor = +row.dataset.i; paint(); }
    });
    el.body.addEventListener('click', e => {
      const row = e.target.closest('.pal-item');
      if (row) choose(+row.dataset.i);
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault(); cursor = Math.min(cursor + 1, results.length - 1); paint(true);
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault(); cursor = Math.max(cursor - 1, 0); paint(true);
    } else if (e.key === 'Enter') {
      e.preventDefault(); choose(cursor);
    }
  }

  function run(q) {
    // une seule passe sur l'index : on affiche les MAX premiers mais on annonce
    // le total, inutile de refaire la recherche entière à chaque frappe
    const all = S.search(q);
    results = all.slice(0, MAX);
    cursor = 0;
    paint();
    el.count.textContent = all.length ? `${all.length} résultat${all.length > 1 ? 's' : ''}` : '';
  }

  function highlight(text, q) {
    const t = String(text || '');
    const terms = String(q || '').trim().split(/\s+/).filter(x => x.length > 1);
    if (!terms.length) return F.esc(t);
    const re = new RegExp('(' + terms.map(x =>
      x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig');
    return F.esc(t).replace(re, '<mark>$1</mark>');
  }

  function paint(scroll) {
    const q = el.input.value;
    if (String(q).trim().length < 2) {
      el.body.innerHTML = `<div class="pal-hint">
        Tapez au moins 2 caractères — numéro de ligne, nom de site, sous-compte,
        n° de facture, nom d'offre ou de remise.</div>`;
      return;
    }
    if (!results.length) {
      el.body.innerHTML = `<div class="pal-hint">Aucun résultat pour « ${F.esc(q)} ».</div>`;
      return;
    }
    let html = '', lastKind = null;
    results.forEach((r, i) => {
      if (r.kind !== lastKind) {
        html += `<div class="pal-group">${S.KINDS[r.kind] || r.kind}</div>`;
        lastKind = r.kind;
      }
      html += `<div class="pal-item${i === cursor ? ' sel' : ''}" data-i="${i}">
        <span class="pal-item-ico k-${r.kind}">${Icons.svg(r.icon)}</span>
        <span class="pal-item-txt">
          <span class="pal-item-title">${highlight(r.title, q)}</span>
          <span class="pal-item-sub">${highlight(r.subtitle, q)}</span>
        </span>
        <span class="pal-item-go">↵</span>
      </div>`;
    });
    // regroupe visuellement mais garde l'ordre de pertinence à l'intérieur
    el.body.innerHTML = html;
    if (scroll) {
      const sel = el.body.querySelector('.pal-item.sel');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(i) {
    const r = results[i];
    if (!r) return;
    close();
    if (r.kind === 'line') {
      location.hash = '#/lines';
      // le drawer de détail donne directement le contexte complet de la ligne
      setTimeout(() => window.Views.lines.openLine && window.Views.lines.openLine(r.obj.key), 60);
    } else {
      location.hash = r.route;
    }
  }

  function show() {
    if (!el.box) mount();
    open = true;
    el.box.classList.add('open');
    el.input.value = '';
    run('');
    setTimeout(() => el.input.focus(), 10);
  }

  function close() {
    open = false;
    if (el.box) el.box.classList.remove('open');
  }

  document.addEventListener('keydown', e => {
    const k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); open ? close() : show(); return; }
    if (k === '/' && !open && !/^(input|textarea|select)$/i.test(document.activeElement.tagName)) {
      e.preventDefault(); show();
    }
  });

  window.Search = { show, close, run };
})();
