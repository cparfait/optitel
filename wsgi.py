# -*- coding: utf-8 -*-
"""Point d'entrée WSGI — c'est lui que lance gunicorn en production.

`server.py` garde son `app.run()` pour le développement local ; il n'est jamais
utilisé ici. La construction initiale du dataset se fait au chargement du module,
donc avant que le worker n'accepte sa première requête.
"""
from server import app, ensure_dataset

ensure_dataset()

__all__ = ['app']
