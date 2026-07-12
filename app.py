from __future__ import annotations

import json
import mimetypes
import sqlite3
from datetime import date
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DB_PATH = ROOT / "mikuna.db"


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    menu_snapshot TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    archived_at TEXT
);

CREATE TABLE IF NOT EXISTS menu_items (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL CHECK (price >= 0),
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER REFERENCES events(id),
    table_no TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_code TEXT NOT NULL REFERENCES menu_items(code),
    menu_name TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL CHECK (quantity > 0),
    unit_price REAL NOT NULL CHECK (unit_price >= 0)
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    split_no INTEGER NOT NULL DEFAULT 1,
    method TEXT NOT NULL CHECK (method IN ('cash', 'paypal')),
    subtotal REAL NOT NULL CHECK (subtotal >= 0),
    total_with_tip REAL NOT NULL CHECK (total_with_tip >= 0),
    tendered REAL NOT NULL CHECK (tendered >= 0),
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payment_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    menu_code TEXT NOT NULL REFERENCES menu_items(code),
    quantity REAL NOT NULL CHECK (quantity > 0),
    amount REAL NOT NULL CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        super().__exit__(exc_type, exc_value, traceback)
        self.close()


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, factory=ClosingConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        ensure_event_state(conn)
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('opening_cash', '0')"
        )
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('actual_cash', '')"
        )


def rows(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def has_table(conn: sqlite3.Connection, table: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
        is not None
    )


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def money(value: object) -> float:
    if value in (None, ""):
        return 0.0
    return round(float(value), 2)


def active_event_id(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT value FROM settings WHERE key = 'active_event_id'"
    ).fetchone()
    if row:
        return int(row["value"])
    event = conn.execute(
        "SELECT id FROM events WHERE status = 'active' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if event:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_event_id', ?)",
            (str(event["id"]),),
        )
        return int(event["id"])
    cur = conn.execute(
        "INSERT INTO events (name, event_date, status) VALUES (?, ?, 'active')",
        (f"Mikuna {date.today().isoformat()}", date.today().isoformat()),
    )
    event_id = int(cur.lastrowid)
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_event_id', ?)",
        (str(event_id),),
    )
    return event_id


def current_menu_snapshot(conn: sqlite3.Connection) -> str:
    menu = rows(
        conn,
        """
        SELECT code, name, price, active
        FROM menu_items
        ORDER BY sort_order, code
        """,
    )
    return json.dumps(menu, separators=(",", ":"))


def ensure_event_state(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    order_columns = table_columns(conn, "orders")
    if "event_id" not in order_columns:
        conn.execute("ALTER TABLE orders ADD COLUMN event_id INTEGER")
    if "status" not in order_columns:
        conn.execute("ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'open'")
    item_columns = table_columns(conn, "order_items")
    if "menu_name" not in item_columns:
        conn.execute("ALTER TABLE order_items ADD COLUMN menu_name TEXT NOT NULL DEFAULT ''")
    conn.execute(
        """
        UPDATE order_items
        SET menu_name = COALESCE(
          NULLIF(menu_name, ''),
          (SELECT name FROM menu_items WHERE menu_items.code = order_items.menu_code),
          menu_code
        )
        WHERE menu_name = ''
        """
    )

    if conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0:
        existing_orders = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
        if existing_orders:
            cur = conn.execute(
                """
                INSERT INTO events
                  (name, event_date, status, menu_snapshot, archived_at)
                VALUES (?, ?, 'archived', ?, datetime('now', 'localtime'))
                """,
                ("Mikuna The Rad", "2025-09-17", current_menu_snapshot(conn)),
            )
            archived_id = int(cur.lastrowid)
            conn.execute(
                "UPDATE orders SET event_id = ? WHERE event_id IS NULL",
                (archived_id,),
            )
            conn.execute("UPDATE menu_items SET active = 0")
        cur = conn.execute(
            "INSERT INTO events (name, event_date, status) VALUES (?, ?, 'active')",
            (f"Mikuna {date.today().isoformat()}", date.today().isoformat()),
        )
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_event_id', ?)",
            (str(cur.lastrowid),),
        )
    else:
        active_event_id(conn)


