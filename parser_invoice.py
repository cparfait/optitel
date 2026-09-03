# -*- coding: utf-8 -*-
"""
Parseur des factures Orange Business (téléphonie fixe / internet).
Extrait :
  - facture (.F.) : meta, totaux, synthèse des offres (produits + remises), synthèse consommations
  - annexe (.A.)  : sous-comptes (sites), lignes, produits par ligne, consommations par ligne,
                    détail des appels, synthèse des services (validation)
Produit un dataset JSON agrégé pour l'interface web.
"""
import re
import os
import sys
import json
import glob
import hashlib
import datetime
import unicodedata

from pypdf import PdfReader

# ---------------------------------------------------------------- helpers

def parse_fr(s):
    """'1 980,70' -> 1980.70"""
    if s is None:
        return None
    s = s.strip().replace(' ', '').replace('\u00a0', '').replace('\u202f', '')
    s = s.replace('€', '').rstrip('.')
    if not s or s == '-':
        return None
    neg = s.startswith('-')
    s = s.lstrip('-')
    s = s.replace(',', '.')
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def parse_dur(s):
    """'26:26:57' -> secondes ; '0:30:47' aussi"""
    s = s.strip()
    m = re.match(r'^(\d+):(\d{1,2}):(\d{1,2})$', s)
    if not m:
        return None
    h, mi, se = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return h * 3600 + mi * 60 + se


def fmt_num(x):
    return round(x, 2) if x is not None else None


RE_MONEY = re.compile(r'^-?[\d\s\u00a0\u202f]+,\d{1,5}-?$')
RE_INT = re.compile(r'^-?\d+$')
RE_TVA = re.compile(r'^\d{1,2},\d$')

PAGE_HEADER_RE = re.compile(
    r'^(Business\s*\n)?facture( - annexe)?\n[^\n]*\n'
    r'n° de facture[?: \t]*\n\d+\n'
    r'date de facture[?: \t]*\n[\d/]+\n'
    r'compte client[?: \t]*\n\d+\n'
    r'Page ?: ?\d+(/(\d+))?\s*$'
)

# blocs d'en-tête de tableaux à ignorer
TABLE_HEADERS = {
    'quantité', 'facturée', 'PU/base', 'EUR', 'HT', 'montant', 'remise', 'taux',
    'TVA', 'nb', 'appel', 'durée', '/', 'quantité', 'unité', 'oeuvre',
    'n°', 'appelé', 'destination', 'famille', 'tarifaire', 'origine', 'heures',
    'nombre', 'd\'appels', 'forfait', 'utilisé', 'montants', 'ventilables',
    'abonnements', 'et', 'options', 'forfaits', 'consommations', '(hors',
    'au-delà', 'des', 'forfaits)', 'hors', 'ponctuels', 'autres', 'charges',
    'remises', 'total', 'EUR HT',
}

FOOTER_JUNK = {'ruelav snas tnemucoD', 'elacsﬁ te euqidiruj', 'Document sans valeururidiction fi_scale'.replace('uridiction fi_scale', '')}


def clean_page_text(txt):
    """Nettoie l'en-tête/pied de page d'une page d'annexe."""
    lines = txt.split('\n')
    out = []
    i = 0
    # skip header: jusqu'à "Page : N"
    while i < len(lines):
        l = lines[i].strip()
        if re.match(r'^Page ?: ?\d+', l):
            i += 1
            break
        i += 1
    for j in range(i, len(lines)):
        l = lines[j]
        s = l.strip()
        if s in ('ruelav snas tnemucoD', 'elacsﬁ te euqidiruj', 'Document sans valeururidiction' ):
            continue
        out.append(l.rstrip())
    return out


def strip_table_headers(lines):
    """Retire les lignes d'en-tête de colonnes (mots isolés connus,
    y compris plusieurs mots fusionnés sur une même ligne)."""
    out = []
    for l in lines:
        s = l.strip()
        if not s:
            out.append(l)
            continue
        if s.lower() in TABLE_HEADERS:
            continue
        toks = s.split()
        if toks and all(t.lower() in TABLE_HEADERS for t in toks):
            continue
        out.append(l)
    return out


RE_YEAR = re.compile(r'^(19|20)\d{2}$')
RE_PERIOD_PREFIX = re.compile(
    r'^(?:du )?\d{2}\.\d{2}\.\d{4}(?: AU \d{2}\.\d{2}\.\d{4})?\s+', re.I)
# même chose en notation « du 01/09/2025 au 30/09/2025 », qui traîne devant un
# libellé quand la période a été recollée à l'en-tête de page
RE_PERIOD_SLASH_PREFIX = re.compile(
    r'^(?:du )?\d{2}/\d{2}/\d{4}(?: au \d{2}/\d{2}/\d{4})?\s+', re.I)


def is_year(s):
    return bool(RE_YEAR.match(s.strip()))


HEADER_PHRASES = [
    r'^PU/base EUR HT remise HT TVA EUR HT\s+',
    r'^quantité facturée PU/base EUR HT montant remise HT taux TVA montant EUR HT\s+',
    r'^nb appel durée / quantité unité oeuvre PU/base EUR HT taux TVA montant EUR HT\s+',
    r'^date heure n° appelé destination n durée famille tarifaire origine montant EUR HT\s+',
    r'^(?:[a-z%/éèàû]+ )+(?=[A-Z(])',
]


def clean_product_name(name):
    """Normalise un nom de produit : retire préfixe période, préfixe entité,
    préfixes d'en-tête de tableau fusionnés par l'extraction PDF."""
    name = re.sub(r'\s+', ' ', name).strip()
    # Un saut de page au milieu d'un tableau recolle « Page : 4/5 » puis l'en-tête
    # de colonnes devant le libellé. Sans ce retrait, le même produit apparaît
    # deux fois : une fois propre, une fois préfixé de l'habillage de page.
    name = re.sub(r'^Page\s*:?\s*\d+\s*/\s*\d+\s+', '', name, flags=re.I)
    name = RE_PERIOD_PREFIX.sub('', name)
    if name.startswith('- '):
        name = name[2:].strip()
    for ph in HEADER_PHRASES[:4]:
        name = re.sub(ph, '', name)
    # l'en-tête peut être suivi d'une période, elle-même suivie du vrai libellé
    name = RE_PERIOD_SLASH_PREFIX.sub('', name)
    name = RE_PERIOD_PREFIX.sub('', name)
    # préfixe entité en MAJUSCULES résiduel ("COMMUNE DE CHATILLON Internet pro…")
    name = re.sub(r"^(?:[A-Z0-9@'\-]{2,}\s+){1,5}(?=[A-Z][a-zà-ÿ(])", '', name)
    return name.strip()


def is_money(s):
    s = s.strip()
    return bool(re.match(r'^-?[\d\s\u00a0\u202f]+,\d{1,5}$', s))


def is_int(s):
    return bool(RE_INT.match(s.strip()))


# Un compte client (9 chiffres) ou une date lus comme un nombre d'appels donnent
# des valeurs sans rapport : au-delà de ce seuil, la valeur est rejetée.
MAX_PLAUSIBLE_CALLS = 1_000_000

# Bruit de mise en page ramassé entre deux tableaux : marqueurs de page, mentions
# légales (parfois extraites à l'envers par le PDF), en-têtes de facture.
LAYOUT_NOISE_RE = re.compile(
    r'@@@PAGE|document sans valeur|ruelav snas tnemucod|'
    r'date de facture|compte client|n° de facture|numero de facture|'
    r'^page\s*[:\d]|^total\b|^sous-total|^report\b|^suite\b|'
    r'orange business|^siret|^tva intracom|^rcs\b|'
    # en-têtes de colonnes et totaux de rubrique recollés en un seul libellé :
    # ce sont des récapitulatifs, les compter reviendrait à doubler le détail
    r'pu\s*/\s*base|total\s+ht\s*:|d[ée]tail disponible|dans l\'annexe|'
    r'achats à l\'acte',
    re.I)


def attach_remise_base(previous, prod):
    """Rattache `prod`, si c'est une remise, au dernier produit facturé au-dessus.

    Même convention que dans la synthèse des offres : la facture n'exprime le
    lien remise -> offre que par l'ordre d'impression. Une régularisation
    (quantité négative, PU propre) est une ligne autonome : elle ne se rattache
    à rien et devient elle-même une base potentielle.
    """
    montant = prod.get('montant')
    if montant is None:
        return
    qty = prod.get('qty')
    is_credit = montant < 0 and qty is not None and qty < 0
    prod['isCredit'] = is_credit
    if montant >= 0 and not str(prod.get('name', '')).lower().startswith('remise'):
        return
    if is_credit:
        return
    for p in reversed(previous):
        pm = p.get('montant')
        if pm is None or p.get('isCredit'):
            continue
        if pm >= 0 and not str(p.get('name', '')).lower().startswith('remise'):
            prod['base'] = p['name']
            prod['baseMontant'] = pm
            return


