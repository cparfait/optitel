# -*- coding: utf-8 -*-
"""
OptiTel — Serveur d'analyse de factures télécoms (Orange Business).
Sert l'interface web + API (dataset, import de factures PDF, export CSV).
"""
import os
import io
import csv
import json
import glob
import gzip
import re
import decimal
import secrets
import threading
import datetime

from flask import (Flask, request, jsonify, send_from_directory, Response,
                   session, redirect, url_for, render_template_string)

import auth
import parser_invoice

BASE = os.path.dirname(os.path.abspath(__file__))

# Emplacements surchargeables : en conteneur, les PDF déposés et le suivi de
# migration doivent vivre sur un volume, pas dans la couche image qui disparaît
# à chaque redéploiement.
FACTURES_DIR = os.environ.get('OPTITEL_FACTURES_DIR') or os.path.join(BASE, 'factures')
DATA_DIR = os.environ.get('OPTITEL_DATA_DIR') or os.path.join(BASE, 'data')
DATA_PATH = os.path.join(DATA_DIR, 'dataset.json')
MIGRATION_PATH = os.path.join(DATA_DIR, 'migration.json')
WEB_DIR = os.path.join(BASE, 'web')

app = Flask(__name__, static_folder=None)
_lock = threading.Lock()


# ---------------------------------------------------------------- authentification
def _secret_key():
    """Clé de signature des sessions, stable d'un redémarrage à l'autre.

    Une clé tirée au hasard à chaque démarrage déconnecterait tout le monde à
    chaque redéploiement. On la prend dans l'environnement si elle est fournie,
    sinon on la persiste sur le volume de données.
    """
    env = os.environ.get('OPTITEL_SECRET_KEY')
    if env:
        return env.encode('utf-8')
    path = os.path.join(DATA_DIR, '.secret_key')
    try:
        with open(path, 'rb') as f:
            k = f.read().strip()
            if k:
                return k
    except OSError:
        pass
    k = secrets.token_hex(32).encode('ascii')
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(k)
    except OSError:
        print('Clé de session non persistée : les sessions seront perdues au '
              'redémarrage. Définir OPTITEL_SECRET_KEY.', flush=True)
    return k


app.secret_key = _secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    # À activer derrière HTTPS (OPTITEL_SECURE_COOKIE=1) : le cookie n'est alors
    # jamais transmis en clair. Désactivé par défaut, sinon la connexion est
    # impossible sur un accès local en http.
    SESSION_COOKIE_SECURE=os.environ.get('OPTITEL_SECURE_COOKIE') == '1',
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(
        hours=int(os.environ.get('OPTITEL_SESSION_HOURS', '12'))),
    MAX_CONTENT_LENGTH=int(os.environ.get('OPTITEL_MAX_UPLOAD_MB', '200')) * 1024 * 1024,
)

# Routes accessibles sans être connecté : la page de connexion et ses envois,
# plus la sonde de santé dont l'orchestrateur a besoin avant toute session.
PUBLIC_ENDPOINTS = {'login', 'logout', 'health'}


def current_user():
    return session.get('user')


@app.before_request
def require_login():
    if request.endpoint in PUBLIC_ENDPOINTS or request.method == 'OPTIONS':
        return None
    if current_user():
        return None
    # Le front interroge l'API en fetch : lui renvoyer la page de connexion en
    # 200 lui ferait afficher du HTML à la place des données. On répond 401 et
    # il redirige lui-même.
    if request.path.startswith('/api/'):
        return jsonify({'ok': False, 'error': 'authentification requise'}), 401
    return redirect(url_for('login', next=request.full_path
                            if request.query_string else request.path))


def dataset_exists():
    return os.path.exists(DATA_PATH)


def rebuild():
    """Reconstruit le dataset depuis le dossier factures/."""
    with _lock:
        ds, _invs = parser_invoice.build_all(FACTURES_DIR, DATA_PATH)
        return ds


