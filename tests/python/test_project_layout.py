from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_trail_is_a_single_python_web_application() -> None:
    assert (ROOT / "app" / "main.py").is_file()
    assert (ROOT / "app" / "templates" / "index.html").is_file()
    assert (ROOT / "app" / "static" / "service-worker.js").is_file()
    assert not (ROOT / "frontend").exists()
    assert not (ROOT / "backend").exists()
    assert not (ROOT / "tools").exists()
    assert not (ROOT / "package.json").exists()
    assert not (ROOT / "app" / "package.json").exists()


def test_browser_source_and_precompiled_assets_are_kept_inside_app() -> None:
    assert (ROOT / "app" / "source" / "typescript" / "main.ts").is_file()
    assert (ROOT / "app" / "source" / "css" / "app.css").is_file()
    assert (ROOT / "app" / "static" / "js" / "main.js").is_file()
    assert (ROOT / "app" / "static" / "js" / "lib" / "firebase.js").is_file()
    assert (ROOT / "app" / "static" / "css" / "app.css").is_file()


def test_production_dockerfile_uses_python_only() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8").lower()
    assert "from python:" in dockerfile
    assert "node:" not in dockerfile
    assert "npm " not in dockerfile
    assert "uvicorn app.main:app" in dockerfile


def test_page_uses_pinned_browser_modules_without_package_install() -> None:
    html = (ROOT / "app" / "templates" / "index.html").read_text(encoding="utf-8")
    assert "https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js" in html
    assert "https://cdn.jsdelivr.net/npm/dexie@4.2.1/dist/dexie.mjs" in html
    assert "https://unpkg.com/maplibre-gl@6.19.0/dist/maplibre-gl.mjs" in html
    assert '<script type="importmap">' in html
    assert '<script type="module" src="/js/main.js"></script>' in html