def looks_like_qty_row(lines, j):
    """Vrai si `lines[j]` ouvre une ligne « qté · PU · TVA · montant ».

    La quantité facturée est presque toujours un entier, sauf sur un prorata de
    mois partiel où elle s'écrit « 0,2666 ». On ne l'accepte comme quantité que
    si les quatre colonnes du tableau sont bien là derrière : sinon c'est un
    montant isolé, et le libellé n'est pas terminé.
    """
    vals = []
    k = j
    while k < len(lines) and len(vals) < 4:
        v = lines[k].strip()
        if not is_money(v) and not is_int(v):
            break
        vals.append(v)
        k += 1
    return len(vals) >= 4 and any(RE_TVA.match(v) for v in vals[1:])


def is_layout_noise(name):
    """Vrai si le libellé provient de l'habillage de la page, pas d'un tableau."""
    s = clean_text(name)
    if len(s) < 3:
        return True
    if LAYOUT_NOISE_RE.search(s):
        return True
    # une catégorie de conso contient des lettres ; « 05/08/2025 » n'en a pas
    return not re.search(r'[A-Za-zÀ-ÿ]{3}', s)


def split_pages(text):
    """'@@@PAGE n@@@' -> {n: texte}"""
    parts = re.split(r'@@@PAGE (\d+)@@@', text)
    out = []
    for i in range(1, len(parts), 2):
        out.append((int(parts[i]), parts[i + 1]))
    return out


def section_of_page(txt):
    h = re.search(r'facture - annexe\s*\n([^\n]+)', txt)
    if h:
        return h.group(1).strip().lower()
    return None


SECTION_LABELS = {
    'sommaire': 'sommaire',
    'synthèse des charges par sous-compte': 'charges',
    'détail des produits et services': 'produits',
    'détail des consommations par ligne': 'conso',
    'synthèse des services': 'services',
    'programme préférence entreprise': 'preference',
}

# ---------------------------------------------------------------- extraction PDF (avec cache)

# Cache du texte extrait des PDF. Chemin absolu et non relatif au répertoire
# courant : en conteneur le processus ne démarre pas forcément dans le dossier du
# code, et un cache écrit ailleurs se reconstruirait à chaque lancement.
CACHE_DIR = os.environ.get('OPTITEL_CACHE_DIR') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '.cache_txt')


def pdf_text_cached(pdf_path, cache_dir=None):
    cache_dir = cache_dir or CACHE_DIR
    os.makedirs(cache_dir, exist_ok=True)
    h = hashlib.md5(open(pdf_path, 'rb').read()).hexdigest()[:16]
    cache = os.path.join(cache_dir, h + '.txt')
    if os.path.exists(cache):
        return open(cache, encoding='utf-8').read()
    r = PdfReader(pdf_path)
    txt = ''
    for i, p in enumerate(r.pages):
        txt += f'\n@@@PAGE {i+1}@@@\n' + (p.extract_text() or '')
    open(cache, 'w', encoding='utf-8').write(txt)
    return txt


# ---------------------------------------------------------------- libellés de sites

# Sur les factures Orange, le bloc adresse porte la raison sociale (identique pour
# tous les sous-comptes) ; le vrai nom du local est noyé dans l'adresse, soit après
# un « @ », soit avant le début de la voie. On le sépare ici de la direction/service.
_VOIE = (r'RUE|AVENUE|AVE|AV|BOULEVARD|BD|PLACE|PL|ALLEE|ALL|VILLA|IMPASSE|IMP|'
         r'CHEMIN|ROUTE|RTE|SQUARE|QUAI|PASSAGE|SENTE|SENTIER|CITE|COURS|'
         r'ESPLANADE|PARVIS|MAIL|PROMENADE|VOIE|RESIDENCE|RES|CARREFOUR|ROND POINT')
NUM_VOIE_RE = re.compile(
    r'\b(\d+(?:[-/]\d+)?\s*(?:B|BIS|T|TER|Q|QUATER)?\s+(?:%s)\b)' % _VOIE)
VOIE_RE = re.compile(r'\b((?:%s)\b)' % _VOIE)
# regroupement analytique : "GS ECOLES MATERNELLES - E 40.211 EM DES SABLONS ..."
GROUP_PREFIX_RE = re.compile(r'^(GS\s+[A-Z\' ]+?)\s*-\s*E\s*\d+[\d. ]*I?\s+', re.I)
# direction suivie de son code : "ADMINISTRATION GENERALE -G12.020 BOURSE DU TRAVAIL"
DEPT_CODE_RE = re.compile(
    r'^([A-Z][A-Z\'. ]{4,}?)\s*-\s*(?:[A-Z]?\d[\d.]*[A-Z]?\d*)(?:\s+N\s*[\d.]+)?\s+', re.I)
# direction sans code, suivie de son acronyme : "CENTRE DE LOISIRS MATERNELS CDLM X"
DEPT_ACRO_RE = re.compile(
    r'^(CENTRE DE LOISIRS MATERNELS|SYNDICAT D\'INITIATIVE|SERVICE JEUNESSE|'
    r'SERVICE INFORMATION|ADMINISTRATION GENERALE|ASS DE ARTISTES CHATILLONAIS)'
    r'\s*-?\s*(?:CDLM|ASS DE ARTISTES CHATILLONAIS)?\s+', re.I)
# code analytique résiduel en fin de nom : "CRECHE FAMILIAE P55"
TRAIL_CODE_RE = re.compile(r'\s*-?\s*\b[A-Z]\d{1,2}(?:[.\d]+)?\b(?:\s+N\s*[\d.]+)?\s*$')
# qualificatif du local rejeté après la voie : "... 1 PLACE DE LA LIBERTE ASCENSEUR"
SITE_SUFFIX_RE = re.compile(
    r'\s+(ASCENSEUR|CIMETIERE|CIMETIER|CTM|CMS|ECOLES|LABO PHOTO|IMPRIMERIE|'
    r'CENTRE PREVERT|CDL DU PARC)\s*$', re.I)

LIGATURES = {'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl'}


def clean_text(s):
    """Normalise les ligatures laissées par l'extraction PDF et les espaces."""
    for k, v in LIGATURES.items():
        s = (s or '').replace(k, v)
    return re.sub(r'\s+', ' ', s or '').strip()


ABBREV = {'AVENUE': 'AV', 'AVE': 'AV', 'BOULEVARD': 'BD', 'PLACE': 'PL',
          'ALLEE': 'ALL', 'IMPASSE': 'IMP', 'ROUTE': 'RTE', 'RESIDENCE': 'RES',
          'SAINT': 'ST', 'BIS': 'B', 'DE': '', 'DU': '', 'DES': '', 'LA': '',
          'LE': '', 'LES': '', 'L': ''}


def street_key(street):
    """Clé d'un lieu physique : deux sous-comptes à la même adresse la partagent."""
    s = unicodedata.normalize('NFKD', clean_text(street).upper())
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r'[^A-Z0-9 ]', ' ', s)
    toks = []
    for t in s.split():
        t = ABBREV.get(t, t)
        if t:
            toks.append(t)
    # "8-12 RUE X" et "8 RUE X" désignent le même lieu : on garde le 1er numéro
    if toks and re.match(r'^\d', toks[0]):
        toks[0] = re.split(r'[-/]', toks[0])[0]
    return ' '.join(toks)


def split_site_label(address, fallback=''):
    """Découpe un bloc adresse en (nom du local, direction/service, voie)."""
    a = clean_text(address)
    if not a:
        return fallback, '', ''
    head = ''
    if '@' in a:                       # "ECOLE GAMBETTA@ 19 RUE GAMBETTA"
        head, a = [x.strip() for x in a.split('@', 1)]

    dept = ''
    m = GROUP_PREFIX_RE.match(a) or DEPT_CODE_RE.match(a) or DEPT_ACRO_RE.match(a)
    if m:
        dept = clean_text(m.group(1)).rstrip(' -')
        a = a[m.end():]

    m = NUM_VOIE_RE.search(a) or VOIE_RE.search(a)
    if m:
        name_part, street = a[:m.start()].strip(), a[m.start():].strip()
    else:
        name_part, street = a, ''

    suffix = ''
    sm = SITE_SUFFIX_RE.search(street)
    if sm:
        suffix = clean_text(sm.group(1)).upper()
        street = street[:sm.start()].strip()
    # numéro de voie isolé, resté du côté du nom : "9" + "11 RUE JEAN MACE"
    if street and re.match(r'^\d+(?:[-/]\d+)?$', name_part):
        street, name_part = name_part + '-' + street, ''

    name_part = TRAIL_CODE_RE.sub('', name_part).strip(' -,')
    name = ' '.join(x for x in (head, name_part) if x).strip(' -,')
    if suffix and suffix not in name.upper():
        name = (name + ' - ' + suffix) if name else suffix
    if not name:
        name, dept = dept, ''
    return (name or fallback), dept, street