LOGIN_HTML = """<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OptiTel — Connexion</title>
<style>
 /* Styles en ligne : la feuille de l'application est derrière
    l'authentification, la page de connexion ne doit dépendre de rien. */
 body{display:flex;align-items:center;justify-content:center;min-height:100vh;
      background:#f5f6f8;margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#151922}
 .lg{width:100%;max-width:370px;padding:28px 30px;background:#fff;border:1px solid #e6e8ee;
     border-radius:14px;box-shadow:0 8px 30px rgba(16,20,32,.08)}
 .lg h1{font-size:19px;margin:14px 0 4px;letter-spacing:-.02em}
 .lg p.sub{margin:0 0 20px;color:#6b7280;font-size:12.5px}
 .lg label{display:block;font-size:11px;font-weight:600;text-transform:uppercase;
           letter-spacing:.06em;color:#6b7280;margin-bottom:5px}
 .lg input{width:100%;box-sizing:border-box;height:38px;padding:0 11px;font:inherit;font-size:14px;
           border:1px solid #d8dbe4;border-radius:8px;margin-bottom:14px}
 .lg input:focus{outline:none;border-color:#f2611b;box-shadow:0 0 0 3px rgba(242,97,27,.13)}
 .lg button{width:100%;height:40px;border:0;border-radius:8px;background:#f2611b;color:#fff;
            font:inherit;font-size:14px;font-weight:600;cursor:pointer}
 .lg button:hover{background:#e05a1a}
 .err{background:#fdeceb;color:#8a2c15;border:1px solid #f5c4b8;border-radius:8px;
      padding:9px 11px;font-size:12.5px;margin-bottom:14px}
 .warn{background:#fff6e6;color:#8a5a06;border:1px solid #f3ddb0;border-radius:8px;
       padding:9px 11px;font-size:12px;margin-top:16px;line-height:1.45}
 .mark{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#ff8a3d,#f2611b);
       display:flex;align-items:center;justify-content:center}
</style></head>
<body><form class="lg" method="post" autocomplete="on">
  <div class="mark"><svg viewBox="0 0 32 32" width="22" height="22"><path d="M10 17.5c2.8 2.6 6 4.4 9.7 5.2l1.8-2.9c.4-.6 1.1-.8 1.7-.5l3.9 1.9c.7.3 1 1.1.7 1.8l-1 2.4c-.5 1.2-1.7 1.9-3 1.7C15.3 25.7 7.4 20.6 4 11.9c-.4-1.2.1-2.5 1.2-3.1l2.3-1.2c.7-.4 1.5-.1 1.8.6l1.9 3.9c.3.6.1 1.3-.5 1.7l-2.9 1.8z" fill="#fff"/></svg></div>
  <h1>OptiTel</h1>
  <p class="sub">Analyse des factures télécoms — Commune de Châtillon</p>
  {% if error %}<div class="err">{{ error }}</div>{% endif %}
  <label for="u">Identifiant</label>
  <input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Mot de passe</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Se connecter</button>
  {% if default_creds %}<div class="warn"><b>Compte par défaut actif</b> — identifiant
   <code>test</code>, mot de passe <code>test</code>. À remplacer avant tout usage réel
   (voir DEPLOIEMENT.md).</div>{% endif %}
</form></body></html>"""


def _safe_next(target):
    """N'accepte qu'un chemin interne : une URL absolue permettrait de rebondir
    vers un site tiers depuis notre page de connexion."""
    if not target or not target.startswith('/') or target.startswith('//'):
        return '/'
    return target


@app.route('/login', methods=['GET', 'POST'])
def login():
    nxt = _safe_next(request.args.get('next') or request.form.get('next'))
    if current_user():
        return redirect(nxt)
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '')
        password = request.form.get('password', '')
        key = f"{request.remote_addr}|{username.lower()}"
        wait = auth.throttled(key)
        if wait:
            error = f'Trop de tentatives. Réessayez dans {wait} secondes.'
        else:
            user = auth.authenticate(username, password)
            if user:
                auth.reset(key)
                session.clear()
                session['user'] = user
                session.permanent = True
                return redirect(nxt)
            auth.record_failure(key)
            error = 'Identifiant ou mot de passe incorrect.'
    resp = Response(render_template_string(
        LOGIN_HTML, error=error,
        default_creds=auth.using_default_credentials()))
    resp.headers['Content-Type'] = 'text/html; charset=utf-8'
    return resp


@app.route('/logout', methods=['GET', 'POST'])
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.get('/api/me')
def api_me():
    u = current_user() or {}
    return jsonify({'ok': True, 'user': u.get('display'), 'roles': u.get('roles', []),
                    'defaultCredentials': auth.using_default_credentials()})