def order_payload(conn: sqlite3.Connection, order_id: int) -> dict:
    order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not order:
        raise KeyError("Order not found")
    payload = dict(order)
    payload["items"] = rows(
        conn,
        """
        SELECT oi.id, oi.menu_code, COALESCE(NULLIF(oi.menu_name, ''), mi.name, oi.menu_code) AS name,
               oi.quantity, oi.unit_price,
               ROUND(oi.quantity * oi.unit_price, 2) AS line_total
        FROM order_items oi
        LEFT JOIN menu_items mi ON mi.code = oi.menu_code
        WHERE oi.order_id = ?
        ORDER BY oi.id
        """,
        (order_id,),
    )
    for item in payload["items"]:
        item["name"] = item["name"] or item.get("menu_name") or item["menu_code"]
    payload["payments"] = rows(
        conn,
        """
        SELECT id, split_no, method, subtotal, total_with_tip, tendered,
               ROUND(total_with_tip - subtotal, 2) AS tip,
               ROUND(tendered - total_with_tip, 2) AS change,
               note
        FROM payments
        WHERE order_id = ?
        ORDER BY split_no, id
        """,
        (order_id,),
    )
    payload["subtotal"] = round(sum(item["line_total"] for item in payload["items"]), 2)
    payload["total_with_tip"] = round(
        sum(payment["total_with_tip"] for payment in payload["payments"]), 2
    )
    payload["paid_subtotal"] = round(
        sum(payment["subtotal"] for payment in payload["payments"]), 2
    )
    payload["outstanding"] = round(payload["subtotal"] - payload["paid_subtotal"], 2)
    payload["remaining_items"] = remaining_items(conn, order_id)
    return payload


def remaining_items(conn: sqlite3.Connection, order_id: int) -> list[dict]:
    return rows(
        conn,
        """
        WITH ordered AS (
          SELECT oi.menu_code, COALESCE(NULLIF(oi.menu_name, ''), mi.name, oi.menu_code) AS name,
                 oi.unit_price, SUM(oi.quantity) AS quantity
          FROM order_items oi
          LEFT JOIN menu_items mi ON mi.code = oi.menu_code
          WHERE oi.order_id = ?
          GROUP BY oi.menu_code, name, oi.unit_price
        ),
        paid AS (
          SELECT pa.menu_code, SUM(pa.quantity) AS quantity
          FROM payment_allocations pa
          JOIN payments p ON p.id = pa.payment_id
          WHERE p.order_id = ?
          GROUP BY pa.menu_code
        )
        SELECT ordered.menu_code, ordered.name, ordered.unit_price,
               ordered.quantity,
               COALESCE(paid.quantity, 0) AS paid_quantity,
               ROUND(ordered.quantity - COALESCE(paid.quantity, 0), 2) AS remaining_quantity,
               ROUND((ordered.quantity - COALESCE(paid.quantity, 0)) * ordered.unit_price, 2) AS remaining_amount
        FROM ordered
        LEFT JOIN paid ON paid.menu_code = ordered.menu_code
        ORDER BY ordered.menu_code
        """,
        (order_id, order_id),
    )