# ---------------------------------------------------------------- types de lignes

LINE_TYPE_LABELS = [
    ('ligne téléphonique', 't0'),
    ('ligne Numéris accès de base', 'numeris'),
    ('ligne de type résidentiel', 'residentiel'),
    ('ligne analogique', 't0'),
    ('accès internet', 'internet'),
    ('accès groupé', 'numeris'),
]


# Technologie d'accès, déduite des produits facturés. Elle décide si l'accès est
# porté par la paire de cuivre (donc concerné par la fermeture du RTC) ou non.
# L'Airbox est une clé 4G de secours : elle ne qualifie pas l'accès principal.
ACCESS_TECH = [
    ('fibre', re.compile(r'\bfibre\b|\bftt[hoe]\b', re.I), False),
    ('sdsl', re.compile(r'\bsdsl\b', re.I), True),
    ('adsl', re.compile(r'\b[vah]?dsl\b', re.I), True),
]


def detect_access_tech(products):
    """(code techno, sur_cuivre). 'xdsl_presume' quand rien ne tranche."""
    names = ' '.join((p.get('name') or '') for p in products)
    for code, rx, copper in ACCESS_TECH:
        if rx.search(names):
            return code, copper
    # Les offres Orange Business sans mention de fibre sont historiquement xDSL.
    # On le signale comme une présomption, pas comme un fait établi.
    return 'xdsl_presume', True


def classify_line(number, label, products):
    """family: t0 | t0_ascenseur | numeris | canal_sda | residentiel | internet | autre"""
    has = lambda sub: any(sub.lower() in (p['name'] or '').lower() for p in products)
    label = (label or '').lower()
    letters = bool(re.search(r'[A-Z]', number or ''))
    is_num = 'numéris' in label or 'numeris' in label
    is_web = 'internet' in label
    is_res = 'résidentiel' in label or 'residentiel' in label
    if is_web or has('Internet pro') or has('Livebox'):
        return 'internet'
    if is_num:
        return 'canal_sda' if letters else 'numeris'
    if letters or has('accès groupé') or has('Accès groupé'):
        return 'canal_sda'
    if is_res or has('Abonnement principal'):
        return 'residentiel'
    # t0
    if has('ascenseur'):
        return 't0_ascenseur'
    return 't0'


FAMILY_LABELS = {
    't0': 'T0 analogique',
    't0_ascenseur': 'T0 ascenseur',
    'numeris': 'Numéris accès de base',
    'canal_sda': 'Canal / SDA Numéris',
    'residentiel': 'Ligne résidentielle',
    'internet': 'Accès internet',
    'autre': 'Autre',
}


def remise_kind(name):
    n = name.lower()
    if 'compensation' in n:
        return 'compensation'
    if 'remise' in n:
        return 'marche'
    return 'autre'


# ---------------------------------------------------------------- parseur FACTURE (.F.)

def parse_facture(text):
    inv = {}
    m = re.search(r'n° de facture[?: \t]*\n(\d+)', text)
    inv['numero'] = m.group(1) if m else None
    m = re.search(r'date de facture[?: \t]*\n([\d/]+)', text)
    inv['date'] = m.group(1) if m else None
    m = re.search(r'compte client[?: \t]*\n(\d+)', text)
    inv['compte'] = m.group(1) if m else None
    m = re.search(r'total TTC :\s*\n([\d\s\u00a0\u202f,]+)\s*€', text)
    inv['ttc'] = parse_fr(m.group(1)) if m else None
    m = re.search(r'total HT :\s*\n([\d\s\u00a0\u202f,]+)\s*€', text)
    inv['ht'] = parse_fr(m.group(1)) if m else None
    m = re.search(r'total HT facture précédente :\s*([\d\s\u00a0\u202f,]+)\s*€', text)
    inv['ht_prec'] = parse_fr(m.group(1)) if m else None
    # bloc abonnements / consommations / services ponctuels page 1
    m = re.search(
        r'abonnements et options\s*\n\s*([\d\s\u00a0\u202f,]+)\n(?:dont remises ([\d\s\u00a0\u202f,]+) EUR)?\s*\n'
        r'(?:consommations\s*\n\(hors et au-delà des forfaits\)\s*\n([\d\s\u00a0\u202f,]+)\n(?:dont remises ([\d\s\u00a0\u202f,]+) EUR)?)?'
        r'(?:(forfaits|services ponctuels)\s*\n\s*([\d\s\u00a0\u202f,]+)\n)*',
        text)
    if m:
        inv['abonnements'] = parse_fr(m.group(1))
        inv['remise_abo'] = parse_fr(m.group(2)) if m.group(2) else 0.0
        inv['consommations'] = parse_fr(m.group(3)) if m.group(3) else 0.0
        inv['remise_conso'] = parse_fr(m.group(4)) if m.group(4) else 0.0
    else:
        # cas facture internet : uniquement abonnements
        m2 = re.search(r'abonnements et options\s*\n\s*([\d\s\u00a0\u202f,]+)\n', text)
        inv['abonnements'] = parse_fr(m2.group(1)) if m2 else None
        inv['consommations'] = 0.0
        inv['remise_abo'] = 0.0
        inv['remise_conso'] = 0.0
    # forfaits / services ponctuels (page 1, après consommations)
    inv['forfaits'] = 0.0
    inv['ponctuels'] = 0.0
    for mm in re.finditer(r'\n(forfaits|services ponctuels)\s*\n\s*([\d\s\u00a0\u202f,]+)\n', text[:text.find('Orange SA au capital') if 'Orange SA au capital' in text else 6000]):
        if mm.group(1) == 'forfaits':
            inv['forfaits'] = parse_fr(mm.group(2)) or 0.0
        else:
            inv['ponctuels'] = parse_fr(mm.group(2)) or 0.0
    m = re.search(r'montant TVA à [\d,]+ % sur ([\d\s\u00a0\u202f,]+) EUR = ([\d\s\u00a0\u202f,]+) EUR', text)
    inv['tva'] = parse_fr(m.group(2)) if m else None
    # entité + marché
    m = re.search(r'RESUME FACTURE\n(.{0,200}?)\n\s*\n', text, re.S)
    ent = None
    mb = re.search(r'vos coordonnées\n(.+?)\nExp ?: ?', text, re.S)
    if mb:
        ent = [x.strip() for x in mb.group(1).split('\n') if x.strip()]
    inv['entity'] = ent[0] if ent else None
    mm = re.search(r'\n(MARCHE[^\n]*)', text)
    inv['marche'] = mm.group(1).strip() if mm else None
    # période facturée
    per = re.findall(r'du (\d{2}/\d{2}/\d{4}) au (\d{2}/\d{2}/\d{4})', text)
    inv['periodes'] = [{'du': a, 'au': b} for a, b in per]

    # ---- synthèse des offres et consommations
    offers = []
    conso_cats = []
    if 'synthèse des offres et consommations' in text:
        body = text.split('synthèse des offres et consommations', 1)[1]
        # on découpe : partie offres puis partie consommations
        csplit = re.split(r'\nconsommations\s*\n\(hors et au-delà des forfaits\)', body, 1)
        offers_txt = csplit[0]
        conso_txt = csplit[1] if len(csplit) > 1 else ''
        offers = parse_offers_block(offers_txt)
        conso_cats = parse_conso_synthese(conso_txt)
    inv['offers'] = offers
    inv['conso_cats'] = conso_cats
    return inv


