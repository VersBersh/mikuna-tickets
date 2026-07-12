from __future__ import annotations

import argparse
import re
import sqlite3
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from datetime import date

from app import DB_PATH, SCHEMA, ClosingConnection, current_menu_snapshot, ensure_event_state


NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def number(value: object) -> float:
    if value in (None, ""):
        return 0.0
    return round(float(value), 2)


def coerce(value: str | None) -> object:
    if value is None:
        return None
    if re.fullmatch(r"-?\d+(\.\d+)?", value):
        return float(value) if "." in value else int(value)
    return value


def shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    return [
        "".join(text.text or "" for text in item.findall(".//a:t", NS))
        for item in root.findall("a:si", NS)
    ]


def workbook_paths(zf: zipfile.ZipFile) -> dict[str, str]:
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    relationships = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rels = {rel.attrib["Id"]: rel.attrib["Target"] for rel in relationships}
    paths = {}
    for sheet in workbook.findall("a:sheets/a:sheet", NS):
        target = rels[sheet.attrib[f"{{{NS['r']}}}id"]]
        paths[sheet.attrib["name"]] = "xl/" + target.lstrip("/")
    return paths


def sheet_cells(zf: zipfile.ZipFile, path: str, shared: list[str]) -> dict[str, object]:
    root = ET.fromstring(zf.read(path))
    cells = {}
    for cell in root.findall(".//a:sheetData/a:row/a:c", NS):
        ref = cell.attrib["r"]
        value = cell.find("a:v", NS)
        inline = cell.find("a:is", NS)
        cell_type = cell.attrib.get("t")
        parsed = value.text if value is not None else None
        if cell_type == "s" and parsed is not None:
            parsed = shared[int(parsed)]
        elif cell_type == "inlineStr" and inline is not None:
            parsed = "".join(text.text or "" for text in inline.findall(".//a:t", NS))
        cells[ref] = coerce(parsed)
    return cells


def load_workbook(path: Path) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    with zipfile.ZipFile(path) as zf:
        shared = shared_strings(zf)
        paths = workbook_paths(zf)
        return (
            sheet_cells(zf, paths["Menu"], shared),
            sheet_cells(zf, paths["Receipt"], shared),
            sheet_cells(zf, paths["Balance"], shared),
        )


def menu_items(menu: dict[str, object]) -> list[tuple[str, str, float, int]]:
    items = []
    sort_order = 1
    for row in range(2, 200):
        code = menu.get(f"A{row}")
        if not code:
            continue
        items.append((str(code), str(menu.get(f"B{row}") or code), number(menu.get(f"C{row}")), sort_order))
        sort_order += 1
    return items


def order_note(receipt: dict[str, object], start: int) -> str:
    for ref in (f"T{start}", f"T{start + 1}", f"T{start + 2}", f"J{start + 6}"):
        value = receipt.get(ref)
        if value:
            return str(value)
    return ""


def import_workbook(xlsx_path: Path, db_path: Path) -> None:
    menu, receipt, balance = load_workbook(xlsx_path)
    items = menu_items(menu)
    with sqlite3.connect(db_path, factory=ClosingConnection) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(SCHEMA)
        ensure_event_state(conn)
        for table in (
            "payment_allocations",
            "payments",
            "order_items",
            "orders",
            "events",
            "menu_items",
            "settings",
        ):
            conn.execute(f"DELETE FROM {table}")
        conn.executemany(
            "INSERT INTO menu_items (code, name, price, sort_order) VALUES (?, ?, ?, ?)",
            items,
        )
        archived = conn.execute(
            """
            INSERT INTO events
              (name, event_date, status, menu_snapshot, archived_at)
            VALUES (?, ?, 'archived', ?, datetime('now', 'localtime'))
            """,
            ("Mikuna The Rad", "2025-09-17", current_menu_snapshot(conn)),
        )
        archived_event_id = int(archived.lastrowid)
        active = conn.execute(
            "INSERT INTO events (name, event_date, status) VALUES (?, ?, 'active')",
            (f"Mikuna {date.today().isoformat()}", date.today().isoformat()),
        )
        active_event_id = int(active.lastrowid)
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('opening_cash', ?)",
            ("0",),
        )
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('actual_cash', ?)",
            ("",),
        )
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('active_event_id', ?)",
            (str(active_event_id),),
        )

        prices = {code: price for code, _, price, _ in items}
        imported = 0
        for start in range(3, 261, 10):
            table_no = receipt.get(f"A{start}")
            if not table_no:
                continue
            cur = conn.execute(
                "INSERT INTO orders (event_id, table_no, note) VALUES (?, ?, ?)",
                (archived_event_id, str(table_no), order_note(receipt, start)),
            )
            order_id = cur.lastrowid
            for row in range(start, start + 3):
                code = receipt.get(f"B{row}")
                qty = number(receipt.get(f"C{row}"))
                if code and qty > 0:
                    conn.execute(
                        """
                        INSERT INTO order_items (order_id, menu_code, menu_name, quantity, unit_price)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            order_id,
                            str(code),
                            next(name for item_code, name, _, _ in items if item_code == str(code)),
                            qty,
                            prices[str(code)],
                        ),
                    )
            for split_no, (qty_col, amount_col, method_col) in enumerate(
                (("G", "H", "I"), ("J", "K", "L"), ("M", "N", "O"), ("P", "Q", "R")),
                start=1,
            ):
                subtotal = number(receipt.get(f"{amount_col}{start + 3}"))
                total = number(receipt.get(f"{amount_col}{start + 5}"))
                tendered = number(receipt.get(f"{amount_col}{start + 6}"))
                if subtotal == 0 and total == 0 and tendered == 0:
                    continue
                method_marker = (
                    receipt.get(f"{method_col}{start + 5}")
                    or receipt.get(f"{method_col}{start + 6}")
                    or ""
                )
                method = "paypal" if str(method_marker).lower() == "pp" else "cash"
                payment = conn.execute(
                    """
                    INSERT INTO payments
                      (order_id, split_no, method, subtotal, total_with_tip, tendered)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (order_id, split_no, method, subtotal, total or subtotal, tendered or total or subtotal),
                )
                payment_id = payment.lastrowid
                for row in range(start, start + 3):
                    code = receipt.get(f"B{row}")
                    qty = number(receipt.get(f"{qty_col}{row}"))
                    amount = number(receipt.get(f"{amount_col}{row}"))
                    if code and qty > 0:
                        conn.execute(
                            """
                            INSERT INTO payment_allocations
                              (payment_id, menu_code, quantity, amount)
                            VALUES (?, ?, ?, ?)
                            """,
                            (payment_id, str(code), qty, amount),
                        )
            imported += 1
        conn.execute("UPDATE menu_items SET active = 0")
        conn.commit()
    print(
        f"Archived {imported} workbook orders from {xlsx_path} into {db_path}; "
        "active event is blank."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Import Mikuna receipt workbook into SQLite.")
    parser.add_argument("xlsx", nargs="?", default="Mikuna_TheRad_20250917.xlsx")
    parser.add_argument("--db", default=str(DB_PATH))
    args = parser.parse_args()
    import_workbook(Path(args.xlsx), Path(args.db))


if __name__ == "__main__":
    main()
