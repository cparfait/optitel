# OptiTel — déploiement Docker

## Démarrage

```bash
docker compose up -d --build
```

L'application répond sur <http://127.0.0.1:8484>. Au premier lancement les
volumes sont vides : déposez les PDF par l'écran **Factures & import**, le
dataset se construit tout seul.

## Ce qui tourne dans le conteneur

| | |
|---|---|
| Base | `python:3.12-slim` |
| Serveur | gunicorn, 1 worker, 8 threads |
| Utilisateur | `optitel` (uid 10001), sans privilèges |
| Port interne | 8484 |
| Image | 192 Mio sur disque (46,5 Mio transférés) |

**Un seul worker, volontairement.** La reconstruction du dataset est protégée
par un `threading.Lock`, qui ne vaut qu'à l'intérieur d'un processus. Avec
plusieurs workers, deux imports simultanés se marcheraient dessus et
produiraient un `dataset.json` incohérent. Les 8 threads suffisent : la charge
est de quelques agents, et le seul traitement lourd (lecture des PDF) est déjà
sérialisé par ce verrou.

Le `--timeout 300` couvre la reconstruction complète, qui lit 78 PDF.

## Volumes — ce qu'il faut sauvegarder

| Volume | Contenu | Sauvegarde |
|---|---|---|
| `optitel-factures` → `/data/factures` | PDF déposés | **Oui** — ce sont les sources |
| `optitel-dataset` → `/data/dataset` | `dataset.json` + `migration.json` | **Oui** pour `migration.json` |
| | `migration.json` porte le suivi par site, **par ligne**, et les renommages de sites | |
| `optitel-cache` → `/data/cache` | Texte extrait des PDF | Non — régénérable |

`dataset.json` se reconstruit à partir des PDF. **`migration.json` non** : c'est
la saisie manuelle du suivi de fin du cuivre, elle n'existe nulle part ailleurs.

Sauvegarde :

```bash
docker run --rm -v optitel-dataset:/d -v "$PWD:/out" alpine tar czf /out/optitel-dataset.tgz -C /d .
```

Restauration :

```bash
docker run --rm -v optitel-dataset:/d -v "$PWD:/in" alpine tar xzf /in/optitel-dataset.tgz -C /d
```

## Authentification