def parse_offers_block(txt):
    """Parse la synthèse des offres : groupes -> produits (avec remises).

    La facture rattache ses remises par la mise en page : chaque remise est
    imprimée sous le produit qu'elle remise, avec la même quantité facturée.

        Canaux contrat Pro Numeris accès de base   3   54,00  20,0  162,00
          remise sur Accès de Base 47%             3                -73,05
          remise sur Accès de Base 5% - compensation augmentation 2024
                                                   3                 -3,75

    On retient donc le dernier produit non-remise rencontré comme base, plutôt
    que de rapprocher les libellés : deux produits distincts (« accès de base »
    et « accès groupé ») portent ici des remises au libellé identique, et aucun
    rapprochement par nom ne peut les séparer.
    """
    lines = [l.rstrip() for l in txt.split('\n')]
    lines = strip_table_headers(lines)
    offers = []
    group = None
    base = None        # dernier produit facturé : porteur des remises qui suivent
    i = 0
    n = len(lines)
    KNOWN_GROUPS = re.compile(
        r'^(Accès au réseau et services optionnels|Services optionnels au téléphone|'
        r'Options tarifaires|Terminaux|Accès aux données de facturation|Service Liaisons Louées|'
        r'Votre accès internet|Vos options internet|Vos options facture|remises|'
        r'Vos services téléphoniques|Autres services|services ponctuels|Achats à l\'acte)$')
    while i < n:
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        if KNOWN_GROUPS.match(s):
            group = s
            base = None          # nouveau bloc : la base ne traverse pas un groupe
            i += 1
            continue
        if s == 'abonnements et options' or re.match(r'^du \d{2}/\d{2}/\d{4} au \d{2}/\d{2}/\d{4}$', s):
            i += 1
            continue
        if re.match(r'^total HT :', s):
            i += 1
            continue
        # nom de produit (accumule jusqu'à trouver la quantité facturée)
        name_lines = [s]
        j = i + 1
        while j < n:
            nx = lines[j].strip()
            if is_int(nx):
                if is_year(nx) and name_lines and ('augmentation' in ' '.join(name_lines).lower() or 'compensation' in ' '.join(name_lines).lower()):
                    name_lines.append(nx)
                    j += 1
                    continue
                break
            # Une quantité au prorata s'écrit « 0,2666 » : sans cette sortie, le
            # libellé avalait les quatre colonnes chiffrées puis le nom du produit
            # suivant (« Livebox Pro Fibre Régularisation 0,2666 50,00 20,0 13,33
            # Régularisation Livebox Pro Fibre »).
            if is_money(nx) and looks_like_qty_row(lines, j):
                break
            if not nx or KNOWN_GROUPS.match(nx) or nx == 'abonnements et options':
                break
            name_lines.append(nx)
            j += 1
        if j >= n or not (is_int(lines[j]) or
                          (is_money(lines[j].strip()) and looks_like_qty_row(lines, j))):
            # cas "services ponctuels" : détail en annexe, montant sans quantité
            if 'Détail disponible dans l\'annexe' in ' '.join(name_lines) and j < n and is_money(lines[j]):
                montant = parse_fr(lines[j])
                name = clean_product_name(' '.join(name_lines))
                offers.append({'group': group, 'name': name, 'qty': None, 'pu': None,
                               'montant': fmt_num(montant), 'isRemise': montant < 0,
                               'kind': remise_kind(name) if montant < 0 else None})
                i = j + 1
                continue
            # pas de qté trouvée -> ligne parasite, on saute
            i += 1
            continue
        qty = int(lines[j].strip()) if is_int(lines[j]) else parse_fr(lines[j].strip())
        j += 1
        # nombres suivants : [PU] [TVA] montant | montant
        nums = []
        while j < n and len(nums) < 4:
            v = lines[j].strip()
            if RE_TVA.match(v):
                j += 1  # taux TVA ignoré
            elif is_money(v):
                nums.append(parse_fr(v))
                j += 1
            elif v == '':
                j += 1
                break
            else:
                break
        pu = None
        montant = None
        if len(nums) >= 3:
            pu, montant = nums[0], nums[-1]
        elif len(nums) == 2:
            pu, montant = nums[0], nums[1]
        elif len(nums) == 1:
            montant = nums[0]
        if montant is None:
            i = j
            continue
        name = ' '.join(name_lines).strip()
        name = clean_product_name(name)
        is_remise = montant < 0 or name.lower().startswith('remise')
        # Une régularisation est une ligne à part entière : quantité négative et
        # PU propre (« Régularisation Ligne Fixe Simple / -1 / 13,19 / 20,0 /
        # -13,19 »). Une remise, elle, reprend la quantité de son porteur. Sans
        # cette distinction, un avoir se rattachait au produit imprimé au-dessus
        # et donnait des taux absurdes (−495 € sur une base de 38 €).
        is_credit = montant < 0 and qty is not None and qty < 0
        offer = {
            'group': group,
            'name': name,
            'qty': qty,
            'pu': pu,
            'montant': fmt_num(montant),
            'isRemise': is_remise,
            'isCredit': is_credit,
            'kind': remise_kind(name) if (montant < 0 or 'remise' in name.lower()) else None,
        }
        if is_remise and not is_credit:
            # la remise hérite du produit imprimé juste au-dessus d'elle
            if base:
                offer['base'] = base['name']
                offer['baseMontant'] = base['montant']
        else:
            base = offer
        offers.append(offer)
        i = j
    return offers


# Intitulés de rubrique du bloc « remises » des consommations : ils annoncent un
# groupe de remises et ne portent jamais de montant.
CONSO_RUBRIC_RE = re.compile(
    r'^remise sur communications voix r[ée]seau g[ée]n[ée]ral$', re.I)


def parse_conso_synthese(txt):
    """Catégories de consommation : nom, nb appels, durée, PU, montant."""
    cats = []
    lines = [l.rstrip() for l in txt.split('\n')]
    lines = strip_table_headers(lines)
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if not s or s in ('consommations', 'remises') or re.match(r'^du \d{2}/\d{2}/\d{4} au \d{2}/\d{2}/\d{4}$', s) or re.match(r'^total HT', s):
            i += 1
            continue
        # En-tête de rubrique dans le bloc des remises de consommation : ce
        # n'est pas un produit, il ne porte aucun montant. Sans cette sortie il
        # se collait au libellé suivant (« remise sur communications voix réseau
        # général remise sur communications fixes métropole 100% »).
        if CONSO_RUBRIC_RE.match(s):
            i += 1
            continue
        # accumulate name until int (nb appels) ou TVA/montant
        name_lines = [s]
        j = i + 1
        while j < n and not is_int(lines[j]) and not is_money(lines[j]):
            nx = lines[j].strip()
            if not nx or nx in ('consommations', 'remises'):
                break
            # une durée et son unité sont des colonnes du tableau, pas du libellé :
            # sans cette sortie, chaque grille tarifaire devenait une catégorie
            # distincte (« Communication à la durée 00:08:57 sec »)
            if parse_dur(nx) is not None or nx in ('sec', 'acte'):
                break
            name_lines.append(nx)
            j += 1
        if j >= n:
            break
        # format: nb \n durée \n unité \n PU \n TVA \n montant
        #     ou: nb \n durée \n TVA \n montant   (compléments)
        #     ou: durée seule \n sec \n PU \n TVA \n montant
        vals = []
        k = j
        while k < n and len(vals) < 6:
            v = lines[k].strip()
            if is_int(v) or is_money(v) or parse_dur(v) is not None or v in ('sec', 'acte'):
                vals.append(v)
                k += 1
            else:
                break
        calls = None
        duration = None
        montant = None
        pu = None
        if vals and is_int(vals[0]):
            calls = int(vals[0])
            rest = vals[1:]
        else:
            rest = vals
        # duration / unité
        idx = 0
        if rest and parse_dur(rest[0]) is not None:
            duration = parse_dur(rest[0])
            idx = 1
        if idx < len(rest) and rest[idx] in ('sec', 'acte'):
            idx += 1
        money = [parse_fr(v) for v in rest[idx:] if is_money(v)]
        if len(money) >= 2:
            pu, montant = money[0], money[-1]
        elif len(money) == 1:
            montant = money[0]
        name = re.sub(r'\s+', ' ', ' '.join(name_lines)).strip()
        # « 07.10.2025 AU 07.11.2025 Achat Abo I+ Tiers » : la période facturée
        # est recollée devant le libellé. La garder éclatait un même service en
        # une vingtaine de catégories d'un euro.
        name = RE_PERIOD_PREFIX.sub('', name)
        name = RE_PERIOD_SLASH_PREFIX.sub('', name)
        if montant is None and calls is None:
            i = max(j, i + 1)
            continue
        # ni appel ni montant : c'est une ligne de grille tarifaire (un prix
        # unitaire seul), pas une consommation facturée
        if not calls and (montant is None or abs(montant) < 0.005):
            i = k
            continue
        if name.lower() in ('remises', 'consommations'):
            i = k
            continue
        if is_layout_noise(name):
            i = k
            continue
        # un n° de compte ou une date lus comme « nb d'appels » : valeur impossible
        if calls is not None and calls > MAX_PLAUSIBLE_CALLS:
            calls = None
        cats.append({'name': name, 'calls': calls, 'duration': duration,
                     'pu': pu, 'montant': fmt_num(montant),
                     'isRemise': montant is not None and montant < 0})
        i = k
    return cats


