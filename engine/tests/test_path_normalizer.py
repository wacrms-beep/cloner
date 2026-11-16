"""
Tests unitaires pour PathNormalizer et Redactor (engine/tests/test_path_normalizer.py).
"""
from sniff.path_normalizer import PathNormalizer
from sniff.redactor import Redactor


def test_path_normalizer_numeric_uuid_and_hash():
    assert PathNormalizer.normalize_path("https://api.example.com/users/42") == "/users/{id}"
    assert PathNormalizer.normalize_path("/api/v1/orders/9981/items/12") == "/api/v1/orders/{id}/items/{id}"
    assert (
        PathNormalizer.normalize_path("/users/550e8400-e29b-41d4-a716-446655440000/profile")
        == "/users/{uuid}/profile"
    )
    assert (
        PathNormalizer.normalize_path("/commits/a3f5e8d91c0b2e4f6a8d0c2e4b6f8a0c")
        == "/commits/{hash}"
    )
    assert PathNormalizer.normalize_path("https://quotes.toscrape.com/api/quotes?page=1") == "/api/quotes"


def test_redactor_masks_sensitive_keys_emails_and_headers():
    headers = {
        "Accept": "application/json",
        "Authorization": "Bearer secret-jwt-token",
        "Cookie": "session_id=xyz",
        "X-Api-Key": "12345",
    }
    clean_headers = Redactor.redact_headers(headers)
    assert "Authorization" not in clean_headers
    assert "Cookie" not in clean_headers
    assert clean_headers["Accept"] == "application/json"

    payload = {
        "id": 1,
        "username": "alice",
        "password": "mySuperSecretPassword",
        "access_token": "eyJhbGciOi...",
        "contact_email": "alice.dupont@gmail.com",
        "phone": "+33 6 12 34 56 78",
    }
    redacted = Redactor.redact_data(payload)
    assert redacted["id"] == 1
    assert redacted["username"] == "alice"
    assert redacted["password"] == "REDACTED_VALUE"
    assert redacted["access_token"] == "REDACTED_VALUE"
    assert redacted["contact_email"] == "utilisateur@exemple.local"
    assert redacted["phone"] == "+33100000000"