def ticket_rows(
    conn: sqlite3.Connection,
    query: str = "",
    open_only: bool = True,
    item_filters: list[tuple[str, float]] | None = None,
    event_id: int | None = None,
) -> list[dict]:
    having = "HAVING outstanding > 0.009" if open_only else ""
    params: list[object] = []
    where_parts = []
    if event_id is None:
        event_id = active_event_id(conn)
    where_parts.append("o.event_id = ?")
    params.append(event_id)
    if query:
        where_parts.append(
            """
        (
           o.table_no LIKE ?
           OR o.note LIKE ?
           OR EXISTS (
             SELECT 1
             FROM order_items oi2
             LEFT JOIN menu_items mi2 ON mi2.code = oi2.menu_code
             WHERE oi2.order_id = o.id
               AND (
                 oi2.menu_code LIKE ?
                 OR COALESCE(NULLIF(oi2.menu_name, ''), mi2.name, oi2.menu_code) LIKE ?
               )
           )
        )
        """
        )
        like = f"%{query}%"
        params.extend([like, like, like, like])
    for code, quantity in item_filters or []:
        where_parts.append(
            """
        EXISTS (
          SELECT 1
          FROM order_items filter_items
          WHERE filter_items.order_id = o.id
            AND filter_items.menu_code = ?
          GROUP BY filter_items.order_id
          HAVING SUM(filter_items.quantity) >= ?
        )
        """
        )
        params.extend([code, quantity])
    search = "WHERE " + " AND ".join(where_parts) if where_parts else ""
    sql = f"""
        WITH totals AS (
          SELECT o.id,
                 ROUND(COALESCE(SUM(oi.quantity * oi.unit_price), 0), 2) AS ordered_subtotal
          FROM orders o
          LEFT JOIN order_items oi ON oi.order_id = o.id
          GROUP BY o.id
        ),
        paid AS (
          SELECT order_id, ROUND(COALESCE(SUM(subtotal), 0), 2) AS paid_subtotal
          FROM payments
          GROUP BY order_id
        )
        SELECT o.id, o.table_no, o.note, o.created_at,
               totals.ordered_subtotal,
               COALESCE(paid.paid_subtotal, 0) AS paid_subtotal,
               ROUND(totals.ordered_subtotal - COALESCE(paid.paid_subtotal, 0), 2) AS outstanding,
               GROUP_CONCAT(
                 oi.menu_code || ' x' || oi.quantity,
                 ', '
               ) AS items
        FROM orders o
        JOIN totals ON totals.id = o.id
        LEFT JOIN paid ON paid.order_id = o.id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        {search}
        GROUP BY o.id
        {having}
        ORDER BY o.id DESC
        LIMIT 80
    """
    return rows(conn, sql, tuple(params))


def summary(conn: sqlite3.Connection, event_id: int | None = None) -> dict:
    if event_id is None:
        event_id = active_event_id(conn)
    settings = {
        row["key"]: row["value"]
        for row in conn.execute("SELECT key, value FROM settings").fetchall()
    }
    opening_cash = money(settings.get("opening_cash", 0))
    actual_cash = settings.get("actual_cash", "")
    actual_cash_amount = money(actual_cash) if actual_cash != "" else None
    payment_rows = rows(
        conn,
        """
        SELECT
          COALESCE(SUM(subtotal), 0) AS subtotal,
          COALESCE(SUM(total_with_tip - subtotal), 0) AS tips,
          COALESCE(SUM(total_with_tip), 0) AS total,
          COALESCE(SUM(CASE WHEN method = 'cash' THEN total_with_tip ELSE 0 END), 0) AS cash_total,
          COALESCE(SUM(CASE WHEN method = 'paypal' THEN total_with_tip ELSE 0 END), 0) AS paypal_total,
          COALESCE(SUM(CASE WHEN method = 'cash' THEN tendered - total_with_tip ELSE 0 END), 0) AS cash_change
        FROM payments
        JOIN orders ON orders.id = payments.order_id
        WHERE orders.event_id = ?
        """,
        (event_id,),
    )[0]
    order_count = conn.execute(
        "SELECT COUNT(*) FROM orders WHERE event_id = ?", (event_id,)
    ).fetchone()[0]
    sold = rows(
        conn,
        """
        SELECT oi.menu_code AS code,
               COALESCE(NULLIF(oi.menu_name, ''), oi.menu_code) AS name,
               oi.unit_price AS price,
               COALESCE(SUM(oi.quantity), 0) AS quantity,
               ROUND(COALESCE(SUM(oi.quantity * oi.unit_price), 0), 2) AS revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.event_id = ?
        GROUP BY oi.menu_code, name, oi.unit_price
        ORDER BY oi.menu_code
        """,
        (event_id,),
    )
    expected_cash = opening_cash + payment_rows["cash_total"] - payment_rows["cash_change"]
    return {
        "order_count": order_count,
        "subtotal": round(payment_rows["subtotal"], 2),
        "tips": round(payment_rows["tips"], 2),
        "total": round(payment_rows["total"], 2),
        "cash_total": round(payment_rows["cash_total"], 2),
        "paypal_total": round(payment_rows["paypal_total"], 2),
        "cash_change": round(payment_rows["cash_change"], 2),
        "opening_cash": opening_cash,
        "actual_cash": actual_cash_amount,
        "expected_cash": round(expected_cash, 2),
        "cash_discrepancy": (
            round(actual_cash_amount - expected_cash, 2)
            if actual_cash_amount is not None
            else None
        ),
        "sold": sold,
    }


