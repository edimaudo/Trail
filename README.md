# Trail

Trail is a **Python web application built with FastAPI** and delivered as an installable, offline-first Progressive Web App. It is one Python application, not a separate frontend and backend project.

- FastAPI owns the application, routes, APIs, templates and static assets.
- HTML and plain CSS provide the interface.
- TypeScript is kept as browser source under `app/source/` and its compiled JavaScript is included in `app/static/`.
- Firebase AI Logic runs in the browser through Firebase's supported JavaScript SDK, which is required for Gemini Nano on-device inference.
- Dexie/IndexedDB stores trips, guides, map-pack metadata and chat history.
- MapLibre renders the map and saved route.
- The service worker and web app manifest make the app installable and offline-capable.

There is **no `frontend/` directory, no `backend/` directory, no Node.js runtime, no `package.json`, and no `npm install` step**. Production runs Python/Uvicorn only.

## Project layout

```text
trail/
├── app/
│   ├── __init__.py
│   ├── main.py                     # FastAPI application and API routes
│   ├── geography.py                # GPX, route and geographic utilities
│   ├── source/                     # Maintained browser source (not a separate app)
│   │   ├── css/app.css
│   │   └── typescript/
│   │       ├── main.ts
│   │       ├── config.ts
│   │       ├── types.ts
│   │       ├── lib/
│   │       ├── tsconfig.json
│   │       └── vendor-types.d.ts
│   ├── templates/
│   │   ├── index.html
│   │   └── offline.html
│   └── static/                     # Files served directly by FastAPI
│       ├── css/app.css             # Ready-to-serve stylesheet
│       ├── js/main.js              # Precompiled browser application
│       ├── js/lib/                 # Precompiled browser modules
│       ├── icons/
│       ├── manifest.webmanifest
│       └── service-worker.js
├── tests/
├── .env.example
├── Dockerfile
├── requirements.txt
├── requirements-dev.txt
└── README.md
```

The TypeScript source and its ready-to-serve JavaScript are both included. The production app does not compile TypeScript when it starts.

## Run Trail locally

You only need Python.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Add the Firebase and Google Maps settings to `.env`, then start the application:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Open `http://127.0.0.1:8000`.

There is no frontend server to start. FastAPI serves the complete PWA from the same origin.

## Browser libraries and offline setup

The browser modules are pinned in the import map in `app/templates/index.html`:

- Firebase JavaScript SDK 13.4.0, including Firebase AI Logic and App Check.
- Dexie 4.2.1.
- MapLibre GL JS 6.19.0.

They are loaded as browser ESM modules rather than installed through npm. The service worker warms the pinned library files and caches subsequent module requests. **The first use must be online** so the browser can retrieve those libraries and the user can prepare a trip/map pack. After the service worker has installed and the libraries have been cached, saved trips and downloaded map resources can be used offline.

The offline experience still depends on the map provider's licence allowing offline tile downloads. Trail does not silently cache public map tiles from providers that prohibit it.

## Environment configuration

Copy `.env.example` to `.env` and configure the values required by the services you enable. Firebase's public web configuration is returned by `/api/config`; server-only Maps keys and third-party credentials are never exposed to the browser.

Firebase AI Logic uses the browser SDK because the web on-device Gemini Nano path is only available through that supported client interface. FastAPI handles Trail's application APIs and verifies App Check tokens on protected backend routes.

## PWA endpoints

FastAPI serves these paths directly:

| URL | Purpose |
|---|---|
| `/` and `/index.html` | PWA application shell |
| `/manifest.webmanifest` | Installation metadata |
| `/service-worker.js` | Root-scoped service worker |
| `/offline.html` | Offline fallback page |
| `/css/*` | Compiled CSS |
| `/js/*` | Compiled JavaScript modules |
| `/icons/*` | PWA icons |
| `/api/*` | FastAPI application API |

The service worker caches the application shell, same-origin JavaScript/CSS, pinned browser libraries and the per-trip map packs. It does not cache arbitrary API responses.

## Run tests

Python tests:

```bash
pip install -r requirements-dev.txt
pytest -q
```

The browser-side regression scripts are standalone Node test harnesses and are not part of the application or client setup. They do not use npm packages. They are optional maintainer tests; the customer only needs Python to run Trail.

## Docker deployment

The Docker image contains Python and the Trail application only. It does not install Node.js or npm and does not run a frontend build.

```bash
docker build -t trail .
docker run --env-file .env -p 8000:8080 trail
```

For production, run behind HTTPS. Service workers, geolocation, camera file access and install prompts require a secure context (localhost is accepted for development).

## Design constraints

- Keep the application local-first and installable as a PWA.
- Keep the UI free of eyebrow labels, logos/monograms, connection badges, device-readiness buttons and offline-simulation controls.
- The header shows the text name `Trail` only.
- Do not introduce React, Tailwind, a separate frontend application, a Node backend, npm setup steps or additional infrastructure without an explicit product requirement.
