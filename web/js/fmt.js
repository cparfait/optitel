/* Formatage FR — montants, durées, mois */
(function () {
  const eur0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const eur2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const num1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const num2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  window.fmt = {
    eur(v, dec) { return (dec === 0 ? eur0 : eur2).format(v || 0); },
    eurShort(v) {
      v = v || 0;
      if (Math.abs(v) >= 10000) return num1.format(v / 1000) + ' k€';
      return num0.format(v) + ' €';
    },
    num(v) { return num0.format(v || 0); },
    num1(v) { return num1.format(v || 0); },
    num2(v) { return num2.format(v || 0); },
    pct(v, dec) { return (dec === 1 ? num1 : num0).format(v || 0) + ' %'; },
    dur(sec) {
      sec = Math.round(sec || 0);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`;
      if (m > 0) return `${m} min ${String(s).padStart(2, '0')}`;
      return `${s} s`;
    },
    durHM(sec) {
      sec = Math.round(sec || 0);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
      if (m > 0) return `${m}min`;
      return `${sec}s`;
    },
    durH(sec) {
      const h = (sec || 0) / 3600;
      return num1.format(h) + ' h';
    },
    monthLabel(mk) { // '2025-08' -> 'août 2025'
      const [y, m] = mk.split('-');
      const d = new Date(+y, +m - 1, 1);
      return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    },
    monthLabelShort(mk) { // 'août 25'
      const [y, m] = mk.split('-');
      const d = new Date(+y, +m - 1, 1);
      let s = d.toLocaleDateString('fr-FR', { month: 'short' });
      return s.replace('.', '') + ' ' + y.slice(2);
    },
    dateFR(d) {
      if (!d) return '—';
      const [dd, mm, yy] = d.split('/');
      return `${dd}/${mm}/${yy}`;
    },
    lineNo(n) { return (n || '').trim(); },
    dateISO(d) {                       // '2026-08-31' -> '31/08/2026'
      if (!d) return '';
      const [y, m, dd] = String(d).split('-');
      return dd ? `${dd}/${m}/${y}` : d;
    },
    // Les factures sont tout en capitales : on rend ça lisible sans perdre les sigles.
    titleCase(s) {
      const small = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'au', 'aux', 'sur', 'a']);
      const keep = /^(EM|EP|GS|CDL|CDLM|CTM|CMS|RPA|DGS|ADSL|SDA|T0|BCD|RDC|ASS|CS|PC)$/;
      return String(s || '').toLowerCase().split(/(\s+|[-/'])/).map((w, i) => {
        if (!/\w/.test(w)) return w;
        const up = w.toUpperCase();
        if (keep.test(up)) return up;
        if (i > 0 && small.has(w)) return w;
        return w.charAt(0).toUpperCase() + w.slice(1);
      }).join('');
    },
    // Nom d'un sous-compte : nom du local, préfixé de sa direction si présente.
    site(s) {
      if (!s) return '—';
      const name = this.titleCase(s.name || s.siteName || '');
      const dept = this.titleCase(s.dept || s.siteDept || '');
      if (!name) return '—';
      return dept && !name.toLowerCase().includes(dept.toLowerCase())
        ? `${dept} · ${name}` : name;
    },
    el(html) {
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      return t.content.firstElementChild;
    },
    esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
  };
})();