def event_rows(conn: sqlite3.Connection) -> list[dict]:
    return rows(
        conn,
        """
        SELECT e.id, e.name, e.event_date, e.status, e.menu_snapshot,
               COUNT(DISTINCT o.id) AS order_count,
               ROUND(COALESCE(SUM(p.total_with_tip), 0), 2) AS total,
               ROUND(COALESCE(SUM(p.total_with_tip - p.subtotal), 0), 2) AS tips
        FROM events e
        LEFT JOIN orders o ON o.event_id = e.id
        LEFT JOIN payments p ON p.order_id = o.id
        GROUP BY e.id
        ORDER BY e.event_date DESC, e.id DESC
        """,
    )


def validate_order(data: dict) -> tuple[list[dict], list[dict]]:
    items = []
    for item in data.get("items", []):
        qty = money(item.get("quantity"))
        code = str(item.get("menu_code", "")).strip()
        if code and qty > 0:
            items.append({"menu_code": code, "quantity": qty})
    if not items:
        raise ValueError("Add at least one item.")

    payments = []
    for index, payment in enumerate(data.get("payments", []), start=1):
        subtotal = money(payment.get("subtotal"))
        total = money(payment.get("total_with_tip"))
        tendered = money(payment.get("tendered"))
        method = payment.get("method") or "cash"
        if method not in ("cash", "paypal"):
            raise ValueError("Payment method must be cash or paypal.")
        if total <= 0 and subtotal <= 0 and tendered <= 0:
            continue
        if total < subtotal:
            raise ValueError("Total with tip cannot be less than subtotal.")
        if tendered < total:
            raise ValueError("Tendered cannot be less than total with tip.")
        payments.append(
            {
                "split_no": int(payment.get("split_no") or index),
                "method": method,
                "subtotal": subtotal,
                "total_with_tip": total,
                "tendered": tendered,
                "note": str(payment.get("note", "")).strip(),
                "allocations": payment.get("allocations", []),
            }
        )
    return items, payments


def create_order(conn: sqlite3.Connection, data: dict) -> int:
    table_no = str(data.get("table_no", "")).strip()
    if not table_no:
        raise ValueError("Table is required.")
    items, payments = validate_order(data)
    menu = {
        row["code"]: row
        for row in conn.execute("SELECT code, name, price FROM menu_items WHERE active = 1")
    }
    for item in items:
        if item["menu_code"] not in menu:
            raise ValueError(f"Unknown menu code: {item['menu_code']}")

    cur = conn.execute(
        "INSERT INTO orders (event_id, table_no, note) VALUES (?, ?, ?)",
        (active_event_id(conn), table_no, str(data.get("note", "")).strip()),
    )
    order_id = cur.lastrowid
    for item in items:
        conn.execute(
            """
            INSERT INTO order_items (order_id, menu_code, menu_name, quantity, unit_price)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                order_id,
                item["menu_code"],
                menu[item["menu_code"]]["name"],
                item["quantity"],
                menu[item["menu_code"]]["price"],
            ),
        )
    for payment in payments:
        cur = conn.execute(
            """
            INSERT INTO payments
              (order_id, split_no, method, subtotal, total_with_tip, tendered, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                order_id,
                payment["split_no"],
                payment["method"],
                payment["subtotal"],
                payment["total_with_tip"],
                payment["tendered"],
                payment["note"],
            ),
        )
        payment_id = cur.lastrowid
        for allocation in payment["allocations"]:
            code = str(allocation.get("menu_code", "")).strip()
            qty = money(allocation.get("quantity"))
            amount = money(allocation.get("amount"))
            if code and qty > 0 and amount >= 0 and code in menu:
                conn.execute(
                    """
                    INSERT INTO payment_allocations
                      (payment_id, menu_code, quantity, amount)
                    VALUES (?, ?, ?, ?)
                    """,
                    (payment_id, code, qty, amount),
                )
    return int(order_id)