# ---------------------------------------------------------------- parseur ANNEXE (.A.)

def parse_annexe(text):
    pages = split_pages(text)
    sections = {}   # section -> liste de lignes nettoyées
    order = []
    cur = None
    for num, ptxt in pages:
        lab = section_of_page(ptxt)
        if lab and lab in SECTION_LABELS:
            key = SECTION_LABELS[lab]
            if key not in sections:
                sections[key] = []
                order.append(key)
            cur = key
        if cur is None:
            continue
        sections[cur].extend(clean_page_text(ptxt))

    out = {'sites': {}, 'lines': {}, 'conso_lines': {}, 'services': {}}
    if 'charges' in sections:
        out['sites'] = parse_charges_section(sections['charges'])
    if 'produits' in sections:
        out['detail'] = parse_produits_section(sections['produits'])
    if 'conso' in sections:
        out['conso_lines'] = parse_conso_section(sections['conso'])
    return out


def parse_address_block(lines, i):
    """Depuis i, collecte nom (1ère ligne) + adresse jusqu'au code postal.
    Retourne (name, address, next_index)."""
    buf = []
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if re.match(r'^\d{5}', s):
            i += 1
            # la ville peut être sur la même ligne ou la suivante
            if i < n and not re.match(r'^(abonnements|consommations|total|montants|forfaits)', lines[i].strip()):
                i += 1  # ville
            break
        buf.append(s)
        i += 1
    buf = [b for b in buf if b]
    name = buf[0] if buf else ''
    address = ' '.join(buf[1:]) if len(buf) > 1 else ''
    return name, address, i


def parse_charges_section(lines):
    """synthèse des charges par sous-compte -> {id: {name,address,abo,conso,total}}"""
    sites = {}
    lines = strip_table_headers(lines)
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        m = re.match(r'^(compte|sous-compte) ?: ?(\d+)$', s)
        if not m:
            i += 1
            continue
        sid = m.group(2)
        is_main = m.group(1) == 'compte'
        i += 1
        # "Page N" éventuel
        if i < n and re.match(r'^Page \d+$', lines[i].strip()):
            i += 1
        if i < n and lines[i].strip() == 'montant':
            i += 1
        if i < n and lines[i].strip() == 'EUR HT':
            i += 1
        name, address, i = parse_address_block(lines, i)
        # rubriques présentes
        rubriques = []
        while i < n and lines[i].strip() in (
                'abonnements et options', 'consommations (hors et au-delà des forfaits)',
                'forfaits', 'services ponctuels', 'autres charges', 'remises'):
            rubriques.append(lines[i].strip())
            i += 1
        # totaux
        label = f'total {"compte" if is_main else "sous-compte"} : {sid}'
        vals = []
        if i < n and lines[i].strip() == label:
            i += 1
        while i < n and is_money(lines[i].strip()):
            vals.append(parse_fr(lines[i].strip()))
            i += 1
        abo = vals[0] if len(vals) >= 2 else (vals[0] if vals else 0.0)
        conso = vals[1] if len(vals) >= 3 else 0.0
        total = vals[-1] if vals else 0.0
        sites[sid] = {'name': name, 'address': address, 'abo': abo, 'conso': conso,
                      'total': total, 'isMain': is_main}
    return sites


# --- section détail des produits et services

GROUP_RE = re.compile(
    r'^(Accès au réseau et services optionnels|Services optionnels au téléphone|'
    r'Options tarifaires|Terminaux|Accès aux données de facturation|Service Liaisons Louées|'
    r'Votre accès internet|Vos options internet|Vos options facture|'
    r'Vos services téléphoniques|Autres services|remises)$')

LINE_TYPE_RE = re.compile(r'^(ligne téléphonique|ligne Numéris accès de base|ligne de type résidentiel|accès internet|ligne analogique)$')
DATERANGE_RE = re.compile(r'^du (\d{2}/\d{2}/\d{4}) au (\d{2}/\d{2}/\d{4})$')
NUM_RE = re.compile(r'^n° +([\dA-Z][\dA-Z ]{4,20})$')


def parse_produits_section(lines):
    """détail des produits et services -> sites avec lignes et produits."""
    sites = []
    lines = strip_table_headers(lines)
    i = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        m = re.match(r'^n° (?:de )?(?:sous-?)?compte ?: ?(\d+)$', s)
        if not m:
            i += 1
            continue
        sid = m.group(1)
        i += 1
        # total HT : X €
        if i < n and re.match(r'^total HT ?: ?', lines[i].strip()):
            i += 1
        name, address, i = parse_address_block(lines, i)
        site = {'id': sid, 'name': name, 'address': address, 'lines': []}
        cur_line = None
        group = None
        state = 'abo'   # abo | conso | forfaits
        # sauter "abonnements et options / total HT / €"
        while i < n and not re.match(r'^n° (?:de )?(?:sous-?)?compte', lines[i].strip()):
            t = lines[i].strip()
            if not t or t in ('EUR HT',):
                i += 1
                continue
            if re.match(r'^total HT', t):
                i += 1
                continue
            if t == 'abonnements et options':
                state = 'abo'
                i += 1
                continue
            if t.startswith('consommations') and '(hors' in (t + ' ' + (lines[i+1].strip() if i+1 < n else '')):
                # bloc conso du sous-compte
                state = 'conso'
                i += 1
                continue
            if t == 'forfaits':
                state = 'forfaits'
                i += 1
                continue
            if t == 'information sur vos forfaits':
                i += 1
                continue
            # nouvelle catégorie de produits ?
            if GROUP_RE.match(t):
                group = t
                i += 1
                continue
            # nouvelle ligne ?
            if LINE_TYPE_RE.match(t):
                # attendre " du X au Y" puis "n°  NUMBER"
                label = t
                i += 1
                period = None
                if i < n and DATERANGE_RE.match(lines[i].strip()):
                    period = lines[i].strip()
                    i += 1
                if i < n:
                    mm = NUM_RE.match(lines[i].strip())
                    if mm:
                        number = re.sub(r'\s+', ' ', mm.group(1).strip())
                        i += 1
                        # desc "- Entité" (parfois précédée d'une ligne vide)
                        while i < n and lines[i].strip() == '':
                            i += 1
                        desc = None
                        if i < n and lines[i].strip().startswith('- '):
                            desc = lines[i].strip()[2:]
                            i += 1
                        cur_line = {'number': number, 'label': label, 'period': period,
                                    'desc': desc, 'group': group, 'products': []}
                        site['lines'].append(cur_line)
                        continue
                continue
            # numéro de ligne isolé (canaux SDA / répétition d'en-tête) -> nouvelle ligne
            mm = NUM_RE.match(t)
            if mm and state == 'abo':
                number = re.sub(r'\s+', ' ', mm.group(1).strip())
                i += 1
                # desc "- Entité" (parfois précédée d'une ligne vide)
                while i < n and lines[i].strip() == '':
                    i += 1
                desc = None
                if i < n and lines[i].strip().startswith('- '):
                    desc = lines[i].strip()[2:]
                    i += 1
                cur_line = {'number': number, 'label': None, 'period': None,
                            'desc': desc, 'group': group, 'products': []}
                site['lines'].append(cur_line)
                continue
            # produit
            if state == 'abo':
                prod, ni = try_parse_product(lines, i)
                if prod is not None:
                    if cur_line is None:
                        cur_line = {'number': None, 'label': None, 'period': None,
                                    'desc': None, 'group': group, 'products': []}
                        site['lines'].append(cur_line)
                    prod['group'] = group
                    # L'annexe reprend la mise en page de la synthèse : la remise
                    # est imprimée sous le produit qu'elle remise, ligne par ligne.
                    # C'est ce qui permet de dire quelle ligne précise ne reçoit
                    # pas une remise que ses jumelles obtiennent.
                    attach_remise_base(cur_line['products'], prod)
                    cur_line['products'].append(prod)
                    i = ni
                    continue
            elif state == 'conso':
                cat, ni = try_parse_conso_cat(lines, i)
                if cat is not None:
                    site.setdefault('conso', []).append(cat)
                    i = ni
                    continue
            elif state == 'forfaits':
                fj, ni = try_parse_forfait(lines, i)
                if fj is not None:
                    target = cur_line
                    if target is None:
                        target = site['lines'][-1] if site['lines'] else None
                    if target is not None:
                        target.setdefault('forfaits', []).append(fj)
                    i = ni
                    continue
            i += 1
        # fusion des lignes de même numéro (en-têtes répétés / coupures de page)
        merged = {}
        order_keys = []
        for ln in site['lines']:
            key = norm_number(ln['number']) if ln['number'] else id(ln)
            if key in merged:
                base = merged[key]
                base['products'].extend(ln['products'])
                for f in ln.get('forfaits', []):
                    base.setdefault('forfaits', []).append(f)
                if ln['label'] and not base['label']:
                    base['label'] = ln['label']
                if ln['period'] and not base['period']:
                    base['period'] = ln['period']
            else:
                merged[key] = ln
                order_keys.append(key)
        site['lines'] = [merged[k] for k in order_keys]
        sites.append(site)
    return {'sites': sites}


