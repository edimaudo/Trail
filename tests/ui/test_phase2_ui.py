from pathlib import Path
from playwright.sync_api import sync_playwright

PROJECT = Path(__file__).resolve().parents[2]
HARNESS = PROJECT / "tests" / "ui" / "phase2_ui_harness.html"
OUT = Path("/mnt/data")


def test_offline_map_storage_ui_and_responsive_layout():
    html = HARNESS.read_text(encoding="utf-8")
    css = (PROJECT / "app" / "source" / "css" / "app.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="../../app/static/css/app.css">', f'<style>{css}</style>')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_content(html, wait_until="domcontentloaded")

        page.get_by_role("button", name="Download map").click()
        assert page.locator(".map-download-progress").is_visible()
        assert page.get_by_role("button", name="Saving map…").is_disabled()
        page.evaluate("window.postMessage('complete-download', '*')")
        assert page.get_by_text("1,240 map tiles · 1,252 resources · 28.4 MB saved").is_visible()
        page.locator(".map-storage-details summary").click()
        assert page.get_by_role("button", name="Remove").is_visible()
        page.get_by_role("button", name="Remove").click()
        assert page.get_by_text("No downloaded map packs yet.").is_visible()
        assert page.get_by_text("Manage downloaded maps (0)").is_visible()
        assert page.get_by_role("button", name="Download map").is_visible()
        page.locator(".map-storage-details").evaluate("element => element.open = false")

        for width in (320, 390, 768, 1024, 1440):
            page.set_viewport_size({"width": width, "height": 1000})
            page.wait_for_timeout(80)
            metrics = page.evaluate("({inner: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth})")
            assert metrics["doc"] <= width, f"document horizontal overflow at {width}px: {metrics}"
            assert metrics["body"] <= width, f"body horizontal overflow at {width}px: {metrics}"

        page.set_viewport_size({"width": 1440, "height": 1000})
        page.screenshot(path=str(OUT / "trail-phase2-offline-storage-desktop.png"), full_page=True)
        page.set_viewport_size({"width": 390, "height": 1000})
        page.screenshot(path=str(OUT / "trail-phase2-offline-storage-mobile.png"), full_page=True)
        page.set_viewport_size({"width": 320, "height": 1000})
        page.screenshot(path=str(OUT / "trail-phase2-offline-storage-320.png"), full_page=True)
        assert not errors, errors
        browser.close()
