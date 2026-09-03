# OptiTel

Analyse des factures de téléphonie fixe Orange Business pour une collectivité :
inventaire du parc, suivi de la fin du cuivre, contrôle des remises et
constitution d'un dossier de réclamation.

L'application lit les PDF de facture (facture `.F.` + annexe `.A.`), en extrait
le détail et le restitue dans huit écrans, sans dépendance front.

## Démarrer

```bash
docker compose up -d --build
```

Puis <http://127.0.0.1:8484> — compte `test` / `test` par défaut, **à remplacer
avant tout usage réel**. Déposez les PDF par l'écran *Factures & import* : le
dataset se construit tout seul.

En développement, sans Docker :

```bash
pip install -r requirements.txt
python server.py
```

Voir [DEPLOIEMENT.md](DEPLOIEMENT.md) pour la configuration, l'authentification,
les volumes et la sauvegarde.

## Ce que l'outil cherche

Le rattachement d'une remise à l'offre qu'elle remise n'est **pas** deviné par
ressemblance de libellés : la facture l'exprime par sa mise en page — la remise
est imprimée sous l'offre, avec la même quantité facturée — et le parseur
conserve ce lien. Deux offres distinctes portant des remises au libellé
identique restent donc séparées.

Sur cette base, l'application signale :

- une **remise annoncée dans le libellé d'une offre et jamais appliquée** ;
- les **offres facturées sans remise** là où les autres en obtiennent ;
- les **lignes moins remisées que leurs jumelles** sur la même offre ;
- les **régularisations qui se répètent**, signe d'un abonnement mal paramétré ;
- l'effet **volume** et l'effet **tarif** d'un changement de marché, séparés.

L'export `/api/export/reclamation` produit un poste réclamé par facture, chiffré
et recalculable à partir de ses seules colonnes.

## Suivre le parc

**Mouvements du parc** compare deux mois de facture choisis librement et liste
les numéros qui ont disparu entre les deux — pour contrôler une résiliation
demandée, ou expliquer une marche d'escalier sur la courbe du parc. Export CSV
par `/api/export/mouvements?from=AAAA-MM&to=AAAA-MM`.

**Fin du cuivre** se tient ligne par ligne : sur un site mixte, le T0 bascule en
VoIP quand l'ascenseur attend encore son ascensoriste. Une déclaration faite au
niveau du site vaut pour toutes ses lignes sans saisie propre, et l'interface
indique lesquelles en héritent.

**Renommer un site** quand la facture le nomme mal. Le nom facturé n'est jamais
écrasé : il reste affiché en dessous pour retrouver le sous-compte sur le PDF.
La vue Sites signale les libellés portés par plusieurs bâtiments — dix
sous-comptes nommés « MAIRIE DE CHATILLON » à neuf adresses ne permettent pas de
savoir de quel local on parle.

## Structure

```
parser_invoice.py    extraction et normalisation des factures PDF
server.py            API Flask, exports CSV, service du front
auth.py              authentification (compte local ; AD/LDAPS à venir)
wsgi.py              point d'entrée gunicorn
web/                 interface (9 vues, sans framework)
Dockerfile           image de production
```

Les factures, le dataset et le cache ne sont pas versionnés : ce sont des
données réelles, elles vivent sur un volume.

## Licence

Non déterminée.