def update_order(conn: sqlite3.Connection, order_id: int, data: dict) -> None:
    row = conn.execute("SELECT event_id FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not row:
        raise KeyError("Order not found")
    if int(row["event_id"]) != active_event_id(conn):
        raise ValueError("Only the active event can be edited.")
    table_no = str(data.get("table_no", "")).strip()
    if not table_no:
        raise ValueError("Table is required.")
    items, _ = validate_order({"items": data.get("items", []), "payments": []})
    menu = {
        row["code"]: row
        for row in conn.execute("SELECT code, name, price FROM menu_items WHERE active = 1")
    }
    for item in items:
        if item["menu_code"] not in menu:
            raise ValueError(f"Unknown menu code: {item['menu_code']}")
    conn.execute(
        "UPDATE orders SET table_no = ?, note = ? WHERE id = ?",
        (table_no, str(data.get("note", "")).strip(), order_id),
    )
    conn.execute("DELETE FROM order_items WHERE order_id = ?", (order_id,))
    for item in items:
        conn.execute(
            """
            INSERT INTO order_items (order_id, menu_code, menu_name, quantity, unit_price)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                order_id,
                item["menu_code"],
                menu[item["menu_code"]]["name"],
                item["quantity"],
                menu[item["menu_code"]]["price"],
            ),
        )


def add_payments(conn: sqlite3.Connection, order_id: int, data: dict) -> None:
    if not conn.execute("SELECT id FROM orders WHERE id = ?", (order_id,)).fetchone():
        raise KeyError("Order not found")
    _, payments = validate_order(
        {"items": [{"menu_code": "placeholder", "quantity": 1}], "payments": data.get("payments", [])}
    )
    if not payments:
        raise ValueError("Add at least one payment.")
    for payment in payments:
        cur = conn.execute(
            """
            INSERT INTO payments
              (order_id, split_no, method, subtotal, total_with_tip, tendered, note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                order_id,
                payment["split_no"],
                payment["method"],
                payment["subtotal"],
                payment["total_with_tip"],
                payment["tendered"],
                payment["note"],
            ),
        )
        payment_id = cur.lastrowid
        for allocation in payment["allocations"]:
            code = str(allocation.get("menu_code", "")).strip()
            qty = money(allocation.get("quantity"))
            amount = money(allocation.get("amount"))
            if code and qty > 0:
                conn.execute(
                    """
                    INSERT INTO payment_allocations
                      (payment_id, menu_code, quantity, amount)
                    VALUES (?, ?, ?, ?)
                    """,
                    (payment_id, code, qty, amount),
                )


def save_menu_item(conn: sqlite3.Connection, data: dict, code: str | None = None) -> dict:
    item_code = str(code or data.get("code", "")).strip().upper()
    name = str(data.get("name", "")).strip()
    price = money(data.get("price"))
    if not item_code:
        raise ValueError("Menu code is required.")
    if not name:
        raise ValueError("Menu name is required.")
    if price < 0:
        raise ValueError("Price cannot be negative.")
    max_sort = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM menu_items").fetchone()[0]
    conn.execute(
        """
        INSERT INTO menu_items (code, name, price, sort_order, active)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          price = excluded.price,
          sort_order = CASE
            WHEN menu_items.active = 0 THEN excluded.sort_order
            ELSE menu_items.sort_order
          END,
          active = 1
        """,
        (item_code, name, price, max_sort + 1),
    )
    return dict(
        conn.execute(
            "SELECT code, name, price, active FROM menu_items WHERE code = ?",
            (item_code,),
        ).fetchone()
    )


def reorder_menu_items(conn: sqlite3.Connection, codes: list[object]) -> list[dict]:
    clean_codes = []
    for code in codes:
        item_code = str(code).strip().upper()
        if item_code and item_code not in clean_codes:
            clean_codes.append(item_code)
    if not clean_codes:
        raise ValueError("No menu items to reorder.")
    active_codes = {
        row["code"]
        for row in conn.execute("SELECT code FROM menu_items WHERE active = 1").fetchall()
    }
    for item_code in clean_codes:
        if item_code not in active_codes:
            raise ValueError(f"Unknown active menu code: {item_code}")
    for sort_order, item_code in enumerate(clean_codes, start=1):
        conn.execute(
            "UPDATE menu_items SET sort_order = ? WHERE code = ?",
            (sort_order, item_code),
        )
    next_order = len(clean_codes) + 1
    for item_code in sorted(active_codes - set(clean_codes)):
        conn.execute(
            "UPDATE menu_items SET sort_order = ? WHERE code = ?",
            (next_order, item_code),
        )
        next_order += 1
    return rows(
        conn,
        """
        SELECT code, name, price, active
        FROM menu_items
        WHERE active = 1
        ORDER BY sort_order, code
        """,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "MikunaReceipts/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/menu":
            with connect() as conn:
                self.json(
                    rows(
                        conn,
                        "SELECT code, name, price, active FROM menu_items WHERE active = 1 ORDER BY sort_order, code",
                    )
                )
            return
        if parsed.path == "/api/orders":
            query = parse_qs(parsed.query)
            limit = int(query.get("limit", ["50"])[0])
            with connect() as conn:
                order_rows = rows(
                    conn,
                    """
                    SELECT o.id, o.table_no, o.note, o.created_at,
                           ROUND(COALESCE(SUM(p.total_with_tip), 0), 2) AS total_with_tip,
                           ROUND(COALESCE(SUM(p.total_with_tip - p.subtotal), 0), 2) AS tip
                    FROM orders o
                    LEFT JOIN payments p ON p.order_id = o.id
                    WHERE o.event_id = ?
                    GROUP BY o.id
                    ORDER BY o.id DESC
                    LIMIT ?
                    """,
                    (active_event_id(conn), limit),
                )
                self.json(order_rows)
            return
        if parsed.path == "/api/tickets":
            query = parse_qs(parsed.query)
            search = query.get("q", [""])[0].strip()
            open_only = query.get("open", ["1"])[0] != "0"
            item_filters: list[tuple[str, float]] = []
            for raw in query.get("item", []):
                if ":" not in raw:
                    continue
                code, raw_quantity = raw.split(":", 1)
                quantity = money(raw_quantity)
                if code.strip() and quantity > 0:
                    item_filters.append((code.strip().upper(), quantity))
            with connect() as conn:
                self.json(ticket_rows(conn, search, open_only, item_filters, active_event_id(conn)))
            return
        if parsed.path == "/api/events":
            with connect() as conn:
                self.json(event_rows(conn))
            return
        if parsed.path.startswith("/api/orders/"):
            try:
                order_id = int(parsed.path.rsplit("/", 1)[1])
                with connect() as conn:
                    self.json(order_payload(conn, order_id))
            except (ValueError, KeyError):
                self.error(HTTPStatus.NOT_FOUND, "Order not found")
            return
        if parsed.path == "/api/summary":
            with connect() as conn:
                self.json(summary(conn))
            return
        self.static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/menu/reorder":
            try:
                data = self.read_json()
                with connect() as conn:
                    menu = reorder_menu_items(conn, data.get("codes", []))
                    conn.commit()
                    self.json(menu)
            except ValueError as exc:
                self.error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if parsed.path == "/api/menu":
            try:
                data = self.read_json()
                with connect() as conn:
                    item = save_menu_item(conn, data)
                    conn.commit()
                    self.json(item, HTTPStatus.CREATED)
            except ValueError as exc:
                self.error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if parsed.path == "/api/orders":
            try:
                data = self.read_json()
                with connect() as conn:
                    order_id = create_order(conn, data)
                    conn.commit()
                    self.json(order_payload(conn, order_id), HTTPStatus.CREATED)
            except ValueError as exc:
                self.error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if parsed.path.startswith("/api/orders/") and parsed.path.endswith("/payments"):
            try:
                order_id = int(parsed.path.split("/")[3])
                data = self.read_json()
                with connect() as conn:
                    add_payments(conn, order_id, data)
                    conn.commit()
                    self.json(order_payload(conn, order_id), HTTPStatus.CREATED)
            except (ValueError, KeyError) as exc:
                self.error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if parsed.path == "/api/settings":
            data = self.read_json()
            with connect() as conn:
                for key in ("opening_cash", "actual_cash"):
                    if key in data:
                        conn.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                            (key, str(data[key])),
                        )
                conn.commit()
                self.json(summary(conn))
            return
        if parsed.path == "/api/events/start":
            data = self.read_json()
            with connect() as conn:
                current_id = active_event_id(conn)
                conn.execute(
                    """
                    UPDATE events
                    SET status = 'archived',
                        menu_snapshot = ?,
                        archived_at = datetime('now', 'localtime')
                    WHERE id = ?
                    """,
                    (current_menu_snapshot(conn), current_id),
                )
                name = str(data.get("name") or f"Mikuna {date.today().isoformat()}").strip()
                event_date = str(data.get("event_date") or date.today().isoformat()).strip()
                cur = conn.execute(
                    "INSERT INTO events (name, event_date, status) VALUES (?, ?, 'active')",
                    (name, event_date),
                )
                conn.execute("UPDATE menu_items SET active = 0")
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_event_id', ?)",
                    (str(cur.lastrowid),),
                )
                conn.commit()
                self.json({"id": cur.lastrowid, "name": name, "event_date": event_date})
            return
        self.error(HTTPStatus.NOT_FOUND, "Not found")

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/menu/"):
            code = parsed.path.rsplit("/", 1)[1]
            try:
                data = self.read_json()
                with connect() as conn:
                    item = save_menu_item(conn, data, code)
                    conn.commit()
                    self.json(item)
            except ValueError as exc:
                self.error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if parsed.path.startswith("/api/orders/"):
            try:
                order_id = int(parsed.path.rsplit("/", 1)[1])
                data = self.read_json()
                with connect() as conn:
                    update_order(conn, order_id, data)
                    conn.commit()
                    self.json(order_payload(conn, order_id))
            except (ValueError, KeyError) as exc:
                self.error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        self.error(HTTPStatus.NOT_FOUND, "Not found")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/menu/"):
            code = parsed.path.rsplit("/", 1)[1]
            with connect() as conn:
                conn.execute("UPDATE menu_items SET active = 0 WHERE code = ?", (code,))
                conn.commit()
            self.json({"ok": True})
            return
        if parsed.path.startswith("/api/orders/"):
            try:
                order_id = int(parsed.path.rsplit("/", 1)[1])
            except ValueError:
                self.error(HTTPStatus.NOT_FOUND, "Order not found")
                return
            with connect() as conn:
                conn.execute(
                    "DELETE FROM orders WHERE id = ? AND event_id = ?",
                    (order_id, active_event_id(conn)),
                )
                conn.commit()
            self.json({"ok": True})
            return
        self.error(HTTPStatus.NOT_FOUND, "Not found")

    def static(self, request_path: str) -> None:
        path = STATIC / "index.html" if request_path in ("", "/") else STATIC / request_path.lstrip("/")
        path = path.resolve()
        if not str(path).startswith(str(STATIC.resolve())) or not path.exists():
            self.error(HTTPStatus.NOT_FOUND, "Not found")
            return
        mime, _ = mimetypes.guess_type(path)
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def json(self, data: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        content = json.dumps(data, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def error(self, status: HTTPStatus, message: str) -> None:
        self.json({"error": message}, status)

    def log_message(self, fmt: str, *args: object) -> None:
        print("%s - %s" % (self.address_string(), fmt % args))


def main() -> None:
    init_db()
    server = ThreadingHTTPServer(("127.0.0.1", 8000), Handler)
    print("Serving Mikuna Receipts at http://127.0.0.1:8000")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
