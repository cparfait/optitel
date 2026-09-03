/* Store — chargement du dataset + agrégations dérivées + filtres globaux */
(function () {
  const S = {
    data: null,
    loading: true,
    err: null,
    // filtres globaux
    account: 'all',     // 'all' | '803632496'…
    rangeFrom: null,    // '2025-08' | null = début
    rangeTo: null,      // '2026-08' | null = fin
    // Par défaut on regarde le parc en service : c'est ce qu'on arbitre. Les
    // lignes résiliées restent accessibles en désactivant le switch « Parc ».
    activeOnly: true,
    month: null,        // mois affiché (par défaut dernier)
    // dérivés
    months: [],
    view: null,
    listeners: [],
  };

  S.load = async function () {
    try {
      const r = await fetch('/api/data');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      S.data = await r.json();
    } catch (e) {
      S.err = 'Impossible de charger les données. Le serveur est-il lancé ?';
      throw e;
    } finally {
      S.loading = false;
    }
    S.computeDerived();
    S.month = S.data.lastMonth || S.data.months[S.data.months.length - 1] || null;
    return S.data;
  };

  S.reload = async function () {
    S.loading = true; S.err = null;
    try {
      const r = await fetch('/api/data', { cache: 'no-store' });
      S.data = await r.json();
      S.computeDerived();
      if (!S.data.months.includes(S.month)) {
        S.month = S.data.lastMonth || S.data.months[S.data.months.length - 1] || null;
      }
    } finally {
      S.loading = false;
    }
    return S.data;
  };

  /* Familles voix portées par le RTC. Les accès internet sont traités à part :
     un ADSL/SDSL passe aussi sur la paire de cuivre, une fibre non — c'est le
     champ `onCopper` calculé par le parseur qui tranche. */
  S.COPPER_FAMILIES = new Set(['t0', 't0_ascenseur', 'numeris', 'canal_sda', 'residentiel']);

  S.TECH_LABELS = {
    fibre: 'Fibre', adsl: 'ADSL', sdsl: 'SDSL',
    xdsl_presume: 'xDSL présumé',
  };

  S.computeDerived = function () {
    const d = S.data;
    if (!d) return;
    _index = null;   // le dataset a changé : l'index de recherche est périmé

    // Tous les comptes ne sont pas facturés jusqu'au même mois : le statut d'une
    // ligne se juge sur la dernière facture de SON compte, pas sur le dataset.
    const lastByAccount = {};
    d.invoices.forEach(i => {
      if (!lastByAccount[i.compte] || i.month > lastByAccount[i.compte]) {
        lastByAccount[i.compte] = i.month;
      }
    });
    d.lastInvoiceByAccount = lastByAccount;
    const firstMonth = d.months[0];

    d.lines.forEach(l => {
      const ref = lastByAccount[l.account] || d.lastMonth;
      l.accountLastMonth = ref;
      const at = l.months[ref];
      /* Dernière facture négative : la ligne n'y figure plus que par l'avoir de
         prorata de sa résiliation. Le 01 47 35 77 99 est facturé 29,08 € jusqu'en
         juillet puis −2,82 € en août : la ligne est partie en cours de mois, elle
         n'est pas en service. La compter dans le parc gonflait l'effectif et
         laissait ces résiliations hors de la liste des lignes résiliées.
         Aucun autre mois du dataset n'est négatif : le signe ne marque que la
         clôture, jamais une régularisation en cours de vie. */
      l.closingCredit = !!at && (at.net || 0) < 0;
      l.isActive = !!at && !l.closingCredit;
      l.isTerminated = !l.isActive;
      l.endedAt = l.isTerminated ? l.last : null;
      // nombre de mois facturés depuis sa disparition
      l.monthsSinceEnd = l.isTerminated
        ? d.months.filter(m => m > l.last && m <= ref).length : 0;
      l.isNew = l.first > firstMonth;
      // le parseur sait si l'accès est sur cuivre ; on retombe sur la famille
      // pour les datasets construits avant l'ajout de cette détection
      l.isCopper = l.onCopper !== undefined
        ? !!l.onCopper : S.COPPER_FAMILIES.has(l.family);
      l.isCopperVoice = l.isCopper && l.family !== 'internet';
      l.isCopperData = l.isCopper && l.family === 'internet';
      // Dernier montant connu : ce que coûte encore la ligne, ou ce qu'elle
      // coûtait. Pour une résiliation, le dernier mois facturé peut n'être qu'un
      // avoir — on prend le dernier mois réellement payé, sinon la ligne
      // apparaîtrait à −2,82 € et l'économie de sa résiliation serait négative.
      const paid = Object.keys(l.months).filter(m => (l.months[m].net || 0) > 0).sort();
      // dernier mois réellement payé — pour une résiliation, ce n'est pas
      // toujours la dernière facture où la ligne apparaît
      l.lastPaid = paid[paid.length - 1] || l.last;
      const ref2 = l.isActive ? ref : l.lastPaid;
      l.lastNet = l.months[ref2] ? l.months[ref2].net : 0;
    });
  };

  /* Ces sélecteurs portent déjà sur un état de cycle de vie précis : ils partent
     du parc complet, sinon le switch « Parc » les viderait par construction
     (chercher les résiliées parmi les seules actives ne rend jamais rien). */

  /* Lignes présentes sur la dernière facture de leur compte. */
  S.activeLines = function () {
    return S.allLines().filter(l => l.isActive);
  };

  /* Lignes disparues des factures — résiliations ou transferts. */
  S.terminatedLines = function () {
    return S.allLines().filter(l => l.isTerminated)
      .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
  };

  /* Parc cuivre encore actif, à migrer avant la fermeture du RTC. */
  S.copperLines = function () {
    return S.allLines().filter(l => l.isActive && l.isCopper);
  };

  /* Parc cuivre retenu à l'écran. Le switch « Parc » vaut ici comme partout :
     « Actifs » montre ce qui reste à migrer, désactivé montre aussi le cuivre
     déjà retiré sur la période — l'histoire du chantier. La pastille du menu et
     l'écran passent par la même fonction, sinon l'un annonçait 66 et l'autre
     137. */
  S.copperScope = function () {
    if (S.activeOnly) return S.copperLines();
    const ms = S.visibleMonths();
    return S.allLines().filter(l => l.isCopper && ms.some(m => l.months[m]));
  };

  /* ---------------------------------------------- suivi de migration (saisie)
     Stocké côté serveur, hors dataset : un ré-import de factures reconstruit le
     dataset mais ne doit pas effacer l'avancement saisi. */
  S.migration = {};
  S.MIGRATION_STATES = [
    { id: 'todo', label: 'À traiter', cls: 'b-mut' },
    { id: 'study', label: 'Étude', cls: 'b-num' },
    { id: 'ordered', label: 'Commandé', cls: 'b-asc' },
    { id: 'migrated', label: 'Migré', cls: 'b-ok' },
    { id: 'kept', label: 'Conservé', cls: 'b-res' },
  ];

  S.migrationLines = {};    // suivi porté par une ligne
  S.siteNames = {};         // noms d'usage, quand la facture nomme mal un site

  function absorb(j) {
    S.migration = j.sites || {};
    S.migrationLines = j.lines || {};
    S.siteNames = j.siteNames || {};
    // Les noms d'usage entrent dans l'index de recherche : renommer un site
    // doit le rendre trouvable sous son nouveau nom sans recharger la page.
    S.invalidateIndex();
  }

  S.loadMigration = async function () {
    try {
      const r = await fetch('/api/migration', { cache: 'no-store' });
      absorb(await r.json());
    } catch (e) {
      absorb({});
    }
    return S.migration;
  };

  const BLANK = { state: 'todo', ref: '', note: '', date: '' };

  S.migrationOf = function (siteId) {
    return S.migration[siteId] || BLANK;
  };

  /* Suivi effectif d'une ligne : sa propre saisie si elle existe, sinon celle
     de son site. Une commande se passe ligne par ligne — sur un site mixte, le
     T0 bascule en VoIP quand l'ascenseur attend encore son ascensoriste — mais
     déclarer le site entier reste possible et vaut pour toutes ses lignes. */
  S.migrationOfLine = function (line) {
    const own = S.migrationLines[line.key];
    if (own) return { ...own, level: 'line' };
    const site = S.migration[line.siteId];
    if (site) return { ...site, level: 'site' };
    return { ...BLANK, level: 'none' };
  };

  S.setMigration = async function (siteId, payload) {
    return post(`/api/migration/${encodeURIComponent(siteId)}`, payload);
  };

  S.setMigrationLine = async function (lineKey, payload) {
    return post(`/api/migration/line/${encodeURIComponent(lineKey)}`, payload);
  };

  /* Nom d'usage d'un site. Vider le champ revient au nom porté par la facture,
     qui n'est jamais écrasé. */
  S.setSiteName = async function (siteId, name) {
    return post(`/api/site-name/${encodeURIComponent(siteId)}`, { name });
  };

  async function post(url, payload) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Enregistrement refusé');
    absorb(j);
    return j;
  }

  /* Mois facturés pour un compte (ou tous) — sert aux sélecteurs de période,
     qui doivent pouvoir proposer plus large que la plage actuellement filtrée. */
  S.accountMonths = function () {
    if (!S.data) return [];
    let ms = S.data.months.slice();
    if (S.account !== 'all') {
      ms = ms.filter(m => S.data.monthly[m] && S.data.monthly[m].accounts[S.account]);
    }
    return ms;
  };

  /* Mois visibles = filtre compte + plage de dates [rangeFrom, rangeTo].
     Toutes les vues passent par ici : le filtre de dates s'applique partout. */
  S.visibleMonths = function () {
    return S.accountMonths().filter(m =>
      (!S.rangeFrom || m >= S.rangeFrom) && (!S.rangeTo || m <= S.rangeTo));
  };

  /* Lignes filtrées par compte + éventuellement par parc en service */
  S.lines = function () {
    if (!S.data) return [];
    return S.data.lines.filter(l =>
      (S.account === 'all' || l.account === S.account) &&
      (!S.activeOnly || l.isActive));
  };

  /* Lignes du compte courant, sans le filtre de parc global. Les vues qui
     proposent leur propre sélecteur de cycle de vie partent de là, sinon le
     switch « Actifs » rendrait les lignes résiliées impossibles à afficher. */
  S.allLines = function () {
    if (!S.data) return [];
    return S.data.lines.filter(l => S.account === 'all' || l.account === S.account);
  };

  /* Sites que la facture nomme de façon ambiguë : même libellé porté par
     plusieurs bâtiments distincts. Dix sous-comptes s'appellent « MAIRIE DE
     CHATILLON » à neuf adresses différentes — sur cette liste on ne sait pas de
     quel local on parle, et une commande de migration part au mauvais endroit.

     Les sous-comptes multiples d'un même bâtiment ne sont pas concernés : là,
     le nom identique est juste. On compare donc sur `placeKey`, qui normalise
     l'adresse, et non sur la chaîne brute. */
  S.ambiguousSiteGroups = function () {
    const byName = {};
    (S.data.sites || []).forEach(s => {
      const n = (s.name || '').trim().toUpperCase();
      if (!n) return;
      (byName[n] = byName[n] || []).push(s);
    });
    const out = [];
    Object.entries(byName).forEach(([name, group]) => {
      const places = new Set(group.map(s => s.placeKey || s.address || s.id));
      if (group.length < 2 || places.size < 2) return;
      // Un site renommé n'est plus ambigu : c'est le nom d'usage qui lève la
      // confusion. On l'écarte APRÈS le regroupement — filtrer avant laissait
      // des groupes réduits à un seul membre, affichés « 1 bâtiment » alors
      // qu'un site seul ne se confond avec rien.
      const reste = group.filter(s => !window.fmt.siteRenamed(s));
      if (reste.length < 2) return;
      out.push({ name, sites: reste.sort((a, b) => (a.address || '').localeCompare(b.address || '')) });
    });
    return out.sort((a, b) => b.sites.length - a.sites.length || a.name.localeCompare(b.name));
  };

  /* Liste à plat, pour compter. */
  S.ambiguousSites = function () {
    return S.ambiguousSiteGroups().reduce((a, g) => a.concat(g.sites), []);
  };

  /* Sites du compte courant, sans le filtre de parc global. */
  S.allSites = function () {
    if (!S.data) return [];
    return S.data.sites.filter(s => S.account === 'all' || s.account === S.account);
  };

  S.sites = function () {
    if (!S.data) return [];
    let out = S.data.sites.filter(s => S.account === 'all' || s.account === S.account);
    if (S.activeOnly) {
      // un site n'est « actif » que s'il porte encore au moins une ligne en service
      const live = new Set(
        S.data.lines.filter(l => l.isActive &&
          (S.account === 'all' || l.account === S.account)).map(l => l.siteId));
      out = out.filter(s => live.has(s.id));
    }
    return out;
  };

  /* Agrégat mensuel pour un compte (ou tous) : {abo, conso, ht, ttc, remiseAbo, remiseConso} */
  S.monthTotals = function (mk, account) {
    const d = S.data;
    const m = d.monthly[mk];
    if (!m) return { abo: 0, conso: 0, ht: 0, ttc: 0, remiseAbo: 0, remiseConso: 0, ponctuels: 0 };
    const accs = account && account !== 'all' ? { [account]: m.accounts[account] } : m.accounts;
    const t = { abo: 0, conso: 0, ht: 0, ttc: 0, remiseAbo: 0, remiseConso: 0, ponctuels: 0 };
    for (const k in accs) {
      const a = accs[k];
      if (!a) continue;
      t.abo += a.abo || 0; t.conso += a.conso || 0; t.ht += a.ht || 0; t.ttc += a.ttc || 0;
      t.remiseAbo += a.remiseAbo || 0; t.remiseConso += a.remiseConso || 0;
      // frais ponctuels : ce que la facture porte au-delà des abonnements et des
      // consommations. Le champ existait sans jamais être calculé, si bien que
      // `abo + conso` ne retombait pas sur le total HT affiché en en-tête.
      t.ponctuels += (a.ht || 0) - (a.abo || 0) - (a.conso || 0);
    }
    return t;
  };

  /* Produits du mois, restreints au compte sélectionné.
     Le filtre était annoncé mais pas appliqué : sous « compte 804056063 » les
     KPI portaient sur ce compte et le détail des remises sur les trois, si bien
     que le total des remises ne retombait pas sur la ligne de la facture.
     Une entrée sans compte (dataset construit avant l'ajout du champ) est
     conservée plutôt que silencieusement écartée. */
  S.monthProducts = function (mk) {
    const m = S.data.monthly[mk];
    if (!m) return [];
    if (S.account === 'all') return m.products;
    return m.products.filter(p => !p.compte || p.compte === S.account);
  };

  S.monthConsoCats = function (mk) {
    const m = S.data.monthly[mk];
    if (!m) return [];
    if (S.account === 'all') return m.consoCats;
    return m.consoCats.filter(c => !c.compte || c.compte === S.account);
  };

  /* Agrégats période (tous les mois visibles) */
  S.periodTotals = function () {
    const t = { abo: 0, conso: 0, ht: 0, ttc: 0, remiseAbo: 0, remiseConso: 0, ponctuels: 0 };
    S.visibleMonths().forEach(mk => {
      const mt = S.monthTotals(mk, S.account);
      t.abo += mt.abo; t.conso += mt.conso; t.ht += mt.ht; t.ttc += mt.ttc;
      t.remiseAbo += mt.remiseAbo; t.remiseConso += mt.remiseConso;
      t.ponctuels += mt.ponctuels;
    });
    return t;
  };

  /* Remises agrégées sur période, par nature (marche | compensation | autre).
     Hors avoirs : une régularisation n'est pas une remise négociée, et l'y
     inclure faisait diverger cet écran du total de remises du tableau de bord. */
  S.remisesByKind = function () {
    const out = { marche: 0, compensation: 0, autre: 0, total: 0 };
    S.visibleMonths().forEach(mk => {
      S.monthProducts(mk).forEach(p => {
        if (p.isRemise && p.montant && !p.isCredit) {
          out[p.kind || 'autre'] += -p.montant; // positif = économie
          out.total += -p.montant;
        }
      });
    });
    return out;
  };

  /* Taux annoncé dans le libellé de la remise (« … 7,752% … » -> 7.752). */
  function nominalPct(name) {
    const m = /(\d+(?:[,.]\d+)?)\s*%/.exec(name || '');
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }
  S.nominalPct = nominalPct;

  /* Remises d'abonnement, telles que la facture les rattache.
     Le PDF imprime chaque remise sous l'offre qu'elle remise, avec la même
     quantité facturée : le parseur conserve ce lien (`base`, `baseMontant`).
     Le taux obtenu est donc le rapport de deux montants imprimés l'un sous
     l'autre — exact, et non plus un rapprochement de libellés. Deux offres
     distinctes portant des remises au libellé identique (« Accès de Base 47 % »
     sur l'accès de base et sur l'accès groupé) restent bien séparées.
     Contrôle : la somme de ces remises égale la ligne « remises » de la facture. */
  S.remiseRows = function () {
    const map = {};
    S.visibleMonths().forEach(mk => {
      S.monthProducts(mk).forEach(p => {
        if (!p.isRemise || !p.montant || p.isCredit) return;
        const key = `${p.name} ${p.base || ''}`;
        let e = map[key];
        if (!e) e = map[key] = {
          name: p.name, base: p.base || null, kind: p.kind || 'autre',
          total: 0, brut: 0, months: 0, nominal: nominalPct(p.name),
        };
        e.total += -p.montant;
        e.brut += p.baseMontant || 0;
        e.months += 1;
      });
    });
    return Object.values(map)
      .map(e => ({ ...e, taux: e.brut > 0 ? (e.total / e.brut) * 100 : null }))
      .sort((a, b) => b.total - a.total);
  };

  /* Avoirs et régularisations : lignes à quantité négative, facturées pour
     elles-mêmes. Ce ne sont pas des remises et elles ne se rapportent à aucune
     base — les mêler aux remises fausse le taux comme le total. */
  S.creditRows = function () {
    const map = {};
    S.visibleMonths().forEach(mk => {
      S.monthProducts(mk).forEach(p => {
        if (!p.isCredit || !p.montant) return;
        let e = map[p.name];
        if (!e) e = map[p.name] = { name: p.name, total: 0, occurrences: 0, monthKeys: [] };
        e.total += p.montant;
        e.occurrences += 1;
        // un même libellé peut apparaître plusieurs fois dans un même mois
        // (plusieurs comptes, plusieurs pages) : c'est le nombre de mois
        // distincts qui dit si le paramétrage reste faux dans la durée
        if (!e.monthKeys.includes(mk)) e.monthKeys.push(mk);
      });
    });
    return Object.values(map)
      .map(e => ({ ...e, months: e.monthKeys.length }))
      .sort((a, b) => a.total - b.total);
  };

  /* Remise obtenue par offre facturée — l'unité qui se négocie.
     Le taux d'une remise prise isolément ne veut rien dire : la remise marché
     porte sur le tarif de référence du marché, et les lignes « compensation
     augmentation » rattrapent les hausses intervenues depuis. Seul le cumul de
     toutes les remises d'une offre, rapporté à son brut, est comparable d'une
     offre à l'autre. */
  S.offerDiscounts = function () {
    const map = {};
    const get = (n) => map[n] || (map[n] = {
      name: n, brut: 0, marche: 0, compensation: 0, autre: 0, remise: 0, lines: 0,
      // mois où l'offre est effectivement facturée : toutes ne le sont pas sur
      // toute la période, et l'écran affichait la longueur de la période pour
      // chacune d'elles
      monthKeys: [],
    });
    S.visibleMonths().forEach(mk => {
      S.monthProducts(mk).forEach(p => {
        if (!p.montant || p.isCredit) return;
        if (p.isRemise) {
          if (!p.base) return;
          const e = get(p.base);
          e[p.kind || 'autre'] += -p.montant;
          e.remise += -p.montant;
        } else {
          const e = get(p.name);
          e.brut += p.montant;
          if (!e.monthKeys.includes(mk)) e.monthKeys.push(mk);
        }
      });
    });
    return Object.values(map)
      .filter(e => e.brut > 0)
      .map(e => ({ ...e, months: e.monthKeys.length,
        net: e.brut - e.remise, taux: (e.remise / e.brut) * 100 }))
      .sort((a, b) => b.brut - a.brut);
  };

  /* Offres dont le libellé annonce lui-même un taux qui n'est pas appliqué.
     Cas type : « abonnement Facture Dynamique Décision - remise 40% », facturé
     1 × 96,00 = 96,00 sans aucune ligne de remise en dessous. Ici le taux n'est
     pas une interprétation : il est écrit dans le nom du produit facturé, et la
     facture montre qu'aucune remise ne lui correspond. */
  S.unappliedLabelDiscounts = function () {
    return S.offerDiscounts().map(o => {
      const nominal = nominalPct(o.name);
      if (nominal === null) return null;
      const ecart = nominal - o.taux;
      if (ecart <= 1) return null;
      // chiffré facture par facture, comme le dossier de réclamation
      return { ...o, nominal, ecart, manque: S.claimableOn(o.name, nominal) };
    }).filter(Boolean).sort((a, b) => b.manque - a.manque);
  };

  /* Remise obtenue par ligne et par offre, à partir du rattachement de l'annexe.
     Permet de comparer une ligne à ses jumelles : deux lignes facturées pour la
     même offre doivent recevoir la même remise.

     Porte sur toutes les factures connues de la ligne, quelle que soit la
     période filtrée : `l.products` agrège les offres sans conserver le mois.
     Les écrans qui s'en servent le disent — on ne peut pas le redater sans
     changer le dataset produit par le parseur. */
  S.lineOfferRates = function (line) {
    const brut = {}, rem = {};
    (line.products || []).forEach(p => {
      if (p.isCredit) return;
      if (p.total < 0) { if (p.base) rem[p.base] = (rem[p.base] || 0) + -p.total; }
      else brut[p.name] = (brut[p.name] || 0) + p.total;
    });
    return Object.keys(brut).map(n => ({
      offer: n, brut: brut[n], remise: rem[n] || 0,
      taux: brut[n] > 0 ? ((rem[n] || 0) / brut[n]) * 100 : 0,
    }));
  };

  /* Lignes nettement moins remisées que leurs jumelles sur la MÊME offre.
     C'est le seul écart de remise qui constitue une anomalie individuelle : une
     offre non remisée pour tout le monde relève de la négociation, une ligne
     seule à ne pas recevoir la remise de ses voisines est une erreur. */
  S.lineDiscountOutliers = function (minPts, minBrut) {
    minPts = minPts || 5; minBrut = minBrut || 10;
    const per = {};
    S.activeLines().forEach(l => {
      S.lineOfferRates(l).forEach(r => {
        if (r.brut < minBrut) return;
        (per[r.offer] = per[r.offer] || []).push({ line: l, ...r });
      });
    });
    const out = [];
    Object.entries(per).forEach(([offer, rows]) => {
      if (rows.length < 3) return;          // pas de norme sur deux lignes
      const taux = rows.map(r => r.taux).sort((a, b) => a - b);
      const med = taux[Math.floor(taux.length / 2)];
      if (med <= 1) return;                 // offre non remisée pour tout le monde
      rows.forEach(r => {
        if (med - r.taux > minPts) {
          out.push({ ...r, offer, median: med, ecart: med - r.taux,
            manque: r.brut * (med - r.taux) / 100 });
        }
      });
    });
    return out.sort((a, b) => b.manque - a.manque);
  };

  /* Brut d'une offre sur la période (hors remises), par libellé. */
  S.brutByBaseName = function (months) {
    const map = {};
    (months || S.visibleMonths()).forEach(mk => {
      S.monthProducts(mk).forEach(p => {
        if (p.isRemise || !p.montant) return;
        map[p.name] = (map[p.name] || 0) + p.montant;
      });
    });
    return map;
  };

  /* Catégories de conso agrégées sur période — fusionne par nom net */
  S.consoCats = function () {
    const map = {};
    S.visibleMonths().forEach(mk => {
      S.monthConsoCats(mk).forEach(c => {
        const key = c.name;
        let e = map[key];
        if (!e) e = map[key] = { name: c.name, calls: 0, duration: 0, montant: 0, isRemise: !!c.isRemise };
        e.calls += c.calls || 0;
        e.duration += c.duration || 0;
        e.montant += c.montant || 0;
      });
    });
    return Object.values(map);
  };

  /* Familles de lignes dont l'absence d'appels est normale : un accès internet
     ne passe pas d'appels, une ligne d'ascenseur ne sert qu'en cas de panne.
     Les compter comme « inutilisées » gonflerait à tort le gisement d'économies. */
  S.NO_TRAFFIC_BY_DESIGN = new Set(['internet', 't0_ascenseur']);

  /* Lignes voix sans aucun appel au mois affiché — vraies candidates à revue.
     Indépendant du switch « Parc » : le constat porte sur le mois facturé. */
  S.linesNoConso = function () {
    const mk = S.month;
    return S.allLines().filter(l => {
      if (S.NO_TRAFFIC_BY_DESIGN.has(l.family)) return false;
      const v = l.months[mk];
      return v && (v.calls || 0) === 0;
    });
  };

  /* Lignes voix dormantes sur toute la période visible : signal bien plus fort
     qu'un mois isolé sans trafic. */
  S.linesDormant = function () {
    const ms = S.visibleMonths();
    return S.allLines().filter(l => {
      // une ligne déjà résiliée ne représente plus d'économie à aller chercher
      if (!l.isActive) return false;
      if (S.NO_TRAFFIC_BY_DESIGN.has(l.family)) return false;
      const seen = ms.filter(m => l.months[m]);
      return seen.length > 0 && seen.every(m => (l.months[m].calls || 0) === 0);
    });
  };

  /* Accès internet facturant de la consommation : anormal sur un forfait data,
     signe d'appels hors forfait ou de dépassement à vérifier. */
  S.internetWithConso = function () {
    const ms = S.visibleMonths();
    return S.allLines()
      .filter(l => l.family === 'internet')
      .map(l => {
        let conso = 0, calls = 0;
        const months = [];
        ms.forEach(m => {
          const v = l.months[m];
          if (!v) return;
          conso += v.conso || 0;
          calls += v.calls || 0;
          if ((v.conso || 0) > 0.005 || (v.calls || 0) > 0) months.push(m);
        });
        return { line: l, conso, calls, months };
      })
      .filter(x => x.conso > 0.005 || x.calls > 0)
      .sort((a, b) => b.conso - a.conso);
  };

  /* ------------------------------------------------- agrégats par période
     `l.totals` et `l.products` sont calculés par le parseur sur TOUS les mois du
     dataset : ils ignorent le filtre de dates. Une ligne sans un appel depuis
     avril affichait encore ses 173 appels de l'automne, et le taux de remise des
     T0 annonçait 48,1 % « sur la période » là où la période filtrée donne 42,4 %.

     Les montants et le trafic sont, eux, disponibles mois par mois dans
     `l.months` : on les recompose ici sur les mois visibles. La ventilation par
     offre (`l.products`) n'est pas datée — ce qui en dépend reste sur tout
     l'historique, et le dit. */
  S.linePeriod = function (l, months) {
    const ms = months || S.visibleMonths();
    const t = { n: 0, net: 0, brut: 0, remise: 0, conso: 0, calls: 0, monthsNoConso: 0 };
    ms.forEach(m => {
      const v = l.months[m];
      if (!v) return;
      t.n += 1;
      t.net += v.net || 0;
      t.brut += v.brut || 0;
      t.remise += -(v.remise || 0);   // stocké négatif sur la facture
      t.conso += v.conso || 0;
      t.calls += v.calls || 0;
      if ((v.calls || 0) === 0) t.monthsNoConso += 1;
    });
    t.avgNet = t.n ? t.net / t.n : 0;
    t.avgConso = t.n ? t.conso / t.n : 0;
    t.taux = t.brut > 0 ? (t.remise / t.brut) * 100 : 0;
    return t;
  };

  /* Les mêmes agrégats pour un ensemble de lignes, indexés par clé de ligne :
     une vue qui trie et affiche des dizaines de lignes ne doit pas recalculer
     la même somme à chaque comparaison. */
  S.linePeriods = function (lines, months) {
    const ms = months || S.visibleMonths();
    const out = {};
    lines.forEach(l => { out[l.key] = S.linePeriod(l, ms); });
    return out;
  };

  /* SDA portés par un ensemble de lignes.
     Un accès Numéris ne fait pas facturer ses SDA une par une : l'annexe porte
     « Abonnement SDA × 10 » sur la ligne de l'accès de base, et le parseur en
     garde la quantité (`sdaCount`). Compter les lignes facturées revient donc à
     annoncer un parc plus petit que le nombre de numéros en service — d'où la
     distinction faite à l'écran entre lignes facturées et numéros.
     Les canaux d'un accès groupé, eux, sont bien facturés ligne par ligne
     (famille `canal_sda`) : ils sont déjà comptés comme lignes, les additionner
     ici les compterait deux fois. */
  S.sdaTotal = function (lines) {
    return lines.reduce((a, l) => a + (l.sdaCount || 0), 0);
  };

  /* Lignes qui portent au moins un SDA — les accès de base concernés. */
  S.linesWithSda = function (lines) {
    return lines.filter(l => (l.sdaCount || 0) > 0);
  };

  /* Coût mensuel d'un ensemble de lignes au mois affiché. */
  S.monthlyCost = function (lines, mk) {
    mk = mk || S.month;
    return lines.reduce((a, l) => a + (l.months[mk]?.net || 0), 0);
  };

  /* ---------------------------------------------------------------- recherche
     Index plat de tout le dataset : lignes, sites, factures, offres & remises.
     Les numéros sont indexés sans séparateur pour que « 0146 55 » matche. */
  const norm = s => String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const digits = s => String(s ?? '').replace(/\D/g, '');

  let _index = null;

  S.invalidateIndex = function () { _index = null; };

  S.buildIndex = function () {
    const d = S.data;
    if (!d) return (_index = []);
    const idx = [];
    const push = (o) => { o.hay = norm(o.terms.filter(Boolean).join(' ')); idx.push(o); };

    // Un site renommé doit se retrouver sous son nom d'usage comme sous celui
    // de la facture : les deux sont indexés, aucun ne remplace l'autre.
    const usage = id => (S.siteNames[id] || {}).name || '';

    d.lines.forEach(l => push({
      kind: 'line', id: l.key, icon: 'phone',
      title: l.number,
      subtitle: `${l.familyLabel} · ${window.fmt.site(l)} · sous-compte ${l.siteId}`,
      route: `#/lines?q=${encodeURIComponent(l.number)}`,
      obj: l,
      num: digits(l.number),
      terms: [l.number, l.key, l.familyLabel, l.label, l.siteName, l.siteDept,
        usage(l.siteId), l.siteId, l.siteAddress, l.account, l.attachedTo,
        l.siteInternet, ...(l.products || []).map(p => p.name)],
    }));

    d.sites.forEach(s => push({
      kind: 'site', id: s.id, icon: 'building',
      title: window.fmt.site(s),
      subtitle: `Sous-compte ${s.id} · ${s.lineCount} ligne(s) · ${s.address || ''}`,
      route: `#/sites?q=${encodeURIComponent(s.id)}`,
      obj: s,
      num: digits(s.id),
      terms: [usage(s.id), s.name, s.dept, s.address, s.id, s.entity, s.account],
    }));

    d.invoices.forEach(i => push({
      kind: 'invoice', id: i.numero, icon: 'invoice',
      title: `Facture ${i.numero}`,
      subtitle: `${window.fmt.monthLabel(i.month)} · compte ${i.compte} · ${window.fmt.eur(i.totals.ttc)} TTC`,
      route: `#/invoices?q=${encodeURIComponent(i.numero)}`,
      obj: i,
      num: digits(i.numero),
      terms: [i.numero, i.compte, i.marche, i.month, i.date],
    }));

    const offers = {};
    d.months.forEach(mk => (d.monthly[mk]?.products || []).forEach(p => {
      const e = offers[p.name] || (offers[p.name] = { name: p.name, isRemise: p.isRemise, total: 0 });
      e.total += p.montant || 0;
    }));
    Object.values(offers).forEach(o => push({
      kind: o.isRemise ? 'remise' : 'offer', id: o.name,
      icon: o.isRemise ? 'percent' : 'tag',
      title: o.name,
      subtitle: `${o.isRemise ? 'Remise' : 'Offre'} · ${window.fmt.eur(o.total)} sur la période`,
      route: o.isRemise ? '#/remises' : '#/conso',
      obj: o,
      terms: [o.name],
    }));

    return (_index = idx);
  };

  S.KINDS = {
    line: 'Lignes', site: 'Sites', invoice: 'Factures',
    offer: 'Offres', remise: 'Remises',
  };

  /* Recherche multi-termes (ET) sur tout le dataset. */
  S.search = function (q, limit) {
    const raw = String(q || '').trim();
    if (raw.length < 2) return [];
    if (!_index) S.buildIndex();
    const terms = norm(raw).split(/\s+/).filter(Boolean);
    const qNum = digits(raw);
    const out = [];
    for (const it of _index) {
      if (S.account !== 'all' && it.obj.account && it.obj.account !== S.account) continue;
      let score = 0, ok = true;
      for (const t of terms) {
        const at = it.hay.indexOf(t);
        if (at < 0) { ok = false; break; }
        score += at === 0 ? 12 : (it.hay[at - 1] === ' ' ? 8 : 3);
      }
      // un numéro tapé sans espaces doit retrouver « 01 46 55 … »
      if (!ok && qNum.length >= 3 && it.num && it.num.includes(qNum)) {
        ok = true;
        score = it.num.startsWith(qNum) ? 30 : 16;
      }
      if (!ok) continue;
      if (norm(it.title).startsWith(terms[0])) score += 20;
      out.push({ ...it, score });
    }
    out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return limit ? out.slice(0, limit) : out;
  };

  S.accountLabel = function (id) {
    const a = (S.data.accounts || []).find(x => x.id === id);
    if (!a) return id;
    const m = (a.marches || []).slice(-1)[0];
    return m ? m.label : `Compte ${id}`;
  };

  /* ═══════════════════════════════════════════════════════════════
     Audit — leviers d'économie et anomalies de facturation
     ═══════════════════════════════════════════════════════════════ */

  /* Brut / remise / taux d'une ligne sur la période visible.
     Sommés sur `l.months`, et non sur `l.products` qui porte tout l'historique :
     les jauges de l'audit annonçaient un taux et un brut de treize mois sous un
     titre « sur la période ». */
  function lineMoney(l, months) {
    const t = S.linePeriod(l, months);
    return { brut: t.brut, remise: t.remise, taux: t.taux };
  }
  S.lineMoney = lineMoney;

  /* Taux de remise obtenu par famille : révèle les familles mal négociées.
     On compare chaque ligne au meilleur taux constaté sur sa propre famille. */
  S.discountByFamily = function () {
    const agg = {};
    const ms = S.visibleMonths();
    S.copperOrAllActive().forEach(l => {
      const m = lineMoney(l, ms);
      if (m.brut <= 0) return;
      const e = agg[l.family] || (agg[l.family] = {
        family: l.family, label: l.familyLabel, brut: 0, remise: 0,
        lines: 0, noDiscount: 0, best: 0,
      });
      e.brut += m.brut; e.remise += m.remise; e.lines += 1;
      if (m.remise <= 0.005) e.noDiscount += 1;
      if (m.taux > e.best) e.best = m.taux;
    });
    return Object.values(agg)
      .map(e => ({ ...e, taux: e.brut > 0 ? (e.remise / e.brut) * 100 : 0 }))
      .sort((a, b) => b.brut - a.brut);
  };

  /* Lignes en service ne recevant aucune remise, alors que leur famille en
     obtient ailleurs : écart contractuel à faire corriger. */
  S.linesWithoutDiscount = function () {
    const best = {};
    const ms = S.visibleMonths();
    S.discountByFamily().forEach(f => { best[f.family] = f.best; });
    return S.activeLines()
      .map(l => ({ line: l, ...lineMoney(l, ms) }))
      .filter(x => x.remise <= 0.005 && x.brut > 0 && (best[x.line.family] || 0) > 1)
      .map(x => ({
        ...x,
        // ce que la ligne coûterait au meilleur taux constaté sur sa famille
        gain: x.line.lastNet * ((best[x.line.family] || 0) / 100),
      }))
      .sort((a, b) => b.gain - a.gain);
  };

  /* Base de travail de l'audit : le parc en service, quel que soit le switch. */
  S.copperOrAllActive = function () { return S.activeLines(); };

  /* Décomposition d'un écart entre deux mois : ce qui vient du nombre de
     lignes (volume) et ce qui vient du prix unitaire (tarif). Sans cette
     séparation, une hausse de tarif se cache derrière des résiliations. */
  S.varianceBetween = function (mA, mB) {
    if (!mA || !mB) return null;
    const ls = S.allLines();
    // accepte un mois ou une fenêtre de mois : un mois isolé portant un avoir
    // fausserait complètement la comparaison
    const at = mm => {
      const arr = Array.isArray(mm) ? mm : [mm];
      let total = 0, count = 0;
      arr.forEach(m => {
        const rows = ls.filter(l => l.months[m]);
        total += rows.reduce((a, l) => a + l.months[m].net, 0);
        count += rows.length;
      });
      // Le parc moyen n'est pas entier (67,7 lignes sur 3 mois) : l'arrondir ici
      // casserait l'identité volume + tarif = écart, et l'écran affichait alors
      // deux effets dont la somme ne tombait pas sur le total facturé.
      return {
        month: arr[arr.length - 1], months: arr, span: arr.length,
        n: count / arr.length, total: total / arr.length,
        unit: count ? total / count : 0,
      };
    };
    const a = at(mA), b = at(mB);
    return {
      from: a, to: b,
      delta: b.total - a.total,
      // effet volume valorisé au prix d'origine, effet prix sur le parc final
      volume: (b.n - a.n) * a.unit,
      price: (b.unit - a.unit) * b.n,
      unitPct: a.unit > 0 ? ((b.unit - a.unit) / a.unit) * 100 : 0,
    };
  };

  /* Bascules de marché repérées sur la période, avec leur effet tarifaire. */
  S.marketShifts = function () {
    const out = [];
    (S.data.accounts || []).forEach(acc => {
      const ms = acc.marches || [];
      for (let i = 1; i < ms.length; i++) {
        const pivot = ms[i].from;
        const monthsOf = S.data.months.filter(m =>
          S.data.monthly[m] && S.data.monthly[m].accounts[acc.id]);
        // fenêtre de 3 mois de part et d'autre : lisse avoirs et régularisations
        const before = monthsOf.filter(m => m < pivot).slice(-3);
        const after = monthsOf.filter(m => m >= pivot).slice(0, 3);
        if (!before.length || !after.length) continue;
        const prev = S.account;
        S.account = acc.id;
        const v = S.varianceBetween(before, after);
        // un mois isolé donnerait un tout autre chiffre : on le mesure pour
        // pouvoir prévenir quand l'écart dépend fortement de la fenêtre
        const vSpot = S.varianceBetween(before.slice(-1), after.slice(0, 1));
        S.account = prev;
        if (v) out.push({
          account: acc.id, from: ms[i - 1].label, to: ms[i].label, pivot,
          variance: v,
          volatile: vSpot && Math.abs(vSpot.unitPct - v.unitPct) > 15,
        });
      }
    });
    return out;
  };

  /* Hausses tarifaires simultanées : un même mois qui renchérit des dizaines
     de lignes signale un changement de grille, pas un incident isolé. */
  S.priceEvents = function (minPct, minEur) {
    minPct = minPct || 10; minEur = minEur || 1;
    const ms = S.visibleMonths();
    const events = {};
    S.allLines().forEach(l => {
      for (let i = 1; i < ms.length; i++) {
        const a = l.months[ms[i - 1]], b = l.months[ms[i]];
        if (!a || !b || a.net <= 0.5) continue;
        const d = b.net - a.net;
        if (d > minEur && (d / a.net) * 100 >= minPct) {
          const e = events[ms[i]] || (events[ms[i]] = { month: ms[i], lines: [], delta: 0 });
          e.lines.push({ line: l, from: a.net, to: b.net, delta: d });
          e.delta += d;
        }
      }
    });
    return Object.values(events).sort((a, b) => b.delta - a.delta);
  };

  /* Régularisations : normales à l'unité, suspectes si elles se répètent.
     Lues sur `l.products`, donc sur toutes les factures de la ligne et non sur
     la période filtrée — l'écran l'annonce ainsi. La version datée de ce constat
     existe côté offres : `creditRows`, qui passe par les produits mensuels. */
  S.regularisations = function () {
    const map = {};
    S.allLines().forEach(l => {
      (l.products || []).forEach(p => {
        if (!/gularisation/i.test(p.name || '')) return;
        const e = map[p.name] || (map[p.name] = { name: p.name, total: 0, lines: 0, months: 0 });
        e.total += p.total; e.lines += 1; e.months += p.months || 1;
      });
    });
    return Object.values(map).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  };

  /* Gisement consolidé : ce qu'on peut aller chercher, par levier.

     Le levier « remises » se mesure au niveau de l'OFFRE, pas de la ligne.
     Il a été vérifié qu'aucune ligne n'est individuellement moins remisée que
     ses jumelles (`lineDiscountOutliers` est vide) : l'écart tient entièrement
     au fait que certaines offres — les accès internet — ne sont pas remisées du
     tout, là où les offres voix obtiennent 50 à 62 %.

     L'ancien calcul comparait chaque ligne au meilleur taux de sa famille et
     annonçait « 30 lignes sans remise » : il décrivait la même question sous une
     forme qui laissait croire à des lignes oubliées. */
  S.SEUIL_NON_REMISEE = 5;      // en deçà, une offre est de fait non remisée

  /* Ventilation d'une offre par facture : le manque se chiffre facture par
     facture, jamais en agrégé. Sinon une facture déjà correctement remisée
     compense une facture qui ne l'est pas, et l'écran réclame sur les deux. */
  S.offerParts = function (offerName) {
    const parts = {};
    S.visibleMonths().forEach(mk => {
      S.monthProducts(mk).forEach(p => {
        if (!p.montant || p.isCredit) return;
        const target = p.isRemise ? p.base : p.name;
        if (target !== offerName) return;
        const k = `${mk}|${p.compte || ''}|${p.facture || ''}`;
        const e = parts[k] || (parts[k] = { month: mk, compte: p.compte,
          facture: p.facture, brut: 0, remise: 0 });
        if (p.isRemise) e.remise += -p.montant; else e.brut += p.montant;
      });
    });
    return Object.values(parts).filter(e => e.brut > 0);
  };

  S.discountGap = function () {
    const offers = S.offerDiscounts();
    const remisees = offers.filter(o => o.taux >= S.SEUIL_NON_REMISEE);
    // Une offre dont le libellé annonce lui-même un taux relève du constat
    // opposable, pas de l'écart entre offres : la compter dans les deux
    // additionnait deux fois le même poste dans le gisement.
    const parLibelle = new Set(S.unappliedLabelDiscounts().map(o => o.name));
    const nues = offers.filter(o => o.taux < S.SEUIL_NON_REMISEE && o.brut > 200
      && !parLibelle.has(o.name));
    const refBrut = remisees.reduce((a, o) => a + o.brut, 0);
    const refTaux = refBrut > 0
      ? (remisees.reduce((a, o) => a + o.remise, 0) / refBrut) * 100 : 0;
    const total = nues.reduce((a, o) => a + S.claimableOn(o.name, refTaux), 0);
    const nMonths = Math.max(S.visibleMonths().length, 1);
    return { offers: nues, refTaux, period: total, monthly: total / nMonths,
      yearly: (total / nMonths) * 12 };
  };

  /* Montant réclamable sur une offre pour atteindre `cible`, facture par
     facture. Une facture déjà au niveau attendu ne donne lieu à rien.

     Même arrondi que le dossier exporté — taux cible arrêté à deux décimales,
     montants arrondis par facture puis sommés — pour que l'écran et la pièce
     jointe affichent le même total au centime. */
  const r2 = x => Math.round(x * 100) / 100;
  S.claimableOn = function (offerName, cible) {
    cible = r2(cible);
    return S.offerParts(offerName).reduce((a, e) => {
      const brut = r2(e.brut), remise = r2(e.remise);
      if (brut <= 0) return a;
      const reclame = r2(brut * cible / 100 - remise);
      return a + (reclame > 0 ? reclame : 0);
    }, 0);
  };

  S.savings = function () {
    const dormant = S.linesDormant();
    const dormantCost = dormant.reduce((a, l) => a + l.lastNet, 0);
    const gap = S.discountGap();
    const unapplied = S.unappliedLabelDiscounts();
    const nMonths = Math.max(S.visibleMonths().length, 1);
    const unapMonthly = unapplied.reduce((a, o) => a + o.manque, 0) / nMonths;
    const copper = S.copperLines();
    const copperCost = copper.reduce((a, l) => a + l.lastNet, 0);
    return {
      dormant: { n: dormant.length, monthly: dormantCost, yearly: dormantCost * 12 },
      // remise inscrite dans le libellé du produit et jamais portée : certain
      unapplied: { n: unapplied.length, monthly: unapMonthly, yearly: unapMonthly * 12 },
      // offres non remisées : chiffré, mais suspendu à la grille du marché
      discount: { n: gap.offers.length, monthly: gap.monthly, yearly: gap.yearly },
      copper: { n: copper.length, monthly: copperCost, yearly: copperCost * 12 },
      total: {
        monthly: dormantCost + unapMonthly + gap.monthly,
        yearly: (dormantCost + unapMonthly + gap.monthly) * 12,
      },
    };
  };

  window.Store = S;
})();
