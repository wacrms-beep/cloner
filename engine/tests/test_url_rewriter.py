"""
Tests unitaires obligatoires sur UrlRewriter (engine/tests/test_url_rewriter.py) :
Plus de 26 cas couvrant :
- URLs absolues, relatives, protocol-relative (//), avec ../
- Normalisation d'URL (tri query, suppression fragment, port par défaut, minuscules)
- Chemins locaux de pages (racine, /page/2/, .html, query string)
- Calcul de chemins relatifs depuis différentes profondeurs
- srcset / data-srcset multiples
- style="" inline avec url(...)
- <base href="...">
- Schémas spéciaux ignorés (data:, mailto:, tel:, javascript:, #anchor)
- Liens externes hors domaine vs sous-domaines.
"""
import pytest
from clone.url_rewriter import (
    UrlRewriter,
    normalize_page_url,
    page_url_to_local_relpath,
    compute_relative_link,
)


ASSET_MAP = {
    "https://quotes.toscrape.com/static/bootstrap.min.css": "assets/css/bootstrap.min.css",
    "https://quotes.toscrape.com/static/main.js": "assets/js/main.js",
    "https://quotes.toscrape.com/images/logo.png": "assets/img/logo.png",
    "https://quotes.toscrape.com/images/hero-1x.webp": "assets/img/hero-1x.webp",
    "https://quotes.toscrape.com/images/hero-2x.webp": "assets/img/hero-2x.webp",
    "https://cdn.example.net/fonts/inter.woff2": "assets/fonts/inter.woff2",
    "https://quotes.toscrape.com/media/intro.mp4": "assets/media/intro.mp4",
    "https://quotes.toscrape.com/images/bg.jpg": "assets/img/bg.jpg",
}

KNOWN_PAGES = {
    "https://quotes.toscrape.com/": "index.html",
    "https://quotes.toscrape.com/page/2/": "page/2/index.html",
    "https://quotes.toscrape.com/tag/love/page/1/": "tag/love/page/1/index.html",
    "https://quotes.toscrape.com/login": "login/index.html",
}


def make_rewriter(include_subdomains: bool = False) -> UrlRewriter:
    return UrlRewriter(
        root_url="https://quotes.toscrape.com/",
        asset_lookup=lambda u: ASSET_MAP.get(u),
        known_pages=dict(KNOWN_PAGES),
        same_domain_only=True,
        include_subdomains=include_subdomains,
    )


# 1 à 6 : Normalisation d'URL
def test_01_normalize_lowercase_host_and_scheme():
    assert normalize_page_url("HTTPS://Quotes.ToScrape.COM/Page/1/") == "https://quotes.toscrape.com/Page/1/"


def test_02_normalize_strips_fragment():
    assert normalize_page_url("https://quotes.toscrape.com/page/2/#top") == "https://quotes.toscrape.com/page/2/"


def test_03_normalize_sorts_query_params():
    assert normalize_page_url("https://example.com/search?b=2&a=1") == "https://example.com/search?a=1&b=2"


def test_04_normalize_removes_default_ports():
    assert normalize_page_url("https://example.com:443/path") == "https://example.com/path"
    assert normalize_page_url("http://example.com:80/path") == "http://example.com/path"


def test_05_normalize_resolves_dot_segments():
    assert normalize_page_url("https://example.com/a/b/../c/") == "https://example.com/a/c/"


# 6 à 10 : Conversion URL de page -> chemin local dans site/
def test_06_page_url_root_to_index():
    assert page_url_to_local_relpath("https://quotes.toscrape.com/") == "index.html"


def test_07_page_url_nested_directory():
    assert page_url_to_local_relpath("https://quotes.toscrape.com/page/2/") == "page/2/index.html"


def test_08_page_url_explicit_html_file():
    assert page_url_to_local_relpath("https://example.com/docs/guide.html") == "docs/guide.html"


def test_09_page_url_with_query_string():
    rel = page_url_to_local_relpath("https://example.com/items?page=3")
    assert rel.endswith("/index.html")
    assert "page_3" in rel


def test_10_compute_relative_link_between_depths():
    assert compute_relative_link("page/2/index.html", "assets/css/bootstrap.min.css") == "../../assets/css/bootstrap.min.css"


# 11 à 28 : Réécriture complète avec UrlRewriter
def test_11_rewrite_root_asset_css():
    rw = make_rewriter()
    res = rw.rewrite_reference(
        "/static/bootstrap.min.css",
        source_url="https://quotes.toscrape.com/",
        source_local_relpath="index.html",
    )
    assert res == "assets/css/bootstrap.min.css"