def try_parse_product(lines, i):
    """Essaye de parser un produit à la ligne i. Retourne (prod, next_i) ou (None, i)."""
    n = len(lines)
    s = lines[i].strip()
    if not s or is_money(s) or is_int(s) or RE_TVA.match(s) or DATERANGE_RE.match(s):
        return None, i
    name_lines = [s]
    j = i + 1
    while j < n:
        nx = lines[j].strip()
        if is_int(nx):
            # année = continuation du nom (remise compensation augmentation XXXX)
            if is_year(nx) and name_lines and ('augmentation' in ' '.join(name_lines).lower() or 'compensation' in ' '.join(name_lines).lower()):
                name_lines.append(nx)
                j += 1
                continue
            break
        if not nx or GROUP_RE.match(nx) or nx == 'abonnements et options' or LINE_TYPE_RE.match(nx) or DATERANGE_RE.match(nx) or NUM_RE.match(nx):
            break
        name_lines.append(nx)
        j += 1
    if j >= n or not is_int(lines[j].strip()):
        return None, i
    qty = int(lines[j].strip())
    j += 1
    nums = []
    while j < n and len(nums) < 4:
        v = lines[j].strip()
        if RE_TVA.match(v):          # taux TVA (1 décimale) — jamais un montant
            j += 1
        elif is_money(v):
            nums.append(parse_fr(v))
            j += 1
        elif v == '':
            j += 1
            break
        else:
            break
    pu = None
    montant = None
    if len(nums) >= 3:
        pu, montant = nums[0], nums[-1]
    elif len(nums) == 2:
        pu, montant = nums[0], nums[1]
    elif len(nums) == 1:
        montant = nums[0]
    if montant is None:
        return None, i
    name = clean_product_name(' '.join(name_lines))
    if not name:
        return None, i
    return {'name': name, 'qty': qty, 'pu': pu, 'montant': fmt_num(montant)}, j


def try_parse_conso_cat(lines, i):
    """Catégorie de conso dans le détail produits : nom, nb, durée, PU, montant."""
    n = len(lines)
    s = lines[i].strip()
    if not s or is_money(s) or is_int(s):
        return None, i
    name_lines = [s]
    j = i + 1
    while j < n and not is_int(lines[j].strip()) and not is_money(lines[j].strip()):
        nx = lines[j].strip()
        if not nx or nx in ('consommations', 'remises') or nx.startswith('total HT'):
            break
        name_lines.append(nx)
        j += 1
    if j >= n:
        return None, i
    vals = []
    k = j
    while k < n and len(vals) < 6:
        v = lines[k].strip()
        if is_int(v) or is_money(v) or parse_dur(v) is not None or v in ('sec', 'acte'):
            vals.append(v)
            k += 1
        else:
            break
    if not vals:
        return None, i
    calls = None
    duration = None
    pu = None
    montant = None
    rest = vals
    if rest and is_int(rest[0]):
        calls = int(rest[0])
        rest = rest[1:]
    idx = 0
    if rest and parse_dur(rest[0]) is not None:
        duration = parse_dur(rest[0])
        idx = 1
    if idx < len(rest) and rest[idx] in ('sec', 'acte'):
        idx += 1
    money = [parse_fr(v) for v in rest[idx:] if is_money(v)]
    if len(money) >= 2:
        pu, montant = money[0], money[-1]
    elif len(money) == 1:
        montant = money[0]
    if montant is None:
        return None, i
    name = re.sub(r'\s+', ' ', ' '.join(name_lines)).strip()
    return {'name': name, 'calls': calls, 'duration': duration, 'pu': pu,
            'montant': fmt_num(montant), 'isRemise': montant < 0}, k


def try_parse_forfait(lines, i):
    """Ligne de forfait : nom, [solde reportable...], nb appels, durée."""
    n = len(lines)
    s = lines[i].strip()
    if not s or is_int(s) or is_money(s) or s.startswith('nombre'):
        return None, i
    m = re.match(r'^n° +([\dA-Z][\dA-Z ]{4,20})$', s)
    if m:
        return None, i
    name_lines = [s]
    j = i + 1
    while j < n and not is_int(lines[j].strip()):
        nx = lines[j].strip()
        if not nx:
            break
        if nx.startswith('solde reportable'):
            name_lines.append(nx)
            j += 1
            continue
        if re.match(r'^\d+:\d{2}:\d{2}$', nx) or is_money(nx):
            break
        name_lines.append(nx)
        j += 1
    if j >= n or not is_int(lines[j].strip()):
        return None, i
    calls = int(lines[j].strip())
    j += 1
    duration = None
    if j < n:
        d = parse_dur(lines[j].strip())
        if d is not None:
            duration = d
            j += 1
    name = re.sub(r'\s+', ' ', ' '.join(name_lines)).strip()
    solde = None
    ms = re.search(r'solde reportable sur la periode suivante ?: ?([\d:]+)', name)
    if ms:
        solde = parse_dur(ms.group(1))
    return {'name': name, 'calls': calls, 'duration': duration, 'solde': solde}, j


# --- section détail des consommations par ligne

CONSO_LINE_RE = re.compile(r'^consommations (ligne [^ n][^\n]*?) n° +([\dA-Z][\dA-Z ]{3,20}) du (\d{2}/\d{2}/\d{4}) au (\d{2}/\d{2}/\d{4})$')
TOTAL_LINE_RE = re.compile(r'^total de la ligne n° +([\dA-Z][\dA-Z ]{3,20})$')
CALL_RE = re.compile(r'^(\d{2}\.\d{2}\.\d{2})$')


def parse_conso_section(lines):
    """-> {number_normalized: {calls, montant, details:[...]}}"""
    out = {}
    lines = strip_table_headers(lines)
    i = 0
    n = len(lines)
    cur = None
    while i < n:
        s = lines[i].strip()
        m = CONSO_LINE_RE.match(s)
        if m:
            cur = {'label': m.group(1).strip(), 'number': re.sub(r'\s+', ' ', m.group(2).strip()),
                   'du': m.group(3), 'au': m.group(4), 'details': [], 'calls': None, 'montant': None}
            out[norm_number(cur['number'])] = cur
            i += 1
            continue
        m = TOTAL_LINE_RE.match(s)
        if m:
            key = norm_number(m.group(2 - 1))
            # nombres suivants : "N appel(s)" puis montant
            j = i + 1
            calls = None
            montant = None
            if j < n:
                mc = re.match(r'^(\d+) appel\(s\)$', lines[j].strip())
                if mc:
                    calls = int(mc.group(1))
                    j += 1
            if j < n and is_money(lines[j].strip()):
                montant = parse_fr(lines[j].strip())
                j += 1
            if key in out:
                out[key]['calls'] = calls
                out[key]['montant'] = fmt_num(montant) if montant is not None else 0.0
            i = j
            continue
        # détail d'appel : dd.mm.yy / hh:mm:ss / numéro / destination / durée / famille / montant
        if CALL_RE.match(s) and cur is not None:
            if i + 6 < n + 1:
                try:
                    heure = lines[i + 1].strip()
                    num = lines[i + 2].strip()
                    dest = lines[i + 3].strip()
                    dur = lines[i + 4].strip()
                    fam = lines[i + 5].strip()
                    mont = lines[i + 6].strip()
                    if (re.match(r'^\d{2}:\d{2}:\d{2}$', heure) and parse_dur(dur) is not None
                            and is_money(mont)):
                        cur['details'].append({
                            'date': s, 'heure': heure, 'numero': num, 'destination': dest,
                            'duree': parse_dur(dur), 'famille': fam, 'montant': parse_fr(mont)})
                        i += 7
                        continue
                except IndexError:
                    pass
        i += 1
    return out


def norm_number(num):
    return re.sub(r'\s+', '', num or '').upper()


# ---------------------------------------------------------------- assemblage dataset

def month_key(date_str):
    """'05/08/2025' -> '2025-08'"""
    if not date_str:
        return None
    d, m, y = date_str.split('/')
    return f'{y}-{m}'


