"""
Tests unitaires pour SqlGenerator et PhpGenerator (engine/tests/test_sql_generator.py) :
- Vérifie la génération de database.sql (MySQL 8 utf8mb4 InnoDB)
- Vérifie la création et le peuplement de preview.sqlite
- Vérifie la génération du backend PHP 8 et valide la syntaxe de tous les fichiers PHP avec `php -l`.
"""
import sqlite3
import subprocess
import shutil
from models import EndpointRecord
from backend_gen.schema_inferrer import SchemaInferrer
from backend_gen.sql_generator import SqlGenerator
from backend_gen.php_generator import PhpGenerator


def test_sql_and_php_generators_produce_valid_files(tmp_path):
    sample_payload = {
        "has_next": True,
        "page": 1,
        "quotes": [
            {
                "author": {
                    "goodreads_link": "/author/show/9810.Albert_Einstein",
                    "name": "Albert Einstein",
                    "slug": "Albert-Einstein",
                },
                "tags": ["thinking", "world"],
                "text": "The world as we have created it is a process of our thinking.",
            }
        ],
    }
    ep = EndpointRecord(
        method="GET",
        normalized_path="/api/quotes",
        sample_url="https://quotes.toscrape.com/api/quotes?page=1",
        response_samples=[sample_payload],
    )

    tables = SchemaInferrer().infer_from_endpoints([ep])
    sql_gen = SqlGenerator()
    sql_path, sqlite_path = sql_gen.write_database_files(
        output_dir=str(tmp_path),
        tables=tables,
        domain="quotes.toscrape.com",
    )

    sql_content = (tmp_path / "database.sql").read_text(encoding="utf-8")
    assert "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" in sql_content
    assert "CREATE TABLE `authors`" in sql_content
    assert "CREATE TABLE `quotes`" in sql_content
    assert "FOREIGN KEY (`author_id`) REFERENCES `authors` (`id`)" in sql_content
    assert "INSERT INTO `quotes`" in sql_content

    # Vérifier que preview.sqlite est valide et contient les lignes
    conn = sqlite3.connect(sqlite_path)
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM authors")
    assert cur.fetchone()[0] == 1
    cur.execute("SELECT COUNT(*) FROM quotes")
    assert cur.fetchone()[0] == 1
    conn.close()

    # Générer le backend PHP 8 et valider la syntaxe avec php -l si PHP est installé
    php_gen = PhpGenerator()
    backend_dir = php_gen.generate(
        output_dir=str(tmp_path),
        tables=tables,
        endpoints=[ep],
        domain="quotes.toscrape.com",
    )

    if shutil.which("php"):
        for php_file in (tmp_path / "backend").rglob("*.php"):
            res = subprocess.run(
                ["php", "-l", str(php_file)],
                capture_output=True,
                text=True,
                check=False,
            )
            assert res.returncode == 0, f"Erreur de syntaxe PHP dans {php_file}: {res.stderr}"