@app.get('/')
def index():
    return send_from_directory(WEB_DIR, 'index.html')


@app.get('/factures/<path:name>')
def facture_pdf(name):
    """Sert un PDF de facture pour consultation depuis l'historique.

    Le nom vient du dataset, mais on le réduit quand même à son basename : un
    nom de fichier n'est pas un chemin, et le dataset est reconstruit à partir
    de ce que l'utilisateur dépose.
    """
    base = os.path.basename(name)
    if not base.lower().endswith('.pdf'):
        return Response('Not found', status=404)
    if not os.path.exists(os.path.join(FACTURES_DIR, base)):
        return Response('Facture introuvable', status=404)
    return send_from_directory(FACTURES_DIR, base, mimetype='application/pdf')


@app.get('/<path:path>')
def static_files(path):
    full = os.path.normpath(os.path.join(WEB_DIR, path))
    if not full.startswith(WEB_DIR):
        return Response('Not found', status=404)
    return send_from_directory(WEB_DIR, path)


@app.after_request
def no_cache(resp):
    """Le front est servi tel quel depuis le disque : pas de cache navigateur."""
    resp.headers['Cache-Control'] = 'no-store, must-revalidate'
    return resp


# Le dataset dépasse 850 Ko de JSON très répétitif : il se comprime d'un facteur
# ~10, ce qui change nettement le temps de premier affichage.
COMPRESSIBLE = ('application/json', 'text/css', 'text/html',
                'application/javascript', 'text/javascript', 'text/csv')


@app.after_request
def compress(resp):
    if (resp.direct_passthrough
            or resp.status_code < 200 or resp.status_code >= 300
            or 'gzip' not in (request.headers.get('Accept-Encoding') or '')
            or resp.headers.get('Content-Encoding')):
        return resp
    if not (resp.mimetype or '').startswith(COMPRESSIBLE):
        return resp
    data = resp.get_data()
    if len(data) < 1024:          # sous cette taille, l'en-tête coûte plus que le gain
        return resp
    resp.set_data(gzip.compress(data, 6))
    resp.headers['Content-Encoding'] = 'gzip'
    resp.headers['Content-Length'] = resp.content_length
    resp.headers.add('Vary', 'Accept-Encoding')
    return resp


@app.get('/api/data')
def api_data():
    if not dataset_exists():
        rebuild()
    with open(DATA_PATH, encoding='utf-8') as f:
        return Response(f.read(), mimetype='application/json')


@app.post('/api/rescan')
def api_rescan():
    ds = rebuild()
    return jsonify({
        'ok': True,
        'meta': ds['meta'],
        'errors': ds.get('errors', []),
    })


@app.post('/api/import')
def api_import():
    """Importe des PDF de factures (multipart: fichiers 'files')."""
    files = request.files.getlist('files')
    if not files:
        return jsonify({'ok': False, 'error': 'Aucun fichier reçu'}), 400
    os.makedirs(FACTURES_DIR, exist_ok=True)
    saved, ignored = [], []
    for f in files:
        name = f.filename
        base = os.path.basename(name)
        if not base.lower().endswith('.pdf'):
            ignored.append({'name': base, 'reason': 'pas un PDF'})
            continue
        dest = os.path.join(FACTURES_DIR, base)
        if os.path.exists(dest):
            # même nom -> remplace (permet re-import d'un fichier corrigé)
            pass
        f.save(dest)
        saved.append(base)
    if not saved:
        return jsonify({'ok': False, 'saved': [], 'ignored': ignored}), 400

    before = 0
    if dataset_exists():
        try:
            with open(DATA_PATH, encoding='utf-8') as fh:
                before = json.load(fh)['meta']['counts']['invoices']
        except (ValueError, OSError, KeyError):
            before = 0
    ds = rebuild()
    added = ds['meta']['counts']['invoices'] - before
    # un PDF enregistré n'est pas forcément exploité : il peut attendre son
    # jumeau (annexe ou facture) ou porter un nom hors convention
    rejected = [e for e in ds.get('errors', []) if e.get('file') in saved]
    return jsonify({
        'ok': True,
        'saved': saved,
        'ignored': ignored,
        'added': added,
        'rejected': rejected,
        'meta': ds['meta'],
        'errors': ds.get('errors', []),
    })


