"""
PhpGenerator (engine/backend_gen/php_generator.py) :
Génère le dossier `backend/` complet à partir des templates PHP 8 :
- backend/index.php
- backend/.htaccess
- backend/includes/{Router.php, Database.php, Response.php, Validator.php}
- backend/config/{config.php, database.php} (adapté à un hébergement Alwaysdata : mysql-<compte>.alwaysdata.net)
- backend/endpoints/<ressource>.php (GET liste avec pagination/tri/filtre et jointure automatique
  des tables parentes si détectées, GET par id, POST, PUT/PATCH, DELETE — 100 % requêtes préparées PDO)
- backend/README_BACKEND.md
Les routes reproduisent fidèlement les chemins d'origine observés (ex: /api/quotes?page=1) et
retournent le même format JSON que l'original (même enveloppe ex: {"has_next": ..., "page": ..., "quotes": [...]}).
"""
from __future__ import annotations

import json
import os
import shutil
from typing import Dict, List
from models import EndpointRecord, TableSpec


DATABASE_CONFIG_TEMPLATE = """<?php
declare(strict_types=1);

/**
 * Configuration de connexion MySQL 8 (préconfigurée pour un hébergement Alwaysdata).
 * En développement local, si le mot de passe n'est pas modifié ou si UCLONE_USE_SQLITE=1,
 * Database.php bascule automatiquement sur la base locale ../preview.sqlite.
 */
return [
    'host' => getenv('DB_HOST') ?: 'mysql-votrecompte.alwaysdata.net',
    'port' => (int)(getenv('DB_PORT') ?: 3306),
    'database' => getenv('DB_NAME') ?: 'votrecompte_clone',
    'username' => getenv('DB_USER') ?: 'votrecompte',
    'password' => getenv('DB_PASS') ?: 'VOTRE_MOT_DE_PASSE_MYSQL',
    'charset' => 'utf8mb4',
    'sqlite_fallback' => dirname(__DIR__, 2) . '/preview.sqlite',
];
"""


