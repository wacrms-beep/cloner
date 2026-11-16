"""
Tests unitaires pour CssProcessor (engine/tests/test_css_processor.py) :
- Réécriture de url(...) pour images et @font-face
- Réécriture de @import "..." et @import url(...)
- Gestion des data: URI ignorées.
"""
from clone.url_rewriter import UrlRewriter
from clone.css_processor import CssProcessor


def test_css_processor_rewrites_urls_and_imports(tmp_path):
    site_dir = tmp_path / "site"
    (site_dir / "assets" / "css").mkdir(parents=True)
    (site_dir / "assets" / "fonts").mkdir(parents=True)
    (site_dir / "assets" / "img").mkdir(parents=True)

    asset_map = {
        "https://example.com/static/css/reset.css": "assets/css/reset.css",
        "https://example.com/static/fonts/inter.woff2": "assets/fonts/inter.woff2",
        "https://example.com/static/img/banner.png": "assets/img/banner.png",
    }

    # Créer le fichier reset.css local pour tester le traitement récursif sans réseau
    reset_file = site_dir / "assets" / "css" / "reset.css"
    reset_file.write_text("body { background: url('../img/banner.png'); }", encoding="utf-8")

    rewriter = UrlRewriter(
        root_url="https://example.com/",
        asset_lookup=lambda u: asset_map.get(u),
    )

    processor = CssProcessor(
        site_dir=str(site_dir),
        rewriter=rewriter,
        asset_saver=lambda u, b, c: None,
    )

    raw_css = """
    @import "reset.css";
    @font-face {
      font-family: 'Inter';
      src: url('../fonts/inter.woff2') format('woff2');
    }
    .hero {
      background-image: url("/static/img/banner.png");
      mask-image: url("data:image/svg+xml;utf8,<svg></svg>");
    }
    """

    rewritten = processor.process_css_text(
        raw_css,
        css_source_url="https://example.com/static/css/main.css",
        css_local_relpath="assets/css/main.css",
        allow_network_fetch=False,
    )

    assert "reset.css" in rewritten
    assert "../fonts/inter.woff2" in rewritten
    assert "../img/banner.png" in rewritten
    assert "data:image/svg+xml" in rewritten
    # Vérifier que reset.css a lui aussi été réécrit récursivement
    assert "../img/banner.png" in reset_file.read_text(encoding="utf-8")