Toute l'application est derrière une page de connexion. Seules deux routes
restent ouvertes : `/login` et `/api/health` (la sonde de l'orchestrateur, qui
ne renvoie qu'un état et des compteurs).

### Compte livré : `test` / `test`

**Provisoire.** Tant qu'il est actif, l'application l'affiche sur la page de
connexion, le signale par un bandeau à l'ouverture et l'écrit dans les journaux
au démarrage. Pour le remplacer :

```bash
OPTITEL_USER=prenom.nom OPTITEL_PASSWORD='…' docker compose up -d --force-recreate
```

Mieux, pour ne pas laisser le mot de passe en clair dans le compose ni dans
l'historique du shell — fournir son empreinte :

```bash
python -c "from werkzeug.security import generate_password_hash as h; print(h(input('mot de passe : ')))"
```

puis renseigner `OPTITEL_PASSWORD_HASH` à la place de `OPTITEL_PASSWORD`.

### Sessions

Cookie signé, `HttpOnly`, `SameSite=Lax`, durée 12 h (`OPTITEL_SESSION_HOURS`).
La clé de signature vient de `OPTITEL_SECRET_KEY`, sinon elle est générée et
conservée en `600` sur le volume de données — les sessions survivent donc à un
redémarrage. Supprimer ce fichier déconnecte tout le monde.

**Derrière HTTPS, passez `OPTITEL_SECURE_COOKIE=1`** : le cookie cesse alors de
circuler en clair. Laissé désactivé par défaut, sinon la connexion est
impossible sur un accès local en http.

### Protection contre le bourrage

8 tentatives échouées par couple (IP, identifiant) sur 5 minutes glissantes,
puis blocage jusqu'à la fin de la fenêtre — y compris avec le bon mot de passe.
Compteur en mémoire de processus : cohérent tant qu'il n'y a qu'un worker.

### À venir

`auth.py` isole toute la vérification derrière `authenticate(user, password)`,
qui renvoie `{'username', 'display', 'roles'}`. Le raccordement à l'annuaire
AD/LDAPS ne demandera que d'écrire cette fonction et de basculer
`OPTITEL_AUTH_BACKEND=ldap` ; `roles` est déjà transporté jusqu'à la session
pour que la gestion des droits n'ait pas à changer le format du cookie.

## Sécurité — à lire avant d'exposer

L'authentification protège l'application, **mais elle circule en clair**. Le
`docker-compose.yml` publie donc sur `127.0.0.1:8484` uniquement.

Pour ouvrir l'accès à d'autres postes, mettez un reverse proxy devant qui porte
le TLS, et passez `OPTITEL_SECURE_COOKIE=1`. Ne remplacez pas
`127.0.0.1:8484:8484` par `8484:8484` sans cela : le conteneur serait joignable
par tout le réseau, mot de passe transmis en clair.

Autres points déjà en place : conteneur non-root, `no-new-privileges`,
`/app` en lecture seule pour l'application, route PDF réduite au nom de fichier
(la traversée de répertoire renvoie 404), limite mémoire à 512 Mio, taille
d'envoi plafonnée (`OPTITEL_MAX_UPLOAD_MB`, 200 Mio par défaut).

## Mise à jour du code

```bash
docker compose up -d --build
```

Les volumes ne sont pas touchés : PDF, dataset et suivi de migration survivent.
Vérifié en détruisant puis recréant le conteneur.

## Variables d'environnement

| Variable | Défaut en conteneur | Rôle |
|---|---|---|
| `OPTITEL_FACTURES_DIR` | `/data/factures` | PDF déposés |
| `OPTITEL_DATA_DIR` | `/data/dataset` | `dataset.json`, `migration.json` |
| `OPTITEL_CACHE_DIR` | `/data/cache` | Cache du texte extrait |
| `OPTITEL_HOST` / `OPTITEL_PORT` | — | Serveur de développement seulement |
| `OPTITEL_USER` | `test` | Identifiant de connexion |
| `OPTITEL_PASSWORD` | `test` | Mot de passe en clair |
| `OPTITEL_PASSWORD_HASH` | — | Empreinte, prioritaire sur le clair |
| `OPTITEL_SECRET_KEY` | générée et persistée | Signature des sessions |
| `OPTITEL_SECURE_COOKIE` | `0` | `1` derrière HTTPS |
| `OPTITEL_SESSION_HOURS` | `12` | Durée d'une session |
| `OPTITEL_AUTH_BACKEND` | `local` | `ldap` à venir |
| `OPTITEL_MAX_UPLOAD_MB` | `200` | Plafond d'envoi |

Hors conteneur et sans ces variables, tout reste dans le dossier du projet :
`python server.py` fonctionne comme avant.

## Vérifier que ça tourne

```bash
docker compose ps && curl -s localhost:8484/api/health
```

`HEALTHCHECK` interroge `/api/health` toutes les 30 s, avec 120 s de grâce au
démarrage pour laisser passer une éventuelle construction initiale.

## Journaux

```bash
docker compose logs -f optitel
```

Les accès et les erreurs vont sur la sortie standard, sans tampon.

## Recette effectuée

| Test | Résultat |
|---|---|
| Démarrage sur volumes vides | dataset construit, health 200 |
| Import des 78 PDF par l'API | 39 factures, 168 lignes, 135 sites |
| Dataset conteneur vs local | identique, HT 55 347,16 € |
| Redémarrage du conteneur | PDF, dataset et saisie conservés |
| **Destruction et recréation** | **saisie de migration conservée** |
| Les 8 écrans × 3 comptes | 0 erreur d'affichage |
| 6 exports CSV | 200, tailles conformes |
| Route PDF | 200 `application/pdf` |
| Traversée de répertoire | 404 |
| Compression gzip | 1 126 Ko → 57 Ko |
| Écriture hors volume | refusée |
| Accents dans une note de suivi | conservés |
| Accès sans session | `/` → 302 login · `/api/*` → 401 · CSV et PDF → 302 |
| `/api/health` sans session | 200 (nécessaire à la sonde) |
| Connexion `test`/`test` | 302 puis accès complet |
| Identifiants personnalisés | ancien mot de passe refusé, nouveau accepté, bandeau d'avertissement disparu |
| Déconnexion | session invalidée, retour à la page de connexion |
| 8 tentatives échouées | blocage 5 min, y compris avec le bon mot de passe |
| Session après redémarrage | conservée (clé persistée en `600`) |