class PhpGenerator:
    def __init__(self, templates_dir: str = "") -> None:
        self.templates_dir = templates_dir or os.path.join(os.path.dirname(__file__), "templates")

    def generate(
        self,
        output_dir: str,
        tables: List[TableSpec],
        endpoints: List[EndpointRecord],
        domain: str = "clone",
    ) -> str:
        backend_dir = os.path.join(output_dir, "backend")
        includes_dir = os.path.join(backend_dir, "includes")
        config_dir = os.path.join(backend_dir, "config")
        endpoints_dir = os.path.join(backend_dir, "endpoints")

        for d in (backend_dir, includes_dir, config_dir, endpoints_dir):
            os.makedirs(d, exist_ok=True)

        # 1. Copier les templates statiques (.htaccess, config.php, includes/*.php)
        shutil.copyfile(
            os.path.join(self.templates_dir, ".htaccess"),
            os.path.join(backend_dir, ".htaccess"),
        )
        shutil.copyfile(
            os.path.join(self.templates_dir, "config.php"),
            os.path.join(config_dir, "config.php"),
        )
        with open(os.path.join(config_dir, "database.php"), "w", encoding="utf-8") as f:
            f.write(DATABASE_CONFIG_TEMPLATE)

        for inc_name in ("Response.php", "Validator.php", "Database.php", "Router.php"):
            shutil.copyfile(
                os.path.join(self.templates_dir, inc_name),
                os.path.join(includes_dir, inc_name),
            )

        # 2. Générer un contrôleur par table dans backend/endpoints/<table_name>.php
        tables_by_name: Dict[str, TableSpec] = {t.name: t for t in tables}
        route_registrations: List[str] = []

        for table in tables:
            endpoint_php = self._build_resource_endpoint_php(table, tables_by_name)
            ep_file = os.path.join(endpoints_dir, f"{table.name}.php")
            with open(ep_file, "w", encoding="utf-8") as f:
                f.write(endpoint_php)

            base_route = table.source_endpoint or f"/api/{table.name}"
            base_route = base_route.rstrip("/") or f"/api/{table.name}"
            if base_route.endswith("/{id}"):
                base_route = base_route[: -len("/{id}")]

            fn_prefix = f"handle_{table.name}"
            route_registrations.append(f"require_once __DIR__ . '/endpoints/{table.name}.php';")
            route_registrations.append(f"$router->register('GET', '{base_route}', '{fn_prefix}_list');")
            route_registrations.append(f"$router->register('GET', '{base_route}/{{id}}', '{fn_prefix}_get');")
            route_registrations.append(f"$router->register('POST', '{base_route}', '{fn_prefix}_create');")
            route_registrations.append(f"$router->register('PUT', '{base_route}/{{id}}', '{fn_prefix}_update');")
            route_registrations.append(f"$router->register('PATCH', '{base_route}/{{id}}', '{fn_prefix}_update');")
            route_registrations.append(f"$router->register('DELETE', '{base_route}/{{id}}', '{fn_prefix}_delete');")

            # Si base_route n'est pas déjà /api/<table>, ajouter aussi l'alias /api/<table>
            std_route = f"/api/{table.name}"
            if base_route != std_route:
                route_registrations.append(f"$router->register('GET', '{std_route}', '{fn_prefix}_list');")
                route_registrations.append(f"$router->register('GET', '{std_route}/{{id}}', '{fn_prefix}_get');")
                route_registrations.append(f"$router->register('POST', '{std_route}', '{fn_prefix}_create');")
                route_registrations.append(f"$router->register('PUT', '{std_route}/{{id}}', '{fn_prefix}_update');")
                route_registrations.append(f"$router->register('PATCH', '{std_route}/{{id}}', '{fn_prefix}_update');")
                route_registrations.append(f"$router->register('DELETE', '{std_route}/{{id}}', '{fn_prefix}_delete');")

        # 3. Générer index.php
        with open(os.path.join(self.templates_dir, "index.php"), "r", encoding="utf-8") as f:
            index_tpl = f.read()

        routes_code = "\n".join(route_registrations) if route_registrations else "// Aucune table dynamique"
        index_final = index_tpl.replace("__ROUTES_REGISTRATION__", routes_code)
        with open(os.path.join(backend_dir, "index.php"), "w", encoding="utf-8") as f:
            f.write(index_final)

        # 4. Générer README_BACKEND.md
        readme_md = self._build_backend_readme(domain, tables, endpoints)
        with open(os.path.join(backend_dir, "README_BACKEND.md"), "w", encoding="utf-8") as f:
            f.write(readme_md)

        return backend_dir

    def _build_resource_endpoint_php(
        self,
        table: TableSpec,
        tables_by_name: Dict[str, TableSpec],
    ) -> str:
        t_name = table.name
        pk_col = next((c.name for c in table.columns if c.primary), "id")
        all_cols = [c.name for c in table.columns]
        writable_rules = {
            c.name: {
                "type": c.sql_type,
                "nullable": c.nullable,
                "max_length": 65535 if c.sql_type == "TEXT" else 255,
            }
            for c in table.columns
            if not c.primary
        }

        # Détection des clés étrangères vers une table parente (ex: author_id -> authors)
        nested_joins = []
        for col in table.columns:
            if col.references and "(" in col.references:
                ref_table = col.references.split("(", 1)[0]
                if ref_table in tables_by_name:
                    field_alias = col.name[:-3] if col.name.endswith("_id") else ref_table
                    nested_joins.append({
                        "fk_col": col.name,
                        "ref_table": ref_table,
                        "alias": field_alias,
                    })

        json_cols = [c.name for c in table.columns if c.sql_type == "JSON"]

        rules_php = json.dumps(writable_rules, ensure_ascii=False)
        cols_php = json.dumps(all_cols, ensure_ascii=False)
        json_cols_php = json.dumps(json_cols, ensure_ascii=False)
        joins_php = json.dumps(nested_joins, ensure_ascii=False)
        envelope_key = table.envelope_key or ""

        return f"""<?php
declare(strict_types=1);

/**
 * Contrôleur REST généré pour la table `{t_name}`.
 * Requêtes 100 % préparées (PDO). Supporte GET (liste paginée/filtrée/triée), GET par id,
 * POST, PUT/PATCH et DELETE, en conservant le format JSON d'origine.
 */

function hydrate_{t_name}_row(PDO $pdo, array $row): array
{{
    $jsonCols = json_decode('{json_cols_php}', true) ?: [];
    foreach ($jsonCols as $jc) {{
        if (isset($row[$jc]) && is_string($row[$jc])) {{
            $decoded = json_decode($row[$jc], true);
            if ($decoded !== null) {{
                $row[$jc] = $decoded;
            }}
        }}
    }}

    $joins = json_decode('{joins_php}', true) ?: [];
    foreach ($joins as $j) {{
        $fkCol = $j['fk_col'];
        $refTable = $j['ref_table'];
        $alias = $j['alias'];
        if (!empty($row[$fkCol])) {{
            $stmt = $pdo->prepare('SELECT * FROM "' . str_replace('"', '""', $refTable) . '" WHERE id = :id LIMIT 1');
            $stmt->execute([':id' => $row[$fkCol]]);
            $parent = $stmt->fetch();
            if ($parent) {{
                unset($parent['id']);
                $row[$alias] = $parent;
            }}
        }}
    }}
    return $row;
}}

function handle_{t_name}_list(array $params = []): never
{{
    $pdo = Database::getConnection();
    $allowedCols = json_decode('{cols_php}', true) ?: ['id'];

    $page = max(1, (int)($_GET['page'] ?? 1));
    $limit = min(100, max(1, (int)($_GET['limit'] ?? $_GET['per_page'] ?? 10)));
    $offset = isset($_GET['offset']) ? max(0, (int)$_GET['offset']) : (($page - 1) * $limit);

    $sortBy = $_GET['sort'] ?? '{pk_col}';
    if (!in_array($sortBy, $allowedCols, true)) {{
        $sortBy = '{pk_col}';
    }}
    $sortDir = strtoupper((string)($_GET['order'] ?? 'ASC')) === 'DESC' ? 'DESC' : 'ASC';

    $where = [];
    $binds = [];
    foreach ($allowedCols as $col) {{
        if (isset($_GET[$col]) && $_GET[$col] !== '') {{
            $where[] = $col . ' = :' . $col;
            $binds[':' . $col] = $_GET[$col];
        }}
    }}

    $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

    $countStmt = $pdo->prepare("SELECT COUNT(*) AS cnt FROM {t_name} {{$whereSql}}");
    $countStmt->execute($binds);
    $total = (int)($countStmt->fetch()['cnt'] ?? 0);

    $sql = "SELECT * FROM {t_name} {{$whereSql}} ORDER BY {{$sortBy}} {{$sortDir}} LIMIT :limit OFFSET :offset";
    $stmt = $pdo->prepare($sql);
    foreach ($binds as $k => $v) {{
        $stmt->bindValue($k, $v);
    }}
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();

    $rows = [];
    while ($r = $stmt->fetch()) {{
        $rows[] = hydrate_{t_name}_row($pdo, $r);
    }}

    $envelopeKey = '{envelope_key}';
    if ($envelopeKey !== '') {{
        Response::json([
            'has_next' => ($offset + $limit) < $total,
            'page' => $page,
            'total' => $total,
            $envelopeKey => $rows,
        ]);
    }}

    Response::json($rows);
}}

function handle_{t_name}_get(array $params): never
{{
    $pdo = Database::getConnection();
    $id = $params['id'] ?? null;
    $stmt = $pdo->prepare('SELECT * FROM {t_name} WHERE {pk_col} = :id LIMIT 1');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    if (!$row) {{
        Response::error('Ressource introuvable.', 404, 'NOT_FOUND');
    }}
    Response::json(hydrate_{t_name}_row($pdo, $row));
}}

function handle_{t_name}_create(array $params = []): never
{{
    $pdo = Database::getConnection();
    $rules = json_decode('{rules_php}', true) ?: [];
    $body = Validator::getJsonBody();
    $clean = Validator::sanitizePayload($body, $rules);

    if (empty($clean)) {{
        Response::error('Aucune donnée valide fournie.', 422, 'EMPTY_PAYLOAD');
    }}

    $cols = array_keys($clean);
    $placeholders = array_map(fn($c) => ':' . $c, $cols);
    $sql = sprintf(
        'INSERT INTO {t_name} (%s) VALUES (%s)',
        implode(', ', $cols),
        implode(', ', $placeholders)
    );

    $stmt = $pdo->prepare($sql);
    foreach ($clean as $col => $val) {{
        $stmt->bindValue(':' . $col, $val);
    }}
    $stmt->execute();

    $newId = $pdo->lastInsertId();
    Response::json(['id' => $newId, 'created' => true] + $clean, 201);
}}

function handle_{t_name}_update(array $params): never
{{
    $pdo = Database::getConnection();
    $id = $params['id'] ?? null;
    $rules = json_decode('{rules_php}', true) ?: [];
    $body = Validator::getJsonBody();
    $clean = Validator::sanitizePayload($body, $rules);

    if (empty($clean)) {{
        Response::error('Aucun champ valide à mettre à jour.', 422, 'EMPTY_PAYLOAD');
    }}

    $sets = [];
    foreach (array_keys($clean) as $col) {{
        $sets[] = $col . ' = :' . $col;
    }}
    $sql = sprintf('UPDATE {t_name} SET %s WHERE {pk_col} = :__pk_id', implode(', ', $sets));
    $stmt = $pdo->prepare($sql);
    foreach ($clean as $col => $val) {{
        $stmt->bindValue(':' . $col, $val);
    }}
    $stmt->bindValue(':__pk_id', $id);
    $stmt->execute();

    Response::json(['id' => $id, 'updated' => $stmt->rowCount() > 0]);
}}

function handle_{t_name}_delete(array $params): never
{{
    $pdo = Database::getConnection();
    $id = $params['id'] ?? null;
    $stmt = $pdo->prepare('DELETE FROM {t_name} WHERE {pk_col} = :id');
    $stmt->execute([':id' => $id]);
    Response::json(['id' => $id, 'deleted' => $stmt->rowCount() > 0]);
}}
"""

    @staticmethod
    def _build_backend_readme(
        domain: str,
        tables: List[TableSpec],
        endpoints: List[EndpointRecord],
    ) -> str:
        lines = [
            f"# Backend PHP 8 Natif (PDO) — {domain}",
            "",
            "Ce backend a été généré automatiquement par **Universal Clone** à partir du trafic XHR/Fetch observé.",
            "",
            "## 1. Déploiement sur Alwaysdata (MySQL 8)",
            "",
            "1. Importez le fichier `../database.sql` dans votre base MySQL Alwaysdata (`phpMyAdmin` ou `mysql -h mysql-<compte>.alwaysdata.net -u <compte> -p <base> < database.sql`).",
            "2. Éditez `config/database.php` (ou définissez les variables d'environnement `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`).",
            "3. Téléversez les dossiers `site/` et `backend/` sur votre hébergement.",
            "",
            "## 2. Test local instantané (PHP CLI + preview.sqlite)",
            "",
            "En local, si `config/database.php` conserve le mot de passe par défaut, `Database.php` utilise automatiquement la base SQLite locale `../preview.sqlite` :",
            "",
            "```bash",
            "php -S 127.0.0.1:8089 -t backend backend/index.php",
            "```",
            "",
            "## 3. Tables et Routes REST générées",
            "",
        ]
        for t in tables:
            base_r = t.source_endpoint or f"/api/{t.name}"
            lines.append(f"- **`{t.name}`** ({len(t.columns)} colonnes, {len(t.sample_rows)} lignes d'exemple) : `GET/POST {base_r}`, `GET/PUT/PATCH/DELETE {base_r}/{{id}}`")
        if not tables:
            lines.append("- Aucune table dynamique détectée (site statique).")
        return "\n".join(lines) + "\n"