def build_invoice(pdf_f, pdf_a):
    """Assemble une facture complète depuis les fichiers F et A."""
    invF = parse_facture(pdf_text_cached(pdf_f))
    invA = parse_annexe(pdf_text_cached(pdf_a))
    compte = invF['compte']
    mk = month_key(invF['date'])

    # sites
    sites = {}
    charges = invA.get('sites', {})
    detail_sites = invA.get('detail', {}).get('sites', [])
    for st in detail_sites:
        sid = st['id']
        meta = charges.get(sid, {})
        entity = st['name'] or meta.get('name', '')
        raw_addr = st['address'] or meta.get('address', '')
        label, dept, street = split_site_label(raw_addr, fallback=entity)
        sites[sid] = {
            'id': sid,
            'name': label,                     # nom du local, exploitable
            'entity': clean_text(entity),      # raison sociale portée par la facture
            'dept': dept,                      # direction / service de rattachement
            'address': street or clean_text(raw_addr),
            'lines': st['lines'],
            'conso': st.get('conso', []),
        }
    # site principal (compte lui-même) s'il contient des lignes non rattachées
    conso_lines = invA.get('conso_lines', {})

    # enrichissement des lignes
    for sid, st in sites.items():
        for ln in st['lines']:
            num = ln.get('number')
            fam = classify_line(num, ln['label'], ln['products']) if num else 'autre'
            ln['family'] = fam
            ln['familyLabel'] = FAMILY_LABELS[fam]
            brut = sum(p['montant'] for p in ln['products'] if p['montant'] and p['montant'] > 0)
            remise = sum(p['montant'] for p in ln['products'] if p['montant'] and p['montant'] < 0)
            ln['brut'] = fmt_num(brut)
            ln['remise'] = fmt_num(remise)
            ln['net'] = fmt_num(brut + remise)
            if not num:
                ln['consoCalls'] = 0
                ln['consoMontant'] = 0.0
                ln['consoDetails'] = []
                continue
            # SDA rattachés
            sda_qty = sum(p['qty'] for p in ln['products'] if p['name'] == 'Abonnement SDA')
            ln['sdaCount'] = sda_qty if sda_qty else None
            # conso
            key = norm_number(num)
            cl = conso_lines.get(key)
            if cl:
                ln['consoCalls'] = cl['calls']
                ln['consoMontant'] = cl['montant']
                ln['consoDetails'] = cl['details']
            else:
                ln['consoCalls'] = 0
                ln['consoMontant'] = 0.0
                ln['consoDetails'] = []

    inv = {
        'compte': compte,
        'numero': invF['numero'],
        'date': invF['date'],
        'month': mk,
        'marche': invF['marche'],
        'entity': invF['entity'],
        'totals': {
            'ttc': invF['ttc'], 'ht': invF['ht'], 'tva': invF['tva'],
            'abonnements': invF['abonnements'], 'consommations': invF['consommations'],
            'forfaits': invF.get('forfaits', 0.0), 'ponctuels': invF.get('ponctuels', 0.0),
            'remiseAbo': invF.get('remise_abo'), 'remiseConso': invF.get('remise_conso'),
        },
        'offers': invF['offers'],
        'consoCats': invF['conso_cats'],
        'sites': sites,
        'files': {'f': os.path.basename(pdf_f), 'a': os.path.basename(pdf_a)},
    }
    return inv


def summarize_dataset(invoices):
    """Agrège les factures en dataset compact pour le frontend."""
    months = sorted({inv['month'] for inv in invoices if inv['month']})
    # ---- par mois / compte
    monthly = {}
    for mk in months:
        monthly[mk] = {'accounts': {}, 'products': [], 'consoCats': [], 'remises': []}
    for inv in invoices:
        mk = inv['month']
        acc = inv['compte']
        m = monthly[mk]['accounts'].setdefault(acc, {
            'ht': 0, 'ttc': 0, 'abo': 0, 'conso': 0, 'remiseAbo': 0, 'remiseConso': 0,
            'invoice': inv['numero'], 'marche': inv['marche'], 'date': inv['date'],
        })
        t = inv['totals']
        m['ht'] += t['ht'] or 0
        m['ttc'] += t['ttc'] or 0
        m['abo'] += t['abonnements'] or 0
        m['conso'] += t['consommations'] or 0
        m['remiseAbo'] += t['remiseAbo'] or 0
        m['remiseConso'] += t['remiseConso'] or 0
        for o in inv['offers']:
            monthly[mk]['products'].append({
                'group': o['group'], 'name': o['name'], 'qty': o['qty'],
                'pu': o['pu'], 'montant': o['montant'], 'isRemise': o['isRemise'],
                'kind': o.get('kind'), 'isCredit': o.get('isCredit'),
                # produit remisé, tel que la facture le rattache par sa mise en page
                'base': o.get('base'), 'baseMontant': o.get('baseMontant'),
                # facture d'origine : une réclamation se cite, elle ne se résume pas
                'compte': inv['compte'], 'facture': inv['numero']})
        for c in inv['consoCats']:
            # le compte permet au front de restreindre le détail au compte
            # sélectionné, comme le font déjà les totaux
            monthly[mk]['consoCats'].append(dict(c, compte=inv['compte']))

    # ---- registre lignes
    line_reg = {}
    site_reg = {}
    for inv in invoices:
        mk = inv['month']
        for sid, st in inv['sites'].items():
            sr = site_reg.setdefault(sid, {
                'id': sid, 'name': st['name'], 'address': st['address'],
                'entity': st.get('entity', ''), 'dept': st.get('dept', ''),
                'account': inv['compte'], 'months': {}, 'lineCount': set(),
                'first': mk, 'last': mk})
            if mk < sr['first']:
                sr['first'] = mk
            if mk > sr['last']:
                sr['last'] = mk
            site_abo = 0.0
            site_conso = 0.0
            for ln in st['lines']:
                # produits avec ou sans numéro de ligne (niveau site)
                site_abo += ln.get('net') or 0
                if not ln.get('number'):
                    continue
                key = norm_number(ln['number'])
                lr = line_reg.get(key)
                if lr is None:
                    lr = line_reg[key] = {
                        'number': ln['number'], 'key': key,
                        'family': ln['family'], 'familyLabel': ln['familyLabel'],
                        'label': clean_text(ln['label']) or None, 'account': inv['compte'],
                        'siteId': sid, 'siteName': st['name'],
                        'siteDept': st.get('dept', ''), 'siteAddress': st['address'],
                        'months': {}, 'first': mk, 'last': mk,
                        'products': {}, 'sdaCount': ln.get('sdaCount'),
                    }
                if mk < lr['first']:
                    lr['first'] = mk
                if mk > lr['last']:
                    lr['last'] = mk
                prev = lr['months'].get(mk)
                entry = {
                    'brut': (prev['brut'] if prev else 0) + (ln.get('brut') or 0),
                    'remise': (prev['remise'] if prev else 0) + (ln.get('remise') or 0),
                    'net': (prev['net'] if prev else 0) + (ln.get('net') or 0),
                    'calls': (prev['calls'] if prev else 0) + (ln.get('consoCalls') or 0),
                    'conso': (prev['conso'] if prev else 0) + (ln.get('consoMontant') or 0),
                }
                lr['months'][mk] = entry
                for p in ln['products']:
                    pn = p['name']
                    agg = lr['products'].setdefault(pn, {
                        'name': pn, 'group': p.get('group'), 'total': 0, 'months': 0,
                        'base': p.get('base'), 'isCredit': p.get('isCredit') or False,
                        'baseTotal': 0})
                    agg['total'] += p['montant'] or 0
                    agg['months'] += 1
                    # brut de l'offre remisée, cumulé sur les mêmes mois que la
                    # remise : c'est le dénominateur du taux réellement obtenu
                    if p.get('baseMontant'):
                        agg['baseTotal'] += p['baseMontant']
                    if agg.get('base') is None and p.get('base'):
                        agg['base'] = p['base']
                site_conso += ln.get('consoMontant') or 0
            # conso site (bloc conso du sous-compte, hors lignes)
            sr['months'][mk] = {'abo': fmt_num(site_abo), 'conso': fmt_num(site_conso)}
            sr['lineCount'].add(mk)

    # recompte lignes par site
    lines_by_site = {}
    for lr in line_reg.values():
        lines_by_site.setdefault(lr['siteId'], []).append(lr)
    for sid, sr in site_reg.items():
        lns = lines_by_site.get(sid, [])
        sr['lineCount'] = len(lns)
        fams = {}
        for l in lns:
            fams[l['family']] = fams.get(l['family'], 0) + 1
        sr['families'] = fams

    # ---- rattachements
    def num_prefix(n):
        return ''.join(re.findall(r'\d+', n)[:3])

    numeris = [l for l in line_reg.values() if l['family'] == 'numeris']
    # canaux SDA -> accès de base : même site en priorité, sinon même préfixe sur le compte
    for lr in line_reg.values():
        if lr['family'] != 'canal_sda':
            continue
        pref = num_prefix(lr['number'])
        same_site = [c for c in numeris if c['siteId'] == lr['siteId']]
        pick = (next((c for c in same_site if num_prefix(c['number']) == pref), None)
                or (same_site[0] if len(same_site) == 1 else None)
                or next((c for c in numeris if c['account'] == lr['account']
                         and num_prefix(c['number']) == pref), None))
        if pick:
            lr['attachedTo'] = pick['number']
            lr['attachedKind'] = ('numeris' if pick['siteId'] == lr['siteId']
                                  else 'numeris_autre_site')
            pick.setdefault('channels', []).append(lr['number'])

    # Un lieu physique porte souvent plusieurs sous-comptes : on les regroupe par
    # adresse pour rattacher les lignes voix à l'accès internet du même bâtiment.
    place_of_site = {}
    for sid, sr in site_reg.items():
        pk = street_key(sr['address'])
        sr['placeKey'] = pk
        place_of_site[sid] = pk
    for l in line_reg.values():
        l['placeKey'] = place_of_site.get(l['siteId'], '')

    net_by_place = {}
    for l in line_reg.values():
        if l['family'] == 'internet' and l['placeKey']:
            net_by_place.setdefault(l['placeKey'], l)
    for lr in line_reg.values():
        net = net_by_place.get(lr['placeKey'])
        if net and net['key'] != lr['key'] and lr['family'] != 'internet':
            lr['siteInternet'] = net['number']
            lr['siteInternetSameAccount'] = net['siteId'] == lr['siteId']
            net.setdefault('sharedWith', []).append(lr['number'])

    # technologie d'accès (uniquement porteuse de sens pour les accès internet)
    for lr in line_reg.values():
        if lr['family'] == 'internet':
            tech, copper = detect_access_tech(lr['products'].values())
            lr['accessTech'] = tech
            lr['onCopper'] = copper
        else:
            lr['accessTech'] = None
            lr['onCopper'] = True     # T0, Numéris, SDA : cuivre par construction

    # totaux par ligne
    for lr in line_reg.values():
        tot_abo = sum(v['net'] for v in lr['months'].values())
        tot_conso = sum(v['conso'] for v in lr['months'].values())
        tot_calls = sum(v['calls'] for v in lr['months'].values())
        active_months = len(lr['months'])
        lr['totals'] = {'abo': fmt_num(tot_abo), 'conso': fmt_num(tot_conso),
                        'calls': tot_calls, 'avgAbo': fmt_num(tot_abo / active_months if active_months else 0),
                        'avgConso': fmt_num(tot_conso / active_months if active_months else 0)}
        lr['products'] = sorted(lr['products'].values(), key=lambda p: -abs(p['total']))
        lr['monthsNoConso'] = sum(1 for v in lr['months'].values() if (v['calls'] or 0) == 0)

    # comptes / marchés
    accounts = {}
    for inv in invoices:
        a = accounts.setdefault(inv['compte'], {'id': inv['compte'], 'marches': [], 'entity': inv['entity']})
        if inv['marche']:
            found = None
            for mmr in a['marches']:
                if mmr['label'] == inv['marche']:
                    found = mmr
            if not found:
                a['marches'].append({'label': inv['marche'], 'from': inv['month'], 'to': inv['month']})
            else:
                if inv['month'] < found['from']:
                    found['from'] = inv['month']
                if inv['month'] > found['to']:
                    found['to'] = inv['month']

    invoices_list = [{
        'compte': inv['compte'], 'numero': inv['numero'], 'date': inv['date'],
        'month': inv['month'], 'marche': inv['marche'],
        'totals': inv['totals'], 'files': inv['files'],
    } for inv in invoices]

    # lignes sans conso (mois le plus récent)
    last_month = months[-1] if months else None
    lines_no_conso = []
    if last_month:
        for lr in line_reg.values():
            v = lr['months'].get(last_month)
            if v is not None and (v['calls'] or 0) == 0:
                lines_no_conso.append({'key': lr['key'], 'net': v['net']})

    return {
        'meta': {
            'generatedAt': datetime.datetime.now().isoformat(timespec='seconds'),
            'months': months,
            'counts': {'invoices': len(invoices), 'lines': len(line_reg), 'sites': len(site_reg)},
        },
        'accounts': list(accounts.values()),
        'months': months,
        'monthly': monthly,
        'lines': list(line_reg.values()),
        'sites': list(site_reg.values()),
        'invoices': invoices_list,
        'lastMonth': last_month,
    }


