# -*- coding: utf-8 -*-
"""Authentification — vérification des identifiants, isolée du reste.

Tout ce qui touche aux identifiants passe par `authenticate()`. Le jour où
l'annuaire AD/LDAPS remplace le compte local, c'est la seule fonction à écrire :
`server.py` ne connaît que sa signature et le dictionnaire qu'elle renvoie.

`authenticate()` renvoie un utilisateur :

    {'username': 'test', 'display': 'test', 'roles': ['admin']}

`roles` n'est pas encore exploité — aucun écran ne le lit — mais il est transporté
jusqu'à la session pour que la gestion des droits n'ait pas à changer le format
du cookie plus tard.
"""
import os
import time
import threading

from werkzeug.security import check_password_hash, generate_password_hash

BACKEND = (os.environ.get('OPTITEL_AUTH_BACKEND') or 'local').strip().lower()

# Compte local par défaut : test / test. Provisoire et volontairement visible —
# `using_default_credentials()` permet à l'application de le signaler à l'écran
# et dans les journaux tant qu'il n'a pas été changé.
DEFAULT_USER = 'test'
DEFAULT_PASSWORD = 'test'

AUTH_USER = os.environ.get('OPTITEL_USER') or DEFAULT_USER
_PLAIN = os.environ.get('OPTITEL_PASSWORD')
_HASH = os.environ.get('OPTITEL_PASSWORD_HASH')

if _HASH:
    AUTH_PASSWORD_HASH = _HASH
else:
    AUTH_PASSWORD_HASH = generate_password_hash(_PLAIN or DEFAULT_PASSWORD)


def using_default_credentials():
    """Vrai tant que le compte livré par défaut n'a pas été remplacé."""
    return (BACKEND == 'local'
            and AUTH_USER == DEFAULT_USER
            and not _HASH
            and (_PLAIN or DEFAULT_PASSWORD) == DEFAULT_PASSWORD)


# ------------------------------------------------------------------ anti-bourrage
# Fenêtre glissante par identifiant + IP. En mémoire de processus : suffisant
# avec un worker unique (voir DEPLOIEMENT.md), à remplacer par un stockage
# partagé si l'application passe un jour à plusieurs processus.
_MAX_ATTEMPTS = 8
_WINDOW = 300.0        # 5 minutes
_attempts = {}
_attempts_lock = threading.Lock()


def _prune(now):
    for k, hits in list(_attempts.items()):
        kept = [t for t in hits if now - t < _WINDOW]
        if kept:
            _attempts[k] = kept
        else:
            del _attempts[k]


def throttled(key):
    """Secondes à attendre avant un nouvel essai, 0 si la voie est libre."""
    now = time.time()
    with _attempts_lock:
        _prune(now)
        hits = _attempts.get(key, [])
        if len(hits) < _MAX_ATTEMPTS:
            return 0
        return max(0, int(_WINDOW - (now - hits[0])) + 1)


def record_failure(key):
    now = time.time()
    with _attempts_lock:
        _prune(now)
        _attempts.setdefault(key, []).append(now)


def reset(key):
    with _attempts_lock:
        _attempts.pop(key, None)


# ------------------------------------------------------------------ vérification
def authenticate(username, password):
    """Renvoie l'utilisateur si les identifiants sont valides, sinon None."""
    username = (username or '').strip()
    if not username or not password:
        return None
    if BACKEND == 'local':
        return _authenticate_local(username, password)
    if BACKEND == 'ldap':
        # Emplacement prévu pour l'annuaire : la fonction devra renvoyer le même
        # dictionnaire, en tirant `roles` des groupes AD.
        raise NotImplementedError(
            "backend d'authentification 'ldap' pas encore implémenté ; "
            "laisser OPTITEL_AUTH_BACKEND=local pour l'instant")
    raise ValueError(f"backend d'authentification inconnu : {BACKEND!r}")


def _authenticate_local(username, password):
    # check_password_hash est comparé en temps constant ; on l'exécute même si
    # l'identifiant ne correspond pas, pour ne pas révéler par le temps de
    # réponse quels identifiants existent.
    ok_pwd = check_password_hash(AUTH_PASSWORD_HASH, password)
    if username != AUTH_USER or not ok_pwd:
        return None
    return {'username': AUTH_USER, 'display': AUTH_USER, 'roles': ['admin']}
