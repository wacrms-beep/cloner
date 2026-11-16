"""
Tests unitaires pour SchemaInferrer (engine/tests/test_schema_inferrer.py) :
Vérifie l'inférence sur le format exact de https://quotes.toscrape.com/api/quotes?page=1
(détection de l'enveloppe 'quotes', extraction de la table parente 'authors' et de la
table 'quotes' avec clé étrangère author_id -> authors(id), types SQL et pagination).
"""
from models import EndpointRecord
from backend_gen.schema_inferrer import SchemaInferrer


def test_schema_inferrer_on_quotes_api_payload():
    sample_payload = {
        "has_next": True,
        "page": 1,
        "top_ten_tags": [["love", 10], ["inspirational", 8]],
        "quotes": [
            {
                "author": {
                    "goodreads_link": "/author/show/9810.Albert_Einstein",
                    "name": "Albert Einstein",
                    "slug": "Albert-Einstein",
                },
                "tags": ["change", "deep-thoughts", "thinking", "world"],
                "text": "The world as we have created it is a process of our thinking.",
            },
            {
                "author": {
                    "goodreads_link": "/author/show/1077326.J_K_Rowling",
                    "name": "J.K. Rowling",
                    "slug": "J-K-Rowling",
                },
                "tags": ["choices", "abilities"],
                "text": "It is our choices, Harry, that show what we truly are.",
            },
        ],
    }

    ep = EndpointRecord(
        method="GET",
        normalized_path="/api/quotes",
        sample_url="https://quotes.toscrape.com/api/quotes?page=1",
        status_code=200,
        response_samples=[sample_payload],
    )

    inferrer = SchemaInferrer()
    tables = inferrer.infer_from_endpoints([ep])
    table_names = [t.name for t in tables]

    assert "authors" in table_names
    assert "quotes" in table_names

    quotes_table = next(t for t in tables if t.name == "quotes")
    assert quotes_table.envelope_key == "quotes"
    assert quotes_table.supports_pagination is True
    assert len(quotes_table.sample_rows) == 2

    author_fk_col = next(c for c in quotes_table.columns if c.name == "author_id")
    assert author_fk_col.references == "authors(id)"