def build_all(factures_dir='factures', out_path='data/dataset.json'):
    files = sorted(glob.glob(os.path.join(factures_dir, '*.pdf')))
    pairs = {}
    errors = []
    for f in files:
        base = os.path.basename(f)
        parts = base.split('.')
        # nom attendu : compte.numero.[AF].date.id.pdf — sinon on ne sait pas
        # à quelle facture rattacher le fichier ; le signaler vaut mieux que
        # laisser l'utilisateur chercher pourquoi son PDF n'apparaît pas.
        if len(parts) >= 5 and parts[2] in ('A', 'F'):
            compte, numero, typ = parts[0], parts[1], parts[2]
            pairs.setdefault((compte, numero), {})[typ] = f
        else:
            errors.append({'file': base, 'compte': '', 'numero': '',
                           'error': 'nom de fichier non reconnu — attendu '
                                    'compte.numero.A|F.date.id.pdf'})
    invoices = []
    for (compte, numero), d in sorted(pairs.items()):
        if 'F' in d and 'A' in d:
            try:
                invoices.append(build_invoice(d['F'], d['A']))
            except Exception as e:
                errors.append({'compte': compte, 'numero': numero, 'error': str(e)})
        else:
            errors.append({'compte': compte, 'numero': numero,
                           'error': f"paire incomplète: {sorted(d.keys())}"})
    invoices.sort(key=lambda i: (i['month'] or '', i['compte']))
    dataset = summarize_dataset(invoices)
    dataset['errors'] = errors
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump(dataset, fh, ensure_ascii=False)
    return dataset, invoices


# ---------------------------------------------------------------- validation

def validate(dataset, invoices):
    report = []
    for inv in invoices:
        t = inv['totals']
        # somme lignes (abo net) vs total abonnements
        sum_lines = 0.0
        sum_conso = 0.0
        n_lines = 0
        for sid, st in inv['sites'].items():
            for ln in st['lines']:
                sum_lines += ln.get('net') or 0
                sum_conso += ln.get('consoMontant') or 0
                if ln.get('number'):
                    n_lines += 1
        abo_target = (t['abonnements'] or 0) + (t.get('forfaits') or 0) + (t.get('ponctuels') or 0)
        # les montants de conso détaillés sont HORS remise ; la facture est nette
        conso_target = (t['consommations'] or 0) + (t['remiseConso'] or 0)
        rep = {
            'month': inv['month'], 'compte': inv['compte'], 'lines': n_lines,
            'abo_calc': round(sum_lines, 2), 'abo_fact': round(abo_target, 2),
            'abo_ecart': round(sum_lines - abo_target, 2),
            'conso_calc': round(sum_conso, 2), 'conso_fact': round(conso_target, 2),
            'conso_ecart': round(sum_conso - conso_target, 2),
        }
        report.append(rep)
    return report


if __name__ == '__main__':
    ds, invs = build_all()
    print(json.dumps(ds['meta'], ensure_ascii=False, indent=1))
    print('errors:', len(ds['errors']))
    for e in ds['errors'][:10]:
        print(' ', e)
    rep = validate(ds, invs)
    print(f"\n{'month':8} {'compte':10} {'lignes':>6} {'abo_calc':>9} {'abo_fact':>9} {'écart':>7} {'conso_calc':>10} {'conso_fact':>10} {'écart':>7}")
    for r in rep:
        flag = ' ⚠' if abs(r['abo_ecart']) > 0.05 or abs(r['conso_ecart']) > 0.05 else ''
        print(f"{r['month']:8} {r['compte']:10} {r['lines']:>6} {r['abo_calc']:>9} {r['abo_fact']:>9} {r['abo_ecart']:>7} {r['conso_calc']:>10} {r['conso_fact']:>10} {r['conso_ecart']:>7}{flag}")
