"""
SchemaInferrer (engine/backend_gen/schema_inferrer.py) :
À partir des échantillons JSON d'un ou plusieurs endpoints :
- Détermine le nom de la ressource (nom de table au pluriel en snake_case)
- Trouve le tableau d'objets pertinent (racine, data, items, results, quotes, etc.)
- Fusionne les types sur tous les échantillons
- Détecte la clé primaire (id, _id, uuid, slug)
- Détecte les champs nullables, les dates (ISO 8601), les booléens, les décimaux,
  les clés étrangères (xxx_id -> table xxx)
- Détecte les objets imbriqués stables (ex: author: {name, goodreads_link, slug})
  pour créer des tables parentes/enfants reliées par clé étrangère (ex: authors + author_id),
  ou une colonne JSON si la structure est une liste de primitives ou instable
- Détecte la pagination (page, limit, offset, next, has_next)
- Produit une liste de TableSpec avec ColumnSpec.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from models import ColumnSpec, EndpointRecord, TableSpec


ISO_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$"
)
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

ENVELOPE_CANDIDATES = (
    "data",
    "items",
    "results",
    "records",
    "rows",
    "quotes",
    "users",
    "posts",
    "products",
    "entries",
    "list",
)

PAGINATION_KEYS = {"page", "per_page", "limit", "offset", "total", "total_pages", "next", "has_next", "prev"}


def to_snake_case(name: str) -> str:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(name or "item"))
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s).strip("_").lower()
    return s or "item"


def pluralize_snake(name: str) -> str:
    snake = to_snake_case(name)
    if snake.endswith("s"):
        return snake
    if snake.endswith("y") and len(snake) > 1 and snake[-2] not in "aeiou":
        return snake[:-1] + "ies"
    return snake + "s"


def singularize_snake(name: str) -> str:
    snake = to_snake_case(name)
    if snake.endswith("ies") and len(snake) > 3:
        return snake[:-3] + "y"
    if snake.endswith("s") and not snake.endswith("ss") and len(snake) > 2:
        return snake[:-1]
    return snake


class SchemaInferrer:
    def infer_from_endpoints(self, endpoints: List[EndpointRecord]) -> List[TableSpec]:
        tables_by_name: Dict[str, TableSpec] = {}

        for ep in endpoints:
            if not ep.response_samples:
                continue

            table_name, envelope_key, rows, has_pagination = self._extract_resource_rows(
                ep.normalized_path,
                ep.response_samples,
            )
            if not rows:
                continue

            child_tables: Dict[str, List[Dict[str, Any]]] = {}
            normalized_rows: List[Dict[str, Any]] = []

            for raw_obj in rows:
                if not isinstance(raw_obj, dict):
                    continue
                flat_row: Dict[str, Any] = {}
                for k, v in raw_obj.items():
                    col_name = to_snake_case(k)
                    # Si c'est un sous-objet stable (ex: "author": {"name": "...", "slug": "..."})
                    if isinstance(v, dict) and v and len(v) >= 2 and all(not isinstance(sv, (dict, list)) for sv in v.values()):
                        parent_table = pluralize_snake(col_name)
                        child_list = child_tables.setdefault(parent_table, [])
                        parent_id = self._upsert_nested_entity(child_list, v)
                        fk_col = f"{singularize_snake(col_name)}_id"
                        flat_row[fk_col] = parent_id
                    elif isinstance(v, (dict, list)):
                        flat_row[col_name] = json.dumps(v, ensure_ascii=False)
                    else:
                        flat_row[col_name] = v

                normalized_rows.append(flat_row)

            # Enregistrer d'abord les tables parentes extraites (ex: authors) pour respecter l'ordre des clés étrangères
            for parent_name, parent_rows in child_tables.items():
                self._merge_table_spec(
                    tables_by_name,
                    table_name=parent_name,
                    rows=parent_rows,
                    source_endpoint=f"/api/{parent_name}",
                    envelope_key=None,
                    supports_pagination=False,
                )

            # Puis la table principale (ex: quotes)
            self._merge_table_spec(
                tables_by_name,
                table_name=table_name,
                rows=normalized_rows,
                source_endpoint=ep.normalized_path,
                envelope_key=envelope_key,
                supports_pagination=has_pagination,
            )

        # Résolution finale des références de clés étrangères (xxx_id -> table_pluriel(id))
        all_table_names = set(tables_by_name.keys())
        for spec in tables_by_name.values():
            for col in spec.columns:
                if col.name.endswith("_id") and not col.primary:
                    prefix = col.name[:-3]
                    candidate_plural = pluralize_snake(prefix)
                    if candidate_plural in all_table_names and candidate_plural != spec.name:
                        col.references = f"{candidate_plural}(id)"

        return list(tables_by_name.values())

    def _upsert_nested_entity(
        self,
        entity_list: List[Dict[str, Any]],
        nested_dict: Dict[str, Any],
    ) -> int:
        clean_entity = {to_snake_case(k): v for k, v in nested_dict.items()}
        # Déduplication par id, slug ou name
        match_key = next((k for k in ("id", "slug", "name", "uuid") if k in clean_entity), None)
        if match_key:
            for existing in entity_list:
                if existing.get(match_key) == clean_entity.get(match_key):
                    return int(existing["id"])

        new_id = int(clean_entity.get("id")) if str(clean_entity.get("id", "")).isdigit() else len(entity_list) + 1
        row_with_id = {"id": new_id, **clean_entity}
        entity_list.append(row_with_id)
        return new_id

    def _extract_resource_rows(
        self,
        normalized_path: str,
        samples: List[Any],
    ) -> Tuple[str, Optional[str], List[Dict[str, Any]], bool]:
        segments = [
            s for s in normalized_path.split("/")
            if s and not s.startswith("{") and s.lower() not in ("api", "v1", "v2", "v3", "rest", "public")
        ]
        default_table = pluralize_snake(segments[-1]) if segments else "items"

        collected_rows: List[Dict[str, Any]] = []
        detected_envelope: Optional[str] = None
        has_pagination = False

        for sample in samples:
            if isinstance(sample, list):
                for item in sample:
                    if isinstance(item, dict):
                        collected_rows.append(item)
            elif isinstance(sample, dict):
                if PAGINATION_KEYS.intersection({k.lower() for k in sample.keys()}):
                    has_pagination = True

                # Chercher une clé contenant une liste de dictionnaires
                found_list_key = None
                for cand in ENVELOPE_CANDIDATES:
                    if cand in sample and isinstance(sample[cand], list):
                        found_list_key = cand
                        break
                if not found_list_key:
                    for k, v in sample.items():
                        if isinstance(v, list) and v and isinstance(v[0], dict):
                            found_list_key = k
                            break

                if found_list_key:
                    detected_envelope = found_list_key
                    if default_table == "items" or found_list_key not in ("data", "items", "results", "list"):
                        default_table = pluralize_snake(found_list_key)
                    for item in sample[found_list_key]:
                        if isinstance(item, dict):
                            collected_rows.append(item)
                else:
                    # Objet unique (ex: GET /users/{id})
                    collected_rows.append(sample)

        return default_table, detected_envelope, collected_rows, has_pagination

    def _merge_table_spec(
        self,
        tables_by_name: Dict[str, TableSpec],
        table_name: str,
        rows: List[Dict[str, Any]],
        source_endpoint: str,
        envelope_key: Optional[str],
        supports_pagination: bool,
    ) -> None:
        if not rows:
            return

        existing = tables_by_name.get(table_name)
        all_rows = (existing.sample_rows if existing else []) + rows

        # Assurer la présence d'une clé primaire 'id' si aucune clé primaire naturelle n'existe
        pk_candidates = ("id", "_id", "uuid", "slug")
        has_natural_pk = any(
            all(k in r and r[k] is not None for r in all_rows)
            for k in pk_candidates
        )
        if not has_natural_pk:
            for idx, r in enumerate(all_rows, start=1):
                if "id" not in r or r["id"] is None:
                    r["id"] = idx

        # Collecter l'ordre des colonnes
        col_names: List[str] = []
        if "id" in all_rows[0]:
            col_names.append("id")
        for r in all_rows:
            for k in r.keys():
                if k not in col_names:
                    col_names.append(k)

        columns: List[ColumnSpec] = []
        pk_assigned = False

        for col_name in col_names:
            values = [r.get(col_name) for r in all_rows]
            non_null = [v for v in values if v is not None]
            nullable = len(non_null) < len(all_rows)
            sql_type = self._infer_sql_type(col_name, non_null)

            is_pk = False
            if not pk_assigned and col_name in pk_candidates and not nullable:
                # Vérifier l'unicité des valeurs sur l'échantillon
                str_vals = [str(v) for v in non_null]
                if len(set(str_vals)) == len(str_vals):
                    is_pk = True
                    pk_assigned = True
                    nullable = False
                    if sql_type == "TEXT":
                        sql_type = "VARCHAR(191)"

            is_unique = False
            if not is_pk and col_name in ("slug", "uuid", "email") and len(non_null) > 1:
                str_vals = [str(v) for v in non_null]
                if len(set(str_vals)) == len(str_vals):
                    is_unique = True
                    if sql_type == "TEXT":
                        sql_type = "VARCHAR(191)"

            columns.append(
                ColumnSpec(
                    name=col_name,
                    sql_type=sql_type,
                    nullable=nullable,
                    unique=is_unique,
                    primary=is_pk,
                )
            )

        tables_by_name[table_name] = TableSpec(
            name=table_name,
            columns=columns,
            sample_rows=all_rows[:200],
            source_endpoint=source_endpoint or (existing.source_endpoint if existing else None),
            envelope_key=envelope_key or (existing.envelope_key if existing else None),
            supports_pagination=supports_pagination or (existing.supports_pagination if existing else False),
        )

    def _infer_sql_type(self, col_name: str, values: List[Any]) -> str:
        if not values:
            return "VARCHAR(255)"

        detected_types: set[str] = set()
        max_len = 0

        for v in values:
            if isinstance(v, bool):
                detected_types.add("TINYINT(1)")
            elif isinstance(v, int):
                detected_types.add("BIGINT" if abs(v) > 2147483647 else "INT")
            elif isinstance(v, float):
                detected_types.add("DECIMAL(12,4)")
            elif isinstance(v, str):
                max_len = max(max_len, len(v))
                stripped = v.strip()
                if (stripped.startswith("[") and stripped.endswith("]")) or (
                    stripped.startswith("{") and stripped.endswith("}")
                ):
                    detected_types.add("JSON")
                elif ISO_DATETIME_RE.match(stripped):
                    detected_types.add("DATETIME")
                elif ISO_DATE_RE.match(stripped):
                    detected_types.add("DATE")
                else:
                    detected_types.add("STRING")
            else:
                detected_types.add("TEXT")

        if detected_types == {"TINYINT(1)"}:
            return "TINYINT(1)"
        if detected_types == {"INT"}:
            return "INT"
        if detected_types <= {"INT", "BIGINT"}:
            return "BIGINT"
        if detected_types <= {"INT", "BIGINT", "DECIMAL(12,4)"}:
            return "DECIMAL(12,4)"
        if detected_types == {"DATETIME"}:
            return "DATETIME"
        if detected_types == {"DATE"}:
            return "DATE"
        if detected_types == {"JSON"}:
            return "JSON"

        if max_len > 255 or col_name in ("text", "body", "content", "description", "html", "summary"):
            return "TEXT"
        return "VARCHAR(255)"