def test_12_rewrite_nested_page_asset_css():
    rw = make_rewriter()
    res = rw.rewrite_reference(
        "/static/bootstrap.min.css",
        source_url="https://quotes.toscrape.com/page/2/",
        source_local_relpath="page/2/index.html",
    )
    assert res == "../../assets/css/bootstrap.min.css"


def test_13_rewrite_protocol_relative_cdn_asset():
    rw = make_rewriter()
    res = rw.rewrite_reference(
        "//cdn.example.net/fonts/inter.woff2",
        source_url="https://quotes.toscrape.com/page/2/",
        source_local_relpath="page/2/index.html",
    )
    assert res == "../../assets/fonts/inter.woff2"


def test_14_rewrite_parent_dotdot_relative_asset():
    rw = make_rewriter()
    res = rw.rewrite_reference(
        "../../images/logo.png",
        source_url="https://quotes.toscrape.com/tag/love/",
        source_local_relpath="tag/love/index.html",
    )
    assert res == "../../assets/img/logo.png"


def test_15_rewrite_page_link_from_root_to_page2():
    rw = make_rewriter()
    res = rw.rewrite_reference(
        "/page/2/",
        source_url="https://quotes.toscrape.com/",
        source_local_relpath="index.html",
        is_page_link=True,
    )
    assert res == "page/2/index.html"


def test_16_rewrite_page_link_from_page2_to_root():
    rw = make_rewriter()
    res = rw.rewrite_reference(
        "/",
        source_url="https://quotes.toscrape.com/page/2/",
        source_local_relpath="page/2/index.html",
        is_page_link=True,
    )
    assert res == "../../index.html"


def test_17_rewrite_page_link_preserves_fragment_anchor():
    rw = make_rewriter()
    res = rw.rewrite_reference(
        "/login#form",
        source_url="https://quotes.toscrape.com/page/2/",
        source_local_relpath="page/2/index.html",
        is_page_link=True,
    )
    assert res == "../../login/index.html#form"


def test_18_rewrite_external_domain_link_unchanged():
    rw = make_rewriter()
    ext = "https://goodreads.com/author/show/9810"
    res = rw.rewrite_reference(
        ext,
        source_url="https://quotes.toscrape.com/",
        source_local_relpath="index.html",
        is_page_link=True,
    )
    assert res == ext


def test_19_rewrite_subdomain_when_enabled():
    rw = make_rewriter(include_subdomains=True)
    res = rw.rewrite_reference(
        "https://blog.quotes.toscrape.com/welcome/",
        source_url="https://quotes.toscrape.com/",
        source_local_relpath="index.html",
        is_page_link=True,
    )
    assert res == "welcome/index.html"


def test_20_rewrite_srcset_multiple_candidates():
    rw = make_rewriter()
    srcset = "/images/hero-1x.webp 1x, https://quotes.toscrape.com/images/hero-2x.webp 2x"
    res = rw.rewrite_srcset(
        srcset,
        source_url="https://quotes.toscrape.com/page/2/",
        source_local_relpath="page/2/index.html",
    )
    assert res == "../../assets/img/hero-1x.webp 1x, ../../assets/img/hero-2x.webp 2x"


def test_21_rewrite_inline_style_url_single_quotes():
    rw = make_rewriter()
    style = "background-image: url('/images/bg.jpg'); color: #000;"
    res = rw.rewrite_inline_style(
        style,
        source_url="https://quotes.toscrape.com/page/2/",
        source_local_relpath="page/2/index.html",
    )
    assert res == "background-image: url('../../assets/img/bg.jpg'); color: #000;"


def test_22_rewrite_inline_style_url_unquoted():
    rw = make_rewriter()
    style = "background: url(https://quotes.toscrape.com/images/bg.jpg) no-repeat;"
    res = rw.rewrite_inline_style(
        style,
        source_url="https://quotes.toscrape.com/",
        source_local_relpath="index.html",
    )
    assert res == "background: url(assets/img/bg.jpg) no-repeat;"


def test_23_rewrite_with_base_href_override():
    rw = make_rewriter()
    res = rw.rewrite_reference(
        "logo.png",
        source_url="https://quotes.toscrape.com/page/2/",
        source_local_relpath="page/2/index.html",
        is_page_link=False,
        base_href="https://quotes.toscrape.com/images/",
    )
    assert res == "../../assets/img/logo.png"


@pytest.mark.parametrize(
    "special_ref",
    [
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
        "mailto:contact@example.com",
        "tel:+33123456789",
        "javascript:void(0)",
        "#section-2",
        "blob:https://example.com/550e8400",
    ],
)
def test_24_to_29_special_schemes_untouched(special_ref):
    rw = make_rewriter()
    assert (
        rw.rewrite_reference(
            special_ref,
            source_url="https://quotes.toscrape.com/",
            source_local_relpath="index.html",
            is_page_link=True,
        )
        == special_ref
    )
