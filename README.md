# Mikuna Tickets

Small local ticketing app for Mikuna pop-up events. It runs as a single Python process, stores data in SQLite, and uses a browser UI for order entry, split payments, open-ticket search, menu setup, venue table layouts, totals, and past events.

## Requirements

- Python 3.10 or newer
- No Python packages to install
- No build step

## First Run On A New PC

```powershell
git clone https://github.com/VersBersh/mikuna-tickets.git
cd mikuna-tickets
python app.py
```

Open:

```text
http://127.0.0.1:8000
```

The app creates `mikuna.db` automatically on first run. That file is your local event data and is intentionally not committed.

## Event Setup

1. Open an event on the `Events` tab, optionally at a venue. Pick `New venue…` in the venue list to name a venue and lay out its tables, or `Edit layout` next to the list to change one.
2. Open the `Menu` tab.
3. Add today’s menu codes, item names, and prices.
4. Use the `Tickets` tab to take orders. It shows the venue's tables: click a free table to start its ticket, or a highlighted table (with the amount due) to add items, take payment or move it to another table. Each table has at most one open ticket. `Ticket without table` is for the bar, takeaway or a name. Without a venue, tickets go by a typed table or name.
5. Search, item filters and paid tickets are beside and below the grid. Matching tables are highlighted.
6. Use `Totals` for sales and cash tracking.

Item filters on the `Tickets` tab are minimum matches. For example, `CV = 1` finds any open ticket with at least one `CV`; combining `CV = 1` and `DS = 1` finds tickets that have both.

## Workbook Import

The original Excel workbook is not committed. If you have a local workbook and want to archive it into the SQLite database:

```powershell
python import_xlsx.py path\to\workbook.xlsx
```

Importing archives the workbook orders as a past event and leaves the active event blank.

## Files Not Committed

- `*.xlsx` workbooks
- `mikuna.db`
- Python cache files

To start from a completely fresh local database, stop the app, delete `mikuna.db`, and run `python app.py` again.
