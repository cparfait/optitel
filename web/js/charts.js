/* ═══════════════════════════════════════════════════════════
   Charts SVG maison — aires empilées, lignes, donut,
   barres horizontales, sparklines, barres groupées.
   Interactifs : tooltip suiveur, crosshair.
   ═══════════════════════════════════════════════════════════ */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const uid = (() => { let i = 0; return p => `${p}${++i}`; })();

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // Helpers mesure texte approximative
  /* Borne haute de l'axe. On arrondit le *pas* de graduation, pas le maximum :
     un maximum « rond » divisé en 4 donne des graduations qui ne le sont pas
     (5 000 / 4 = 1 250), et l'axe finit par afficher deux fois la même étiquette.
     En partant du pas, chaque graduation tombe juste et l'échelle colle aux
     données au lieu de laisser la moitié du graphique vide. */
  const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  function niceMax(v, ticks) {
    ticks = ticks || 4;
    if (v <= 0) return ticks;
    const raw = v / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = STEPS.find(s => n <= s + 1e-9) || 10;
    return step * mag * ticks;
  }

  /* Une étiquette de mois (« sept 25 ») occupe ~44 px : on n'en affiche qu'une
     sur `step` pour qu'elles ne se chevauchent jamais. */
  const LABEL_W = 44;
  function labelStep(n, innerWidth) {
    const room = Math.max(1, Math.floor(innerWidth / LABEL_W));
    return Math.max(1, Math.ceil(n / room));
  }

  function ensureSize(host, ratio) {
    const w = Math.max(host.clientWidth || 600, 260);
    const h = Math.round(w * (ratio || 0.42));
    return { w, h };
  }

  function tooltipDiv(host) {
    let t = host.querySelector('.chart-tooltip');
    if (!t) {
      t = document.createElement('div');
      t.className = 'chart-tooltip';
      host.appendChild(t);
    }
    return t;
  }

  function showTip(host, tt, x, y, html) {
    tt.innerHTML = html;
    tt.style.opacity = '1';
    const r = host.getBoundingClientRect();
    const tw = tt.offsetWidth, th = tt.offsetHeight;
    let tx = x + 16, ty = y - th - 10;
    if (tx + tw > r.width) tx = x - tw - 14;
    if (ty < 0) ty = y + 14;
    tt.style.transform = `translate(${tx}px, ${ty}px)`;
  }
  function hideTip(tt) { tt.style.opacity = '0'; }

  /* ── Aire empilée + lignes optionnelles
     cfg: { labels:[], series:[{name, values:[], color, type:'area'|'line', dash}], h, fmtV, fmtCat } */
  function stackedArea(host, cfg) {
    host.innerHTML = '';
    host.classList.add('chart');
    const { w, h } = ensureSize(host, cfg.ratio || 0.44);
    const padL = 52, padR = 14, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h }, host);
    const defs = el('defs', {}, svg);
    const labels = cfg.labels;
    const n = labels.length;
    const areas = cfg.series.filter(s => (s.type || 'area') === 'area');
    const lines = cfg.series.filter(s => s.type === 'line');
    // bornes
    let max = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      areas.forEach(a => s += (a.values[i] || 0));
      lines.forEach(l => max = Math.max(max, l.values[i] || 0));
      max = Math.max(max, s);
    }
    const ticks = 4;
    max = niceMax(max * 1.05, ticks);
    const X = i => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = v => padT + ih - (v / max) * ih;

    // grille + axe Y
    for (let t = 0; t <= ticks; t++) {
      const v = (max / ticks) * t;
      const y = Y(v);
      el('line', { x1: padL, x2: w - padR, y1: y, y2: y, class: 'grid-line' }, svg);
      const lab = el('text', { x: padL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'axis-label' }, svg);
      lab.textContent = cfg.fmtAxis ? cfg.fmtAxis(v) : fmtShortNum(v);
    }
    // axe X — l'espacement dépend de la place réelle, pas du nombre de points :
    // 13 mois tiennent sur un large écran, pas dans une colonne étroite
    const step = labelStep(n, iw);
    labels.forEach((lb, i) => {
      if (i % step === 0 || i === n - 1) {
        const t = el('text', { x: X(i), y: h - 8, 'text-anchor': 'middle', class: 'axis-label' }, svg);
        t.textContent = lb;
      }
    });

    // aires empilées (bas -> haut)
    const stack = new Array(n).fill(0);
    areas.forEach((s, si) => {
      const pts = s.values.map((v, i) => [X(i), Y(stack[i] + (v || 0))]);
      const base = s.values.map((v, i) => [X(i), Y(stack[i])]);
      let d = `M ${pts[0][0]} ${pts[0][1]}`;
      for (let i = 1; i < n; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`;
      for (let i = n - 1; i >= 0; i--) d += ` L ${base[i][0]} ${base[i][1]}`;
      d += ' Z';
      const gid = uid('g');
      const gr = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': .32 }, gr);
      el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': .04 }, gr);
      el('path', { d, fill: `url(#${gid})` }, svg);
      let dl = `M ${pts[0][0]} ${pts[0][1]}`;
      for (let i = 1; i < n; i++) dl += ` L ${pts[i][0]} ${pts[i][1]}`;
      el('path', { d: dl, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
      s.values.forEach((v, i) => stack[i] += v || 0);
    });

    // lignes simples par-dessus
    lines.forEach(s => {
      const pts = s.values.map((v, i) => [X(i), Y(v || 0)]);
      let d = `M ${pts[0][0]} ${pts[0][1]}`;
      for (let i = 1; i < n; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`;
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.2, 'stroke-linejoin': 'round',
        'stroke-dasharray': s.dash ? '5 4' : 'none', 'stroke-linecap': 'round' }, svg);
      pts.forEach(p => el('circle', { cx: p[0], cy: p[1], r: 2.6, fill: '#fff', stroke: s.color, 'stroke-width': 2 }, svg));
    });

    // points aires (top série seulement)
    if (areas.length) {
      areas[areas.length - 1].values.forEach((v, i) => {
        el('circle', { cx: X(i), cy: Y(stack[i]), r: 2.4, fill: '#fff', stroke: areas[areas.length - 1].color, 'stroke-width': 1.8 }, svg);
      });
    }

    // interactions
    const cross = el('line', { y1: padT, y2: padT + ih, stroke: '#c3c8d4', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0 }, svg);
    const dotHl = el('circle', { r: 4.5, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2, opacity: 0 }, svg);
    const tt = tooltipDiv(host);
    svg.addEventListener('mousemove', ev => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * w;
      let idx = Math.round(((px - padL) / iw) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      cross.setAttribute('x1', X(idx)); cross.setAttribute('x2', X(idx));
      cross.setAttribute('opacity', .8);
      let acc = 0;
      areas.forEach(a => acc += a.values[idx] || 0);
      const topY = areas.length ? Y(acc) : Y(lines[0] ? lines[0].values[idx] : 0);
      dotHl.setAttribute('cx', X(idx)); dotHl.setAttribute('cy', topY);
      dotHl.setAttribute('opacity', 1);
      let rows = '';
      areas.concat(lines).reverse().forEach(s => {
        const v = s.values[idx] || 0;
        if (!s.hideTip) rows += `<div class="tt-row"><span class="sw"><i style="background:${s.color}"></i>${s.name}</span><b>${cfg.fmtV ? cfg.fmtV(v) : fmtShortNum(v)}</b></div>`;
      });
      const total = areas.reduce((a, s) => a + (s.values[idx] || 0), 0);
      if (areas.length > 1) rows = `<div class="tt-row" style="border-top:1px solid #3c4250;margin-top:4px;padding-top:4px"><span class="sw">Total</span><b>${cfg.fmtV ? cfg.fmtV(total) : fmtShortNum(total)}</b></div>` + rows;
      const html = `<div class="tt-title">${cfg.fmtCat ? cfg.fmtCat(labels[idx]) : labels[idx]}</div>${rows}`;
      showTip(host, tt, (X(idx) / w) * r.width, (topY / h) * r.height, html);
    });
    svg.addEventListener('mouseleave', () => { hideTip(tt); cross.setAttribute('opacity', 0); dotHl.setAttribute('opacity', 0); });
    return svg;
  }

  /* ── Donut : cfg { items:[{name, value, color}], center:{label, sub}, fmt } */
  function donut(host, cfg) {
    host.innerHTML = '';
    host.classList.add('chart');
    const size = cfg.size || 210;
    const w = size, h = size;
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', style: `max-width:${w}px;margin:0 auto;display:block` }, host);
    const cx = w / 2, cy = h / 2, R = w / 2 - 8, r = R * 0.64;
    const total = cfg.items.reduce((a, i) => a + i.value, 0) || 1;
    let a0 = -Math.PI / 2;
    const tt = tooltipDiv(host);
    const segs = [];
    cfg.items.forEach(it => {
      if (it.value <= 0) return;
      const frac = it.value / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const p0 = [cx + R * Math.cos(a0), cy + R * Math.sin(a0)];
      const p1 = [cx + R * Math.cos(a1), cy + R * Math.sin(a1)];
      const p2 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
      const p3 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
      const d = `M ${p0} A ${R} ${R} 0 ${large} 1 ${p1} L ${p2} A ${r} ${r} 0 ${large} 0 ${p3} Z`;
      const seg = el('path', { d, fill: it.color, opacity: .92, stroke: '#fff', 'stroke-width': 2 }, svg);
      segs.push({ seg, it, frac });
      seg.addEventListener('mousemove', ev => {
        seg.setAttribute('opacity', 1);
        const rr = host.getBoundingClientRect();
        showTip(host, tt, ev.clientX - rr.left, ev.clientY - rr.top,
          `<div class="tt-title">${it.name}</div>
           <div class="tt-row"><span class="sw"><i style="background:${it.color}"></i>Coût</span><b>${cfg.fmt ? cfg.fmt(it.value) : fmtShortNum(it.value)}</b></div>
           <div class="tt-row"><span class="sw">Part</span><b>${(frac * 100).toFixed(1)} %</b></div>`);
      });
      seg.addEventListener('mouseleave', () => { seg.setAttribute('opacity', .92); hideTip(tt); });
      a0 = a1;
    });
    if (cfg.center) {
      const t1 = el('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', style: 'font-size:19px;font-weight:700;fill:var(--ink)' }, svg);
      t1.textContent = cfg.center.label;
      const t2 = el('text', { x: cx, y: cy + 15, 'text-anchor': 'middle', style: 'font-size:10.5px;fill:var(--muted)' }, svg);
      t2.textContent = cfg.center.sub;
    }
    return svg;
  }

  /* ── Sparkline (dans cellules de tableaux) : values, color, w, h */
  function sparkline(values, color, w, h) {
    w = w || 90; h = h || 26;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const n = values.length;
    const X = i => 2 + (i / Math.max(n - 1, 1)) * (w - 4);
    const Y = v => h - 3 - ((v - min) / span) * (h - 6);
    let d = `M ${X(0)} ${Y(values[0])}`;
    for (let i = 1; i < n; i++) d += ` L ${X(i)} ${Y(values[i])}`;
    const last = values[n - 1];
    const col = color || 'var(--accent)';
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block">
      <path d="${d} L ${X(n - 1)} ${h - 1} L ${X(0)} ${h - 1} Z" fill="${col}" opacity=".09"/>
      <path d="${d}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(n - 1)}" cy="${Y(last)}" r="2.3" fill="${col}"/>
    </svg>`;
  }

  /* ── Barres verticales groupées/empilées : cfg { labels, series:[{name, values, color}], stacked, fmtV, fmtCat } */
  function bars(host, cfg) {
    host.innerHTML = '';
    host.classList.add('chart');
    const { w, h } = ensureSize(host, cfg.ratio || 0.42);
    const padL = 52, padR = 14, padT = 14, padB = 26;
    const iw = w - padL - padR, ih = h - padT - padB;
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h }, host);
    const labels = cfg.labels, n = labels.length, m = cfg.series.length;
    let max = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      cfg.series.forEach(se => { s += se.values[i] || 0; if (!cfg.stacked) max = Math.max(max, se.values[i] || 0); });
      if (cfg.stacked) max = Math.max(max, s);
    }
    const ticks = 4;
    max = niceMax(max * 1.05, ticks);
    const Y = v => padT + ih - (v / max) * ih;
    for (let t = 0; t <= ticks; t++) {
      const v = (max / ticks) * t;
      el('line', { x1: padL, x2: w - padR, y1: Y(v), y2: Y(v), class: 'grid-line' }, svg);
      const lab = el('text', { x: padL - 8, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'axis-label' }, svg);
      lab.textContent = cfg.fmtAxis ? cfg.fmtAxis(v) : fmtShortNum(v);
    }
    const slot = iw / n;
    const barW = cfg.stacked ? Math.min(slot * .5, 26) : Math.min((slot * .7) / m, 14);
    const tt = tooltipDiv(host);
    labels.forEach((lb, i) => {
      const cx = padL + slot * (i + .5);
      let acc = 0;
      cfg.series.forEach((se, si) => {
        const v = se.values[i] || 0;
        const y0 = cfg.stacked ? Y(acc) : Y(0);
        acc += v;
        const y1 = cfg.stacked ? Y(acc) : Y(v);
        const x = cfg.stacked ? cx - barW / 2 : cx - (barW * m) / 2 + si * barW;
        const r = el('rect', { x, y: Math.min(y0, y1), width: barW - 1, height: Math.max(Math.abs(y1 - y0), 1), rx: 2.5, fill: se.color }, svg);
        r.addEventListener('mousemove', ev => {
          const rr = host.getBoundingClientRect();
          showTip(host, tt, ev.clientX - rr.left, ev.clientY - rr.top,
            `<div class="tt-title">${cfg.fmtCat ? cfg.fmtCat(lb) : lb}</div>
             ${cfg.series.map(s2 => `<div class="tt-row"><span class="sw"><i style="background:${s2.color}"></i>${s2.name}</span><b>${cfg.fmtV ? cfg.fmtV(s2.values[i] || 0) : fmtShortNum(s2.values[i] || 0)}</b></div>`).join('')}`);
        });
        r.addEventListener('mouseleave', () => hideTip(tt));
      });
      if (i % labelStep(n, iw) === 0 || i === n - 1) {
        const t = el('text', { x: cx, y: h - 8, 'text-anchor': 'middle', class: 'axis-label' }, svg);
        t.textContent = lb;
      }
    });
    return svg;
  }

  /* Une décimale seulement quand elle change quelque chose : arrondir au millier
     ferait afficher « 3k » pour 2 500 et « 4k » pour 3 750 — deux graduations
     voisines devenues fausses et non contiguës. */
  function short1(x) {
    const r = Math.round(x * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace('.', ',');
  }

  function fmtShortNum(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return short1(v / 1e6) + 'M';
    if (a >= 1000) return short1(v / 1000) + 'k';
    if (a >= 10) return String(Math.round(v));
    if (v === 0) return '0';
    return short1(v);
  }

  window.Charts = { stackedArea, donut, sparkline, bars, fmtShortNum };
})();
