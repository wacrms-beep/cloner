"""
SqlGenerator (engine/backend_gen/sql_generator.py) :
Produit :
1. `database.sql` : script MySQL 8 complet (utf8mb4, InnoDB, clés primaires, clés étrangères,
   index, INSERT des données d'exemple par lots), prêt pour un hébergement Alwaysdata.
2. `preview.sqlite` : base SQLite locale contenant le même schéma et les mêmes données
   d'exemple, prête à être ouverte dans le Data Studio intégré.
"""
from __future__ import annotations

import os
import sqlite3
from typing import Any, List
from models import ColumnSpec, TableSpec


class SqlGenerator:
    def generate_mysql_dump(self, tables: List[TableSpec], domain: str = "clone") -> str:
        lines: List[str] = [
            f"-- ====================================================================",
            f"-- Universal Clone - Base de données MySQL 8 (compatible Alwaysdata)",
            f"-- Domaine source : {domain}",
            f"-- Charset : utf8mb4 / Engine : InnoDB",
            f"-- ====================================================================",
            "SET NAMES utf8mb4;",
            "SET FOREIGN_KEY_CHECKS = 0;",
            "",
        ]

        for table in tables:
            t_name = self._quote_mysql_ident(table.name)
            lines.append(f"DROP TABLE IF EXISTS {t_name};")
            col_defs: List[str] = []
            pk_cols: List[str] = []
            fk_defs: List[str] = []
            idx_defs: List[str] = []

            for col in table.columns:
                c_name = self._quote_mysql_ident(col.name)
                mysql_type = col.sql_type
                null_sql = "NOT NULL" if (not col.nullable or col.primary) else "NULL"
                auto_inc = (
                    " AUTO_INCREMENT"
                    if (col.primary and mysql_type in ("INT", "BIGINT"))
                    else ""
                )
                unique_sql = " UNIQUE" if (col.unique and not col.primary) else ""
                col_defs.append(f"  {c_name} {mysql_type} {null_sql}{auto_inc}{unique_sql}")

                if col.primary:
                    pk_cols.append(c_name)

                if col.references:
                    ref_table, ref_col = self._parse_reference(col.references)
                    fk_name = self._quote_mysql_ident(f"fk_{table.name}_{col.name}"[:60])
                    idx_name = self._quote_mysql_ident(f"idx_{table.name}_{col.name}"[:60])
                    idx_defs.append(f"  KEY {idx_name} ({c_name})")
                    fk_defs.append(
                        f"  CONSTRAINT {fk_name} FOREIGN KEY ({c_name}) "
                        f"REFERENCES {self._quote_mysql_ident(ref_table)} ({self._quote_mysql_ident(ref_col)}) "
                        f"ON DELETE SET NULL ON UPDATE CASCADE"
                        if col.nullable
                        else f"  CONSTRAINT {fk_name} FOREIGN KEY ({c_name}) "
                        f"REFERENCES {self._quote_mysql_ident(ref_table)} ({self._quote_mysql_ident(ref_col)}) "
                        f"ON DELETE CASCADE ON UPDATE CASCADE"
                    )

            if pk_cols:
                col_defs.append(f"  PRIMARY KEY ({', '.join(pk_cols)})")

            all_defs = col_defs + idx_defs + fk_defs
            lines.append(f"CREATE TABLE {t_name} (")
            lines.append(",\n".join(all_defs))
            lines.append(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;")
            lines.append("")

            # INSERT des données d'exemple par lots de 50 lignes
            if table.sample_rows:
                col_names = [c.name for c in table.columns]
                quoted_cols = ", ".join(self._quote_mysql_ident(c) for c in col_names)
                batch_size = 50
                for i in range(0, len(table.sample_rows), batch_size):
                    batch = table.sample_rows[i : i + batch_size]
                    value_tuples: List[str] = []
                    for row in batch:
                        vals = [self._format_mysql_literal(row.get(c)) for c in col_names]
                        value_tuples.append(f"({', '.join(vals)})")
                    lines.append(f"INSERT INTO {t_name} ({quoted_cols}) VALUES")
                    lines.append(",\n".join(value_tuples) + ";")
                    lines.append("")

        lines.append("SET FOREIGN_KEY_CHECKS = 1;")
        return "\n".join(lines) + "\n"

    def write_database_files(
        self,
        output_dir: str,
        tables: List[TableSpec],
        domain: str = "clone",
    ) -> tuple[str, str]:
        """
        Écrit `database.sql` et `preview.sqlite` dans output_dir.
        Si aucune table API n'a été inférée (site 100% statique), crée une table
        `clone_metadata` dans preview.sqlite afin que le Data Studio puisse toujours l'ouvrir.
        """
        os.makedirs(output_dir, exist_ok=True)
        sql_path = os.path.join(output_dir, "database.sql")
        sqlite_path = os.path.join(output_dir, "preview.sqlite")

        effective_tables = list(tables)
        if not effective_tables:
            effective_tables = [
                TableSpec(
                    name="clone_metadata",
                    columns=[
                        ColumnSpec(name="id", sql_type="INT", nullable=False, primary=True),
                        ColumnSpec(name="domain", sql_type="VARCHAR(255)", nullable=False),
                        ColumnSpec(name="note", sql_type="TEXT", nullable=True),
                    ],
                    sample_rows=[
                        {
                            "id": 1,
                            "domain": domain,
                            "note": "Aucune requête XHR/Fetch JSON détectée sur ce site statique.",
                        }
                    ],
                )
            ]

        mysql_sql = self.generate_mysql_dump(effective_tables, domain=domain)
        with open(sql_path, "w", encoding="utf-8") as f:
            f.write(mysql_sql)

        self._create_sqlite_database(sqlite_path, effective_tables)
        return sql_path, sqlite_path

    def _create_sqlite_database(self, sqlite_path: str, tables: List[TableSpec]) -> None:
        if os.path.exists(sqlite_path):
            os.remove(sqlite_path)

        conn = sqlite3.connect(sqlite_path)
        try:
            cur = conn.cursor()
            cur.execute("PRAGMA foreign_keys = OFF;")

            for table in tables:
                q_table = self._quote_sqlite_ident(table.name)
                col_defs: List[str] = []
                fk_defs: List[str] = []

                for col in table.columns:
                    q_col = self._quote_sqlite_ident(col.name)
                    sqlite_type = self._to_sqlite_type(col.sql_type)
                    if col.primary:
                        if sqlite_type == "INTEGER":
                            col_defs.append(f"{q_col} INTEGER PRIMARY KEY")
                        else:
                            col_defs.append(f"{q_col} {sqlite_type} PRIMARY KEY")
                    else:
                        null_str = "NOT NULL" if not col.nullable else "NULL"
                        uniq_str = " UNIQUE" if col.unique else ""
                        col_defs.append(f"{q_col} {sqlite_type} {null_str}{uniq_str}")

                    if col.references:
                        ref_t, ref_c = self._parse_reference(col.references)
                        fk_defs.append(
                            f"FOREIGN KEY ({q_col}) REFERENCES {self._quote_sqlite_ident(ref_t)}({self._quote_sqlite_ident(ref_c)})"
                        )

                create_stmt = f"CREATE TABLE {q_table} ({', '.join(col_defs + fk_defs)});"
                cur.execute(create_stmt)

                # Index sur clés étrangères
                for col in table.columns:
                    if col.references:
                        idx_name = self._quote_sqlite_ident(f"idx_{table.name}_{col.name}")
                        cur.execute(
                            f"CREATE INDEX IF NOT EXISTS {idx_name} ON {q_table}({self._quote_sqlite_ident(col.name)});"
                        )

                # Insertion préparée des lignes d'exemple
                if table.sample_rows:
                    col_names = [c.name for c in table.columns]
                    quoted_cols = ", ".join(self._quote_sqlite_ident(c) for c in col_names)
                    placeholders = ", ".join("?" for _ in col_names)
                    insert_sql = f"INSERT INTO {q_table} ({quoted_cols}) VALUES ({placeholders})"
                    rows_data = [
                        tuple(self._coerce_sqlite_val(r.get(c)) for c in col_names)
                        for r in table.sample_rows
                    ]
                    cur.executemany(insert_sql, rows_data)

            cur.execute("PRAGMA foreign_keys = ON;")
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _to_sqlite_type(mysql_type: str) -> str:
        t = mysql_type.upper()
        if "INT" in t:
            return "INTEGER"
        if "DEC" in t or "FLOA" in t or "DOUB" in t:
            return "REAL"
        return "TEXT"

    @staticmethod
    def _coerce_sqlite_val(val: Any) -> Any:
        if val is None:
            return None
        if isinstance(val, bool):
            return 1 if val else 0
        if isinstance(val, (int, float, str)):
            return val
        return str(val)

    @staticmethod
    def _parse_reference(ref: str) -> tuple[str, str]:
        if "(" in ref and ref.endswith(")"):
            t, c = ref[:-1].split("(", 1)
            return t.strip(), c.strip()
        return ref.strip(), "id"

    @staticmethod
    def _quote_mysql_ident(ident: str) -> str:
        clean = str(ident).replace("`", "``")
        return f"`{clean}`"

    @staticmethod
    def _quote_sqlite_ident(ident: str) -> str:
        clean = str(ident).replace('"', '""')
        return f'"{clean}"'

    @staticmethod
    def _format_mysql_literal(val: Any) -> str:
        if val is None:
            return "NULL"
        if isinstance(val, bool):
            return "1" if val else "0"
        if isinstance(val, (int, float)):
            return str(val)
        escaped = (
            str(val)
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\r", "\\r")
            .replace("\n", "\\n")
        )
        return f"'{escaped}'"
