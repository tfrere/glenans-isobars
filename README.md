---
title: Isobares Glénans
emoji: 🌀
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# Isobares · Glénans

Petite app web qui affiche en live les **isobares** (pression au niveau de la
mer) autour de l'archipel des Glénans, au large de la Bretagne sud.

- **Frontend** : Vite + React + TypeScript + MUI, isobares tracées avec `d3-contour`.
- **Backend** : FastAPI qui interroge [Open-Meteo](https://open-meteo.com/)
  (modèle **ECMWF IFS**) sur une grille régulière, met le résultat en cache, et
  expose `/api/isobars`. Il sert aussi le frontend buildé.
- **Déploiement** : un seul conteneur Docker (pattern Hugging Face Space).

## API

| Endpoint           | Description                                                          |
| ------------------ | ------------------------------------------------------------------- |
| `GET /api/isobars` | Grille MSLP + vent + bbox + métadonnées (JSON), live, cache 30 min. |
| `GET /api/history` | Timeline ERA5 (1 an, 1 frame/jour à 12:00 UTC). Construite en       |
|                    | arrière-plan au démarrage, mise en cache disque, polling possible.  |
| `GET /api/health`  | Healthcheck.                                                        |

Tant que l'historique se construit, `/api/history` renvoie
`{ "status": "building", "progress": 0..1 }`, puis le payload complet une fois
`"status": "ready"`.

## Développement local

Deux terminaux :

```bash
# 1. Backend (port 7860)
cd server
pip install -r requirements.txt
python app.py

# 2. Frontend (port 5173, proxy /api -> 7860)
npm install
npm run dev
```

## Build de production (comme sur le Space)

```bash
docker build -t glenans-isobars .
docker run -p 7860:7860 glenans-isobars
# -> http://localhost:7860
```

## Déploiement sur Hugging Face Spaces

```bash
git init && git add . && git commit -m "feat: glenans isobars app"
git remote add space git@hf.co:spaces/<user>/glenans-isobars
git push space main
```

Le Space détecte le `Dockerfile` (SDK `docker`) et publie sur le port `7860`.

## Données

- **Direct - pression & vent** : Open-Meteo (ECMWF IFS 0.25°, `pressure_msl` +
  `wind_speed_10m` / `wind_direction_10m`). La fenêtre couvre l'Atlantique
  Nord-Est / Europe de l'Ouest (40-56°N, 20°W-8°E), échantillonnée en 29×17
  points, puis interpolée en isobares tous les 4 hPa côté client. Le vent est
  rendu en barbules météo (kt) : demi-barbule = 5, barbule = 10, fanion = 50.
- **Historique - timeline** : Open-Meteo Archive (réanalyse **ERA5**), 1 an
  glissant, 1 frame par jour (12:00 UTC) sur une grille plus légère (15×10).
  Construite en chunks mensuels séquentiels (respect du rate limit) et mise en
  cache disque (`server/cache/`).
- **Projection** : Mercator (`d3-geo`) ajustée à la fenêtre, partagée par les
  isobares, le vent, le graticule et le trait de côte pour un alignement exact.
- **Trait de côte** : [Natural Earth](https://www.naturalearthdata.com/) (land
  50m) via le paquet `world-atlas`, servi en asset statique
  (`public/land-50m.json`) et projeté avec la même transformation que la grille
  pour un alignement exact.