# ---------------------------------------------------------------- suivi migration
# Le suivi de la fin du cuivre est saisi par l'utilisateur : il vit à côté du
# dataset, qui lui est reconstruit à chaque import et écraserait ces données.

MIGRATION_STATES = ('todo', 'study', 'ordered', 'migrated', 'kept')


def load_migration():
    """-> {'sites': {...}, 'lines': {...}, 'siteNames': {...}}

    Le fichier ne portait à l'origine que `sites`. Les clés absentes sont
    complétées à la lecture : un fichier écrit par une version précédente reste
    exploitable sans migration de données.
    """
    empty = {'sites': {}, 'lines': {}, 'siteNames': {}}
    if not os.path.exists(MIGRATION_PATH):
        return empty
    try:
        with open(MIGRATION_PATH, encoding='utf-8') as f:
            raw = json.load(f)
    except (ValueError, OSError):
        return empty
    if not isinstance(raw, dict):
        return empty
    return {k: (raw.get(k) if isinstance(raw.get(k), dict) else {}) for k in empty}


def save_migration(store):
    os.makedirs(os.path.dirname(MIGRATION_PATH), exist_ok=True)
    tmp = MIGRATION_PATH + '.tmp'
    payload = {'updatedAt': datetime.datetime.now().isoformat(timespec='seconds')}
    payload.update(store)
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, MIGRATION_PATH)   # écriture atomique : pas de fichier tronqué


def _read_body():
    """Corps JSON de la requête, ou (None, réponse d'erreur).

    Un corps illisible ne doit jamais être interprété comme « remettre à zéro » :
    on refuse explicitement plutôt que d'effacer une saisie par accident.
    """
    try:
        body = json.loads(request.get_data().decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return None, (jsonify({'ok': False,
                               'error': 'corps JSON invalide (attendu : UTF-8)'}), 400)
    if not isinstance(body, dict):
        return None, (jsonify({'ok': False, 'error': 'corps JSON invalide'}), 400)
    return body, None


def _entry(body):
    return {
        'state': body.get('state', 'todo'),
        'ref': (body.get('ref') or '').strip()[:80],
        'note': (body.get('note') or '').strip()[:500],
        'date': (body.get('date') or '').strip()[:10],
        'updatedAt': datetime.datetime.now().isoformat(timespec='seconds'),
    }


def _set_tracked(bucket, key, body):
    """Écrit une saisie de suivi dans `bucket` ('sites' ou 'lines')."""
    state = body.get('state', 'todo')
    if state not in MIGRATION_STATES:
        return jsonify({'ok': False, 'error': f'état inconnu : {state}'}), 400
    with _lock:
        store = load_migration()
        if state == 'todo' and not (body.get('ref') or body.get('note')):
            store[bucket].pop(key, None)      # retour à l'état par défaut : on oublie
        else:
            store[bucket][key] = _entry(body)
        save_migration(store)
    return jsonify({'ok': True, **store})


@app.get('/api/migration')
def api_migration_get():
    return jsonify({'ok': True, **load_migration()})


@app.post('/api/migration/line/<path:line_key>')
def api_migration_line_set(line_key):
    """Suivi d'une ligne. Une migration se commande ligne par ligne : sur un site
    mixte, le T0 bascule en VoIP quand l'ascenseur attend son ascensoriste."""
    body, err = _read_body()
    if err:
        return err
    return _set_tracked('lines', line_key, body)


@app.delete('/api/migration/line/<path:line_key>')
def api_migration_line_del(line_key):
    with _lock:
        store = load_migration()
        store['lines'].pop(line_key, None)
        save_migration(store)
    return jsonify({'ok': True, **store})


@app.post('/api/migration/<site_id>')
def api_migration_set(site_id):
    body, err = _read_body()
    if err:
        return err
    return _set_tracked('sites', site_id, body)


@app.delete('/api/migration/<site_id>')
def api_migration_del(site_id):
    with _lock:
        store = load_migration()
        store['sites'].pop(site_id, None)
        save_migration(store)
    return jsonify({'ok': True, **store})


# ------------------------------------------------------------ renommage de site
@app.post('/api/site-name/<site_id>')
def api_site_name(site_id):
    """Nom d'usage d'un site, quand celui de la facture ne permet pas de le
    reconnaître. Le nom facturé n'est jamais écrasé : il reste dans le dataset
    et l'interface l'affiche à côté, pour que le rapprochement avec le PDF
    reste possible."""
    body, err = _read_body()
    if err:
        return err
    name = (body.get('name') or '').strip()[:80]
    with _lock:
        store = load_migration()
        if name:
            store['siteNames'][site_id] = {
                'name': name,
                'updatedAt': datetime.datetime.now().isoformat(timespec='seconds'),
            }
        else:
            store['siteNames'].pop(site_id, None)   # vider = revenir au nom facturé
        save_migration(store)
    return jsonify({'ok': True, **store})


def _csv(rows, filename):
    """rows: liste de dicts -> réponse CSV (séparateur ;, encodage Excel FR)."""
    if not rows:
        rows = [{}]
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=list(rows[0].keys()), delimiter=';', extrasaction='ignore')
    w.writeheader()
    for r in rows:
        w.writerow(r)
    data = out.getvalue().encode('utf-8-sig')
    # `mimetype` doit rester un type nu : Flask y ajoute lui-même le charset, et
    # le passer ici produisait « text/csv; charset=utf-8; charset=utf-8 ».
    return Response(
        data,
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'})


@app.get('/api/export/lines')
def export_lines():
    if not dataset_exists():
        rebuild()
    ds = json.load(open(DATA_PATH, encoding='utf-8'))
    rows = []
    for l in ds['lines']:
        r = {
            'numero': l['number'],
            'type': l['familyLabel'],
            'compte': l['account'],
            'sous_compte': l['siteId'],
            'site': l['siteName'],
            'direction': l.get('siteDept', ''),
            'adresse': l.get('siteAddress', ''),
            'premiere_facture': l['first'],
            'derniere_facture': l['last'],
            'mois_actifs': len(l['months']),
            'abo_net_total_eur': l['totals']['abo'],
            'conso_total_eur': l['totals']['conso'],
            'appels_total': l['totals']['calls'],
            'abo_moyen_eur': l['totals']['avgAbo'],
            'conso_moyenne_eur': l['totals']['avgConso'],
            'mois_sans_conso': l.get('monthsNoConso', 0),
            'rattachee_a': l.get('attachedTo', ''),
            'canaux_sda_rattaches': len(l.get('channels') or []) or '',
            'acces_internet_du_site': l.get('siteInternet', ''),
            'lignes_partageant_l_acces': len(l.get('sharedWith') or []) or '',
            'sda_declares': l.get('sdaCount') or '',
        }
        rows.append(r)
    return _csv(rows, 'lignes_telecom.csv')


@app.get('/api/export/sites')
def export_sites():
    if not dataset_exists():
        rebuild()
    ds = json.load(open(DATA_PATH, encoding='utf-8'))
    rows = []
    for s in ds['sites']:
        tot_abo = sum(v['abo'] for v in s['months'].values())
        tot_conso = sum(v['conso'] for v in s['months'].values())
        rows.append({
            'sous_compte': s['id'],
            'site': s['name'],
            'direction': s.get('dept', ''),
            'adresse': s['address'],
            'batiment': s.get('placeKey', ''),
            'compte': s['account'],
            'nb_lignes': s['lineCount'],
            'types': ', '.join(f"{k}:{v}" for k, v in (s.get('families') or {}).items()),
            # abonnements nets + frais ponctuels rattachés aux lignes du site :
            # c'est la ventilation de l'annexe, qui ne sépare pas les deux
            'facture_hors_conso_eur': round(tot_abo, 2),
            'conso_total_eur': round(tot_conso, 2),
            'premiere_facture': s['first'],
            'derniere_facture': s['last'],
        })
    return _csv(rows, 'sites_telecom.csv')


@app.get('/api/export/invoices')
def export_invoices():
    if not dataset_exists():
        rebuild()
    ds = json.load(open(DATA_PATH, encoding='utf-8'))
    rows = []
    for i in ds['invoices']:
        t = i['totals']
        rows.append({
            'compte': i['compte'],
            'facture': i['numero'],
            'date': i['date'],
            'mois': i['month'],
            'marche': i.get('marche') or '',
            'abonnements_eur': t['abonnements'],
            'conso_eur': t['consommations'],
            'ponctuels_eur': t.get('ponctuels'),
            'remises_abo_eur': t.get('remiseAbo'),
            'remises_conso_eur': t.get('remiseConso'),
            'total_ht_eur': t['ht'],
            'tva_eur': t['tva'],
            'total_ttc_eur': t['ttc'],
        })
    return _csv(rows, 'factures.csv')


@app.get('/api/export/remises')
def export_remises():
    """Pièce jointe d'une réclamation : chaque remise, l'offre qu'elle remise et
    la facture où elle figure.

    Le rattachement remise -> offre n'est pas déduit d'un rapprochement de
    libellés : la facture l'exprime par sa mise en page (la remise est imprimée
    sous l'offre, avec la même quantité), et le parseur conserve ce lien. Chaque
    ligne du CSV est donc vérifiable sur le PDF cité.
    """
    if not dataset_exists():
        rebuild()
    ds = json.load(open(DATA_PATH, encoding='utf-8'))
    kinds = {'marche': 'remise marché', 'compensation': 'compensation augmentation',
             'autre': 'autre'}
    rows = []
    for mk in ds['months']:
        for p in ds['monthly'][mk].get('products', []):
            if not p.get('montant'):
                continue
            if not p.get('isRemise') and not p.get('isCredit'):
                continue
            brut = p.get('baseMontant')
            remise = -p['montant']
            rows.append({
                'mois': mk,
                'compte': p.get('compte', ''),
                'facture': p.get('facture', ''),
                'nature': 'régularisation / avoir' if p.get('isCredit')
                          else kinds.get(p.get('kind'), 'autre'),
                'libelle_remise': p['name'],
                'offre_remisee': p.get('base') or '',
                'brut_offre_eur': brut if brut else '',
                'remise_eur': round(remise, 2),
                'taux_obtenu_pct': round(remise / brut * 100, 2) if brut else '',
            })
    rows.sort(key=lambda r: (r['mois'], r['compte'], -abs(r['remise_eur'])))
    return _csv(rows, 'remises_par_offre.csv')


RE_PCT = re.compile(r'(\d+(?:[,.]\d+)?)\s*%')


def r2(x):
    """Arrondi commercial à 2 décimales (0,005 monte).

    `round()` de Python arrondit au pair le plus proche : 25,125 devient 25,12
    quand la convention comptable — et le JavaScript de l'interface — donnent
    25,13. Sur une pièce de réclamation les deux doivent afficher le centime.
    """
    return float(decimal.Decimal(str(x)).quantize(decimal.Decimal('0.01'),
                                                  rounding=decimal.ROUND_HALF_UP))


def _offer_totals(ds, months=None):
    """Par offre facturée : brut, remises rattachées, et le détail par facture.

    Reprend le rattachement lu sur la facture (`base`) : aucune offre n'est
    rapprochée par ressemblance de libellé.

    Le détail est ventilé par (mois, compte, facture) et non par mois seul : un
    même mois porte jusqu'à trois factures, et rapporter le montant du mois à
    chacune d'elles multiplierait le montant réclamé.
    """
    months = months or ds['months']
    offers = {}

    def bucket(name, p, mk):
        e = offers.setdefault(name, {'name': name, 'brut': 0.0, 'remise': 0.0,
                                     'parts': {}})
        key = (mk, p.get('compte', ''), p.get('facture', ''))
        return e, e['parts'].setdefault(key, {'brut': 0.0, 'remise': 0.0})

    for mk in months:
        for p in ds['monthly'][mk].get('products', []):
            if not p.get('montant') or p.get('isCredit'):
                continue
            if p.get('isRemise'):
                if not p.get('base'):
                    continue
                e, part = bucket(p['base'], p, mk)
                e['remise'] += -p['montant']
                part['remise'] += -p['montant']
            else:
                e, part = bucket(p['name'], p, mk)
                e['brut'] += p['montant']
                part['brut'] += p['montant']
    for e in offers.values():
        e['taux'] = (e['remise'] / e['brut'] * 100) if e['brut'] else 0.0
    return offers


@app.get('/api/export/reclamation')
def export_reclamation():
    """Dossier de réclamation : un poste réclamé par facture, chiffré.

    Deux fondements, distingués par une colonne — ils n'ont pas la même force :

    - « libellé de l'offre » : le taux est écrit dans le nom du produit facturé
      et aucune remise ne lui correspond. Constat direct, opposable tel quel.
    - « écart entre offres » : l'offre n'est pas remisée alors que les autres le
      sont. Chiffré de la même manière, mais suspendu à la grille du marché.

    L'export des remises (`/api/export/remises`) ne pouvait pas porter le premier
    cas : l'anomalie y est justement l'absence de ligne de remise.
    """
    if not dataset_exists():
        rebuild()
    ds = json.load(open(DATA_PATH, encoding='utf-8'))
    offers = _offer_totals(ds)
    seuil = 5.0

    remisees = [o for o in offers.values() if o['taux'] >= seuil]
    ref_brut = sum(o['brut'] for o in remisees)
    ref_taux = (sum(o['remise'] for o in remisees) / ref_brut * 100) if ref_brut else 0.0

    rows = []
    for o in sorted(offers.values(), key=lambda x: -x['brut']):
        m = RE_PCT.search(o['name'])
        nominal = float(m.group(1).replace(',', '.')) if m else None
        # 1. taux annoncé par le libellé de l'offre et non appliqué
        if nominal is not None and nominal - o['taux'] > 1:
            cible, fondement = nominal, 'libellé de l\'offre'
        # 2. offre non remisée alors que les autres le sont
        elif o['taux'] < seuil and o['brut'] > 200:
            cible, fondement = ref_taux, 'écart entre offres'
        else:
            continue
        # Le taux attendu est arrondi une fois pour toutes : c'est celui qui
        # figure sur la pièce, et tous les montants en découlent. Un destinataire
        # qui refait le calcul sur la feuille doit retomber sur nos chiffres.
        cible = r2(cible)
        for (mk, compte, fact) in sorted(o['parts']):
            part = o['parts'][(mk, compte, fact)]
            brut = r2(part['brut'])
            remise = r2(part['remise'])
            if brut <= 0:
                continue
            # montant réclamé = ce qui aurait dû être remisé, moins ce qui l'a été.
            # Formulé à partir des seules colonnes exportées, donc recalculable.
            reclame = r2(brut * cible / 100 - remise)
            if reclame <= 0:
                continue
            rows.append({
                'fondement': fondement,
                'mois': mk,
                'compte': compte,
                'facture': fact,
                'offre': o['name'],
                'montant_facture_eur': brut,
                'remise_appliquee_eur': remise,
                'taux_applique_pct': r2(remise / brut * 100),
                'taux_attendu_pct': cible,
                'montant_reclame_eur': reclame,
            })
    # les constats opposables tels quels d'abord
    ordre = {'libellé de l\'offre': 0, 'écart entre offres': 1}
    rows.sort(key=lambda r: (ordre[r['fondement']], r['offre'], r['mois']))
    return _csv(rows, 'dossier_reclamation.csv')


@app.get('/api/export/mouvements')
def export_mouvements():
    """Lignes entrées et sorties entre deux mois de facture.

    Les bornes viennent de l'appelant : contrôler une résiliation demandée en
    avril suppose de comparer avril à un mois postérieur, pas de se caler sur la
    dernière facture.
    """
    if not dataset_exists():
        rebuild()
    ds = json.load(open(DATA_PATH, encoding='utf-8'))
    months = ds['months']
    if not months:
        return _csv([], 'mouvements_parc.csv')
    frm = request.args.get('from') or months[0]
    to = request.args.get('to') or months[-1]
    if frm not in months or to not in months:
        return jsonify({'ok': False, 'error': 'mois hors périmètre'}), 400
    if frm > to:
        frm, to = to, frm
    account = request.args.get('account')
    noms = load_migration()['siteNames']

    rows = []
    for l in ds['lines']:
        if account and l['account'] != account:
            continue
        a, b = l['months'].get(frm), l['months'].get(to)
        if bool(a) == bool(b):
            continue                      # inchangée : présente ou absente aux deux dates
        sortie = bool(a)
        v = a or b
        rows.append({
            'mouvement': 'retirée' if sortie else 'ajoutée',
            'mois_depart': frm,
            'mois_arrivee': to,
            'numero': l['number'],
            'type': l['familyLabel'],
            'compte': l['account'],
            'sous_compte': l['siteId'],
            'site': noms.get(l['siteId'], {}).get('name') or l['siteName'],
            'site_sur_facture': l['siteName'],
            'adresse': l.get('siteAddress', ''),
            'cout_mensuel_eur': round(v['net'], 2),
            'cout_annuel_eur': round(v['net'] * 12, 2),
            'premiere_facture': l['first'],
            'derniere_facture': l['last'],
        })
    # les sorties d'abord, par montant : c'est ce qu'on vient vérifier
    rows.sort(key=lambda r: (r['mouvement'] != 'retirée', -r['cout_mensuel_eur']))
    return _csv(rows, f'mouvements_{frm}_{to}.csv')


@app.get('/api/export/migration')
def export_migration():
    """Plan de migration cuivre : une ligne par ligne RTC encore en service."""
    if not dataset_exists():
        rebuild()
    ds = json.load(open(DATA_PATH, encoding='utf-8'))
    store = load_migration()
    suivi, par_ligne, noms = store['sites'], store['lines'], store['siteNames']
    tech_labels = {'fibre': 'fibre', 'adsl': 'ADSL', 'sdsl': 'SDSL',
                   'xdsl_presume': 'xDSL présumé'}
    last_by_account = {}
    for i in ds['invoices']:
        if i['month'] > last_by_account.get(i['compte'], ''):
            last_by_account[i['compte']] = i['month']
    labels = {'todo': 'à traiter', 'study': 'étude', 'ordered': 'commandé',
              'migrated': 'migré', 'kept': 'conservé'}
    rows = []
    for l in ds['lines']:
        ref_month = last_by_account.get(l['account'])
        cur = l['months'].get(ref_month)
        if not cur or not l.get('onCopper'):
            continue
        # une saisie portée sur la ligne prime sur celle du site : c'est la plus
        # précise des deux, et c'est à ce niveau que la commande est passée
        ligne_st = par_ligne.get(l['key'])
        st = ligne_st or suivi.get(l['siteId'], {})
        renomme = noms.get(l['siteId'], {}).get('name', '')
        rows.append({
            'numero': l['number'],
            'technologie': l['familyLabel'],
            'acces': tech_labels.get(l.get('accessTech'), ''),
            'sous_compte': l['siteId'],
            'site': renomme or l['siteName'],
            'site_sur_facture': l['siteName'],
            'direction': l.get('siteDept', ''),
            'adresse': l.get('siteAddress', ''),
            'acces_internet_sur_site': l.get('siteInternet', ''),
            'rattachee_a': l.get('attachedTo', ''),
            'cout_mensuel_eur': cur['net'],
            'cout_annuel_eur': round(cur['net'] * 12, 2),
            'statut_migration': labels.get(st.get('state', 'todo'), 'à traiter'),
            'suivi_porte_par': 'ligne' if ligne_st else ('site' if st else ''),
            'reference_commande': st.get('ref', ''),
            'date_action': st.get('date', ''),
            'note': st.get('note', ''),
        })
    rows.sort(key=lambda r: -r['cout_mensuel_eur'])
    return _csv(rows, 'plan_migration_cuivre.csv')


@app.get('/api/health')
def health():
    n_files = len(glob.glob(os.path.join(FACTURES_DIR, '*.pdf')))
    return jsonify({
        'ok': True,
        'factures': n_files,
        'dataset': dataset_exists(),
        'now': datetime.datetime.now().isoformat(timespec='seconds'),
    })


def ensure_dataset():
    """Construit le dataset au premier démarrage s'il n'existe pas encore.

    Appelé aussi par le point d'entrée WSGI : sur un volume vierge, la première
    requête déclencherait sinon une reconstruction de plusieurs secondes.
    """
    if auth.using_default_credentials():
        print('ATTENTION : compte par défaut test/test actif. '
              'Définir OPTITEL_USER et OPTITEL_PASSWORD avant tout usage réel.',
              flush=True)
    if not dataset_exists():
        print('Dataset absent : construction initiale...', flush=True)
        rebuild()


if __name__ == '__main__':
    # Serveur de développement uniquement. En production, l'image Docker lance
    # gunicorn sur wsgi:app — voir DEPLOIEMENT.md.
    ensure_dataset()
    host = os.environ.get('OPTITEL_HOST', '127.0.0.1')
    port = int(os.environ.get('OPTITEL_PORT', '8484'))
    print(f'OptiTel disponible sur http://{host}:{port}')
    app.run(host=host, port=port, debug=False)
