const state = {
  menu: [],
  quantities: {},
  ticketFilters: {},
  splitCount: 0,
  currentTicket: null,
  openTickets: [],
  dirty: false,
  autosaveTimer: null,
  autosaveInFlight: false,
  menuSaveTimers: {},
  editingPaymentId: null,
  ticketMode: "edit",
  ticketModeId: null,
  // Quantities on the ticket when it was opened, so this visit's changes can be shown separately.
  openedQuantities: {},
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (value) => Number(value || 0);
const fmt = (value) => `\u20ac${money(value).toFixed(2)}`;
const fmtQty = (value) => {
  const rounded = Math.round(money(value) * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function setStatus(text) {
  $("#status").textContent = text;
}

function markFieldInvalid(input, message, { focus = true } = {}) {
  input.classList.add("invalid");
  input.setCustomValidity(message);
  setStatus(message);
  if (focus) {
    input.focus();
    input.reportValidity();
  }
}

function clearFieldInvalid(input) {
  input.classList.remove("invalid");
  input.setCustomValidity("");
}

function selectInputValue(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.disabled || input.type !== "number") {
    return;
  }
  window.setTimeout(() => input.select(), 0);
}

async function switchView(view) {
  const activeView = $(".view.active")?.id.replace("view-", "");
  if (view === "order" && state.currentTicket) {
    const saved = await flushAutosave();
    if (!saved) return;
  }
  if (activeView === "order" && view !== "order") {
    const saved = await flushAutosave();
    if (!saved) return;
  }
  if (view === "order") {
    state.currentTicket = null;
    clearOrder({ keepTicketTabs: true });
  }
  if (view === "tickets" && activeView !== "tickets") clearTicketFilters();
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `view-${view}`));
  renderTicketTabs();
}

function setTableLocked(locked) {
  const value = $("#tableNo").value.trim();
  const lock = locked && Boolean(value);
  $("#tableEdit").classList.toggle("hidden", lock);
  $("#tableLocked").classList.toggle("hidden", !lock);
  $("#tableLockedText").textContent = lock ? tableLabel(value) : "";
}

async function checkTableClash() {
  const notice = $("#tableClash");
  const value = $("#tableNo").value.trim();
  if (state.currentTicket || !value) {
    notice.classList.add("hidden");
    return;
  }
  try {
    const tickets = await api(`/api/tickets?q=${encodeURIComponent(value)}&open=1`);
    // Ignore the answer if the table or the order changed while it was in flight.
    if (state.currentTicket || $("#tableNo").value.trim() !== value) return;
    const matches = tickets.filter((ticket) => ticket.table_no.trim().toLowerCase() === value.toLowerCase());
    notice.classList.toggle("hidden", matches.length === 0);
    if (!matches.length) return;
    const latest = matches.reduce((a, b) => (b.id > a.id ? b : a));
    notice.dataset.ticketId = latest.id;
    $("#tableClashText").textContent = matches.length === 1
      ? `${tableLabel(latest.table_no)} already has an open ticket (${fmt(latest.outstanding)} due).`
      : `${tableLabel(latest.table_no)} already has ${matches.length} open tickets.`;
    $("#openClash").textContent = matches.length === 1 ? "Open that ticket" : "Open the latest";
  } catch {
    notice.classList.add("hidden");
  }
}

async function openClashingTicket() {
  const id = Number($("#tableClash").dataset.ticketId);
  if (!id) return;
  // Carry anything already picked on this new order over to the existing ticket.
  const draft = Object.entries(state.quantities).filter(([, quantity]) => quantity > 0);
  clearOrder();
  await openTicketTab(id);
  if (!draft.length || state.currentTicket?.id !== id) return;
  draft.forEach(([code, quantity]) => {
    state.quantities[code] = (state.quantities[code] || 0) + quantity;
  });
  renderMenuPicker();
  markDirty({ schedule: true });
  setStatus(`Added ${draft.length} ${draft.length === 1 ? "item" : "items"} to ${tableLabel(state.currentTicket.table_no)}`);
}

function editTable() {
  setTableLocked(false);
  const input = $("#tableNo");
  input.focus();
  input.select();
}

function clearTicketFilters() {
  state.ticketFilters = {};
  state.menu.forEach((item) => { state.ticketFilters[item.code] = 0; });
  $("#ticketSearch").value = "";
  renderTicketFilters();
  renderTickets();
}

function markDirty({ schedule = false } = {}) {
  state.dirty = true;
  if (schedule && state.currentTicket) {
    scheduleAutosave();
  }
}

function scheduleAutosave() {
  window.clearTimeout(state.autosaveTimer);
  state.autosaveTimer = window.setTimeout(() => {
    saveCurrentWork({ clearAfter: false, autosave: true, includePayments: false });
  }, 1200);
}

function stopAutosaveTimer() {
  window.clearTimeout(state.autosaveTimer);
  state.autosaveTimer = null;
}

function renderTicketTabs() {
  const orderViewActive = $("#view-order")?.classList.contains("active");
  $("#ticketTabs").innerHTML = state.openTickets.map((ticket) => `
    <span class="ticket-tab-wrap ${orderViewActive && state.currentTicket?.id === ticket.id ? "active" : ""} ${ticket.outstanding <= 0.009 ? "settled" : "open-ticket"}">
      <button
        class="tab ticket-tab"
        data-ticket-tab="${ticket.id}"
        type="button"
      >
        #${ticket.id} ${ticket.table_no}
        <span>${fmt(ticket.outstanding)}</span>
      </button>
      <button
        class="ticket-tab-close"
        data-close-ticket-tab="${ticket.id}"
        type="button"
        title="Close ticket tab"
        aria-label="Close ticket tab"
      >&times;</button>
    </span>
  `).join("");
  $$("[data-ticket-tab]").forEach((button) => {
    button.addEventListener("click", () => openTicketTab(Number(button.dataset.ticketTab)));
  });
  $$("[data-close-ticket-tab]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      requestCloseTicketTab(button.dataset.closeTicketTab);
    });
  });
}

function upsertTicketTab(ticket) {
  const tab = {
    id: ticket.id,
    table_no: ticket.table_no,
    outstanding: ticket.outstanding,
  };
  const index = state.openTickets.findIndex((open) => open.id === ticket.id);
  if (index >= 0) {
    state.openTickets[index] = tab;
  } else {
    state.openTickets.push(tab);
  }
  renderTicketTabs();
}

function closeTicketTab(ticketId) {
  state.openTickets = state.openTickets.filter((ticket) => ticket.id !== Number(ticketId));
  if (state.currentTicket?.id === Number(ticketId)) {
    state.currentTicket = null;
    clearOrder({ keepTicketTabs: true });
  } else {
    renderTicketTabs();
  }
}

async function requestCloseTicketTab(ticketId) {
  if (state.currentTicket?.id === Number(ticketId)) {
    const saved = await flushAutosave();
    if (!saved) return;
  }
  closeTicketTab(ticketId);
}

function activeItems() {
  return state.menu
    .map((item) => ({
      code: item.code,
      name: item.name,
      price: item.price,
      quantity: state.quantities[item.code] || 0,
    }))
    .filter((item) => item.quantity > 0);
}

function ticketItemByCode(code) {
  return state.currentTicket?.items?.find((item) => item.menu_code === code);
}

function remainingItemByCode(code) {
  return state.currentTicket?.remaining_items?.find((item) => item.menu_code === code);
}

function payableItems() {
  if (!state.currentTicket) return activeItems();
  return state.menu
    .map((item) => {
      const orderedQuantity = state.quantities[item.code] || 0;
      const remaining = remainingItemByCode(item.code);
      const existing = ticketItemByCode(item.code);
      const paidQuantity = remaining ? remaining.paid_quantity : 0;
      const quantity = Math.max(0, orderedQuantity - paidQuantity);
      return {
        code: item.code,
        name: existing?.name || item.name,
        price: existing?.unit_price || item.price,
        quantity,
      };
    })
    .filter((item) => item.quantity > 0);
}

function activeSubtotal() {
  return payableItems().reduce((sum, item) => sum + item.quantity * item.price, 0);
}

function billSubtotal() {
  return state.menu.reduce((sum, item) => {
    const existing = ticketItemByCode(item.code);
    const quantity = state.quantities[item.code] || 0;
    const price = existing?.unit_price || item.price;
    return sum + quantity * price;
  }, 0);
}

function renderMenuPicker() {
  const list = $("#menuList");
  list.innerHTML = "";
  $("#orderTitle").textContent = state.currentTicket ? `Ticket #${state.currentTicket.id}` : "New order";
  $("#saveAction").classList.toggle("hidden", Boolean(state.currentTicket));
  $("#clearOrder").classList.toggle("hidden", Boolean(state.currentTicket));
  applyTicketMode();
  $("#addSplit").classList.toggle("hidden", Boolean(state.currentTicket && state.currentTicket.outstanding <= 0.009));
  $$(".new-only").forEach((node) => node.classList.remove("hidden"));
  if (state.currentTicket) {
    $("#ticketBanner").classList.remove("hidden");
    $("#ticketBanner").classList.toggle("settled", state.currentTicket.outstanding <= 0.009);
    $("#ticketBanner").classList.toggle("open-ticket", state.currentTicket.outstanding > 0.009);
    $("#ticketBanner").innerHTML = `${fmt(state.currentTicket.outstanding)} remaining · ${state.currentTicket.outstanding <= 0.009 ? "Settled" : "Open"} · ${state.currentTicket.note || "No note"}`;
  } else {
    $("#ticketBanner").classList.add("hidden");
    $("#ticketBanner").classList.remove("settled", "open-ticket");
  }
  state.menu.filter((item) => item.active).forEach((item) => {
    const existing = ticketItemByCode(item.code);
    const row = document.createElement("div");
    row.className = `menu-row ${item.category === "food" ? "food" : ""}`;
    row.dataset.search = `${item.code} ${item.name}`.toLowerCase();
    row.innerHTML = `
      <div><strong>${item.name}</strong><span>${item.code}</span><span>${fmt(existing?.unit_price || item.price)}</span></div>
      <div class="qty-control">
        <button type="button" data-step="-1">-</button>
        <input type="number" min="0" step="1" value="${state.quantities[item.code] || 0}">
        <button type="button" data-step="1">+</button>
      </div>
    `;
    const input = $("input", row);
    input.addEventListener("input", () => {
      state.quantities[item.code] = Math.max(0, money(input.value));
      renderSplits();
      recalc();
      markDirty({ schedule: Boolean(state.currentTicket) });
    });
    $$("button", row).forEach((button) => {
      button.addEventListener("click", () => {
        const next = Math.max(0, (state.quantities[item.code] || 0) + Number(button.dataset.step));
        state.quantities[item.code] = next;
        input.value = next;
        renderSplits();
        recalc();
        markDirty({ schedule: Boolean(state.currentTicket) });
      });
    });
    list.appendChild(row);
  });
  filterMenuPicker();
  renderSplits();
  recalc();
}

function filterMenuPicker() {
  const terms = $("#menuSearch").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = $$(".menu-row", $("#menuList"));
  let visible = 0;
  rows.forEach((row) => {
    const match = terms.every((term) => row.dataset.search.includes(term));
    row.classList.toggle("hidden", !match);
    if (match) visible += 1;
  });
  $("#menuSearchEmpty").classList.toggle("hidden", visible > 0 || rows.length === 0);
}

function applyTicketMode() {
  const ticket = state.currentTicket;
  const paying = Boolean(ticket) && state.ticketMode === "pay";
  $("#ticketSurface").classList.toggle("hidden", paying);
  $("#orderSummary").classList.toggle("hidden", paying);
  $("#paymentSurface").classList.toggle("hidden", !paying);
  $("#payAction").classList.toggle("hidden", !ticket || paying);
  if (!ticket) return;
  const settled = ticket.outstanding <= 0.009;
  $("#payAction").textContent = settled ? "Payments" : `Pay ${fmt(ticket.outstanding)}`;
  const itemCount = ticket.items.reduce((sum, item) => sum + money(item.quantity), 0);
  $("#paySummary").classList.toggle("settled", settled);
  $("#paySummary").classList.toggle("open-ticket", !settled);
  $("#paySummary").innerHTML = `<strong>${ticket.table_no}</strong> · ${fmtQty(itemCount)} ${itemCount === 1 ? "item" : "items"} · ${settled ? "Settled" : `${fmt(ticket.outstanding)} remaining`}`;
}

async function setTicketMode(mode) {
  if (mode === "pay") {
    const saved = await flushAutosave();
    if (!saved || !state.currentTicket) return;
  }
  state.ticketMode = mode;
  applyTicketMode();
  window.scrollTo({ top: 0 });
}

function renderFinalizedSplits() {
  const root = $("#splits");
  if (!root) return;
  $$(".final-split", root).forEach((node) => node.remove());
  const ticket = state.currentTicket;
  if (!ticket) return;
  const payments = ticket.payments || [];
  const rows = payments
    .filter((payment) => Number(payment.id) !== Number(state.editingPaymentId))
    .map((payment) => {
      const type = payment.split_type === "percent" ? `${fmtQty(payment.split_percent)}%` : "Items";
      const row = document.createElement("div");
      row.className = "final-split";
      row.innerHTML = `
        <div class="final-split-main">
          <div>
            <strong>Split ${payment.split_no} · ${type} · ${payment.method === "paypal" ? "PayPal" : "Cash"}</strong>
            <span>${fmt(payment.subtotal)} due · ${fmt(payment.tip)} tip · ${fmt(payment.tendered)} tendered · ${fmt(payment.change)} change</span>
          </div>
          <div class="final-split-actions">
            <strong>${fmt(payment.total_with_tip)}</strong>
            <button data-edit-payment="${payment.id}" type="button">Edit</button>
          </div>
        </div>
      `;
      $("[data-edit-payment]", row).addEventListener("click", () => editSavedPayment(payment.id));
      return row;
    });
  rows.reverse().forEach((row) => root.prepend(row));
}

function renderTicketFilters() {
  const root = $("#ticketFilters");
  root.innerHTML = "";
  state.menu.filter((item) => item.active && item.category === "food").forEach((item) => {
    const row = document.createElement("div");
    row.className = "filter-row";
    row.innerHTML = `
      <div><strong>${item.code}</strong><span>${item.name}</span></div>
      <div class="qty-control">
        <button type="button" data-step="-1">-</button>
        <input type="number" min="0" step="1" value="${state.ticketFilters[item.code] || 0}" aria-label="${item.code} search quantity">
        <button type="button" data-step="1">+</button>
      </div>
    `;
    const input = $("input", row);
    input.addEventListener("input", () => {
      state.ticketFilters[item.code] = Math.max(0, money(input.value));
      updateTicketFilterSummary();
      renderTickets();
    });
    $$("button", row).forEach((button) => {
      button.addEventListener("click", () => {
        const next = Math.max(0, (state.ticketFilters[item.code] || 0) + Number(button.dataset.step));
        state.ticketFilters[item.code] = next;
        input.value = next;
        updateTicketFilterSummary();
        renderTickets();
      });
    });
    root.appendChild(row);
  });
  updateTicketFilterSummary();
}

function updateTicketFilterSummary() {
  const active = state.menu
    .filter((item) => item.active && item.category === "food" && state.ticketFilters[item.code] > 0)
    .map((item) => `${item.code} ×${fmtQty(state.ticketFilters[item.code])}`);
  const summary = $("#ticketFilterSummary");
  summary.textContent = active.join(" · ");
  summary.classList.toggle("hidden", active.length === 0);
  $("#filterPanel").classList.toggle("has-filters", active.length > 0);
}

function setTicketFiltersCollapsed(collapsed) {
  $("#filterPanel").classList.toggle("collapsed", collapsed);
  $("#toggleTicketFilters").setAttribute("aria-expanded", String(!collapsed));
  try {
    localStorage.setItem("ticketFiltersCollapsed", collapsed ? "1" : "0");
  } catch {
    // Storage can be unavailable; the panel just won't remember its state.
  }
}

function addSplit(markAsDirty = true, payment = null) {
  state.splitCount += 1;
  const node = $("#splitTemplate").content.firstElementChild.cloneNode(true);
  node.dataset.split = state.splitCount;
  node.classList.add("editable-split");
  const splitNo = payment?.split_no || ((state.currentTicket?.payments || []).length + state.splitCount);
  node.dataset.splitNo = splitNo;
  if (payment) {
    node.dataset.paymentId = payment.id;
    node.dataset.paymentAllocations = JSON.stringify(payment.allocations || []);
  }
  $("strong", node).textContent = payment ? `Split ${splitNo} (editing)` : `Split ${splitNo}`;
  // Only splits someone has interacted with count as payment drafts; a pre-filled split is just a suggestion.
  node.addEventListener("input", () => touchSplit(node), true);
  $(".remove-split", node).addEventListener("click", async () => {
    if (payment) {
      if (!confirm("Remove this saved split?")) return;
      try {
        const ticket = await api(`/api/payments/${payment.id}`, { method: "DELETE" });
        state.currentTicket = ticket;
        state.editingPaymentId = null;
        state.dirty = false;
        upsertTicketTab(ticket);
        loadTicketIntoForm(ticket);
        await refreshAll();
        setStatus(`Removed split ${payment.split_no}`);
      } catch (error) {
        setStatus(error.message);
      }
      return;
    }
    node.remove();
    renderSplits();
    recalc();
    markDirty();
  });
  $(".fill-split", node).addEventListener("click", () => {
    touchSplit(node);
    renderAllocations(node);
    payableItemsForSplit(node).forEach((item) => {
      const input = $(`.allocation input[data-code="${item.code}"]`, node);
      if (input) input.value = fmtQty(item.quantity);
    });
    syncSplitAmountsToDue(node);
    renderFollowingAllocations(node);
    recalc();
    markDirty();
  });
  $(".save-split", node).addEventListener("click", () => saveSplit(node));
  $$(".mode-seg button", node).forEach((button) => {
    button.addEventListener("click", () => {
      if (splitMode(node) === button.dataset.mode) return;
      touchSplit(node);
      setSplitMode(node, button.dataset.mode);
      syncSplitAmountsToDue(node);
      renderFollowingAllocations(node);
      recalc();
      markDirty();
    });
  });
  $$(".method-seg button", node).forEach((button) => {
    button.addEventListener("click", () => {
      touchSplit(node);
      setSplitMethod(node, button.dataset.method);
      recalc();
      markDirty();
    });
  });
  $$(".split-total, .split-tendered", node).forEach((input) => {
    input.addEventListener("input", () => {
      input.classList.remove("invalid");
      showSplitError(node, "");
      recalc();
      markDirty();
    });
  });
  $(".split-percent", node).addEventListener("input", () => {
    syncSplitAmountsToDue(node);
    renderFollowingAllocations(node);
    recalc();
    markDirty();
  });
  $(".split-percent", node).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      syncSplitAmountsToDue(node);
      renderFollowingAllocations(node);
      recalc();
      markDirty();
    }
  });
  $("#splits").appendChild(node);
  setSplitMode(node, payment?.split_type || "items");
  setSplitMethod(node, payment?.method || "cash");
  if (payment) {
    $(".split-percent", node).value = payment.split_percent || "";
    $(".split-total", node).value = money(payment.total_with_tip).toFixed(2);
    const exact = Math.abs(money(payment.tendered) - money(payment.total_with_tip)) < 0.005;
    $(".split-tendered", node).value = exact ? "" : money(payment.tendered).toFixed(2);
  }
  renderAllocations(node);
  if (!payment) syncSplitAmountsToDue(node);
  if (payment?.split_type === "items") {
    (payment.allocations || []).forEach((allocation) => {
      const input = $(`.allocation input[data-code="${allocation.menu_code}"]`, node);
      if (input) input.value = fmtQty(allocation.quantity);
    });
  }
  recalc();
  if (markAsDirty) markDirty();
}

function editSavedPayment(paymentId) {
  if (paymentPayloads().length && !confirm("Discard the current unsaved split draft?")) return;
  const payment = state.currentTicket?.payments?.find((row) => Number(row.id) === Number(paymentId));
  if (!payment) return;
  state.editingPaymentId = payment.id;
  $$(".editable-split").forEach((node) => node.remove());
  renderFinalizedSplits();
  addSplit(false, payment);
  recalc();
}

function splitMode(split) {
  return $(".split-mode", split)?.value || "items";
}

function touchSplit(split) {
  if (split.dataset.touched) return;
  split.dataset.touched = "1";
}

function setSplitMethod(split, method) {
  $(".method", split).value = method;
  $$(".method-seg button", split).forEach((button) => {
    button.classList.toggle("on", button.dataset.method === method);
  });
  $$(".cash-only", split).forEach((node) => node.classList.toggle("hidden", method !== "cash"));
}

function setSplitMode(split, mode) {
  $(".split-mode", split).value = mode;
  split.dataset.mode = mode;
  $$(".mode-seg button", split).forEach((button) => {
    button.classList.toggle("on", button.dataset.mode === mode);
  });
  $(".percent-field", split).classList.toggle("hidden", mode !== "percent");
  $(".fill-split", split).classList.toggle("hidden", mode !== "items");
  renderAllocations(split);
}

function renderSplits() {
  if (!state.currentTicket) {
    $("#splits").innerHTML = "";
    return;
  }
  renderFinalizedSplits();
  const splits = $$(".editable-split");
  if (splits.length === 0 && state.currentTicket.outstanding > 0.009) addSplit(false);
  $$(".editable-split").forEach(renderAllocations);
}

function renderAllocations(split) {
  const allocations = $(".allocations", split);
  if (splitMode(split) === "percent") {
    allocations.innerHTML = `<div class="empty">Percent split applies to the whole bill.</div>`;
    return;
  }
  const previous = Object.fromEntries(
    $$(".allocation input", split).map((input) => [input.dataset.code, input.value])
  );
  const items = payableItemsForSplit(split);
  allocations.innerHTML = items.length
    ? items.map((item) => {
      const value = money(previous[item.code]);
      return `
        <div class="allocation">
          <div><strong>${item.name}</strong><span>${item.code}</span><span>${fmt(item.price)}</span></div>
          <div class="qty-control">
            <button type="button" data-step="-1" aria-label="Less ${item.code}">-</button>
            <input data-code="${item.code}" data-price="${item.price}" type="number" min="0" max="${item.quantity}" step="0.01" value="${fmtQty(value)}" aria-label="${item.code} quantity">
            <button type="button" data-step="1" aria-label="More ${item.code}">+</button>
            <span class="of">of ${fmtQty(item.quantity)}</span>
          </div>
          <small class="allocation-status hidden"></small>
        </div>
      `;
    }).join("")
    : `<div class="empty">${state.currentTicket?.items?.length ? "Nothing left to split." : "Add items before taking payment."}</div>`;
  $$(".allocation", allocations).forEach((row) => {
    const input = $("input", row);
    const changed = () => {
      updateAllocationFeedback(input);
      renderFollowingAllocations(split);
      recalc();
      markDirty();
    };
    updateAllocationFeedback(input);
    input.addEventListener("input", changed);
    $$("button", row).forEach((button) => {
      button.addEventListener("click", () => {
        touchSplit(split);
        const next = Math.min(money(input.max), Math.max(0, Math.round(money(input.value)) + Number(button.dataset.step)));
        input.value = fmtQty(next);
        changed();
      });
    });
  });
}

function updateAllocationFeedback(input) {
  const row = input.closest(".allocation");
  const entered = money(input.value);
  const available = money(input.max);
  const overBy = entered - available;
  const status = $(".allocation-status", row);
  row.classList.toggle("overcount", overBy > 0.009);
  row.classList.toggle("none", entered <= 0);
  status.classList.toggle("hidden", overBy <= 0.009);
  status.textContent = overBy > 0.009 ? `Only ${fmtQty(available)} left - over by ${fmtQty(overBy)}` : "";
}

function renderFollowingAllocations(split) {
  let afterCurrent = false;
  for (const row of $$(".editable-split")) {
    if (afterCurrent) renderAllocations(row);
    if (row === split) afterCurrent = true;
  }
}

function payableItemsForSplit(split) {
  const usedBefore = editableAllocationsBefore(split);
  const items = draftBasePayableItems().map((item) => ({
    ...item,
    quantity: Math.max(0, item.quantity - money(usedBefore[item.code])),
  }));
  return items.filter((item) => item.quantity > 0);
}

function editableAllocationsBefore(split) {
  const used = {};
  const baseItems = draftBasePayableItems();
  for (const row of $$(".editable-split")) {
    if (row === split) break;
    if (splitMode(row) === "items") {
      splitAllocations(row).forEach((allocation) => {
        used[allocation.menu_code] = money(used[allocation.menu_code]) + money(allocation.quantity);
      });
    } else {
      const ratio = Math.max(0, money($(".split-percent", row).value)) / 100;
      baseItems.forEach((item) => {
        used[item.code] = money(used[item.code]) + item.quantity * ratio;
      });
    }
  }
  return used;
}

function draftBasePayableItems() {
  const items = payableItems().map((item) => ({ ...item }));
  const payment = state.currentTicket?.payments?.find((row) => Number(row.id) === Number(state.editingPaymentId));
  if (!payment) return items;
  if (payment.split_type === "items") {
    (payment.allocations || []).forEach((allocation) => {
      addQuantityToItems(items, allocation.menu_code, money(allocation.quantity));
    });
  } else {
    const ratio = Math.max(0, money(payment.split_percent)) / 100;
    (state.currentTicket?.items || []).forEach((item) => {
      addQuantityToItems(items, item.menu_code, money(item.quantity) * ratio);
    });
  }
  return items;
}

function addQuantityToItems(items, code, quantity) {
  const existing = items.find((item) => item.code === code);
  if (existing) {
    existing.quantity += quantity;
    return;
  }
  const ordered = ticketItemByCode(code);
  const menuItem = state.menu.find((item) => item.code === code);
  items.push({
    code,
    name: ordered?.name || menuItem?.name || code,
    price: ordered?.unit_price || menuItem?.price || 0,
    quantity,
  });
}

function splitData(row, index) {
  const mode = splitMode(row);
  const allocations = mode === "items" ? splitAllocations(row) : [];
  return {
    split_no: Number(row.dataset.splitNo || index + 1),
    payment_id: row.dataset.paymentId ? Number(row.dataset.paymentId) : null,
    split_type: mode,
    split_percent: mode === "percent" ? Math.max(0, money($(".split-percent", row).value)) : 0,
    method: $(".method", row).value,
    subtotal: splitSubtotal(row),
    total_with_tip: money($(".split-total", row).value),
    tendered: splitTendered(row),
    allocations,
  };
}

async function saveSplit(row) {
  if (!state.currentTicket) return;
  if (!validateTicketForSave()) return;
  const payment = splitData(row, Number(row.dataset.splitNo || 1) - 1);
  if (payment.subtotal <= 0.004) {
    showSplitError(row, "Add something to this split before saving.");
    return;
  }
  if (payment.tendered < payment.total_with_tip) {
    const tendered = $(".split-tendered", row);
    tendered.classList.add("invalid");
    tendered.focus();
    showSplitError(row, `Tendered ${fmt(payment.tendered)} is less than the total ${fmt(payment.total_with_tip)}. Raise it, or clear it for exact money.`);
    return;
  }
  showSplitError(row, "");
  try {
    const ticket = await savePaymentPayloads([payment], state.currentTicket);
    state.currentTicket = ticket;
    state.editingPaymentId = null;
    state.dirty = false;
    setStatus(`Saved split ${payment.split_no}`);
    upsertTicketTab(ticket);
    loadTicketIntoForm(ticket);
    await refreshAll();
  } catch (error) {
    showSplitError(row, error.message);
  }
}

function showSplitError(row, message) {
  const box = $(".split-error", row);
  box.textContent = message;
  box.classList.toggle("hidden", !message);
  if (message) setStatus(message);
}

function splitAllocations(row) {
  return $$(".allocation input", row)
    .map((input) => ({
      menu_code: input.dataset.code,
      quantity: Math.min(money(input.value), money(input.max)),
      amount: Math.min(money(input.value), money(input.max)) * money(input.dataset.price),
    }))
    .filter((item) => item.quantity > 0);
}

function splitSubtotal(row) {
  if (splitMode(row) === "percent") {
    return billSubtotal() * Math.max(0, money($(".split-percent", row).value)) / 100;
  }
  return splitAllocations(row).reduce((sum, item) => sum + item.amount, 0);
}

function syncSplitAmountsToDue(row) {
  const subtotal = splitSubtotal(row);
  $(".split-total", row).value = subtotal.toFixed(2);
  row.dataset.lastSubtotal = subtotal;
}

function splitTendered(row) {
  // Blank tendered means exact money; PayPal is always exact.
  const raw = $(".split-tendered", row).value;
  if ($(".method", row).value === "paypal" || raw === "") return money($(".split-total", row).value);
  return money(raw);
}

function renderOrderSummary() {
  // On an open ticket, show what was there when it was opened, then this visit's changes as
  // separate green (added) or red (removed) lines. Reopening the ticket folds them together.
  const opened = state.currentTicket ? state.openedQuantities : {};
  const lines = [];
  const changes = [];
  state.menu.forEach((item) => {
    const quantity = state.quantities[item.code] || 0;
    const before = state.currentTicket ? opened[item.code] || 0 : quantity;
    const price = ticketItemByCode(item.code)?.unit_price || item.price;
    if (before > 0) lines.push({ item, quantity: before, price });
    if (quantity !== before) changes.push({ item, quantity: quantity - before, price });
  });
  const total = state.menu.reduce((sum, item) => {
    const price = ticketItemByCode(item.code)?.unit_price || item.price;
    return sum + (state.quantities[item.code] || 0) * price;
  }, 0);
  const count = state.menu.reduce((sum, item) => sum + (state.quantities[item.code] || 0), 0);
  const line = ({ item, quantity, price }, kind = "") => `
    <li class="${kind || (item.category === "food" ? "food" : "")}">
      <span class="qty">${quantity > 0 && kind ? "+" : ""}${fmtQty(quantity)}&times;</span>
      <span class="name">${item.name}</span>
      <span class="amount">${fmt(quantity * price)}</span>
    </li>
  `;
  const changeLines = changes.map((change) => line(change, change.quantity > 0 ? "added" : "removed")).join("");
  $("#orderSummaryCount").textContent = count ? `${fmtQty(count)} ${count === 1 ? "item" : "items"}` : "";
  $("#orderSummaryLines").innerHTML = lines.length || changes.length
    ? lines.map((entry) => line(entry)).join("")
      + (lines.length && changes.length ? `<li class="change-head">Added now</li>` : "")
      + changeLines
    : `<li class="none">Nothing added yet</li>`;
  $("#orderSummaryTotal").textContent = fmt(total);
}

function recalc() {
  renderOrderSummary();
  const itemSub = draftBaseSubtotal();
  let draftSubtotal = 0;
  let tip = 0;
  let totalWithTip = 0;
  const splits = $$(".editable-split");
  splits.forEach((row) => {
    const subtotal = splitSubtotal(row);
    const totalInput = $(".split-total", row);
    const tenderedInput = $(".split-tendered", row);
    if (!row.dataset.touched && !row.dataset.paymentId) {
      totalInput.value = subtotal.toFixed(2);
    } else if (row.dataset.lastSubtotal !== undefined && !totalInput.matches(":focus")) {
      // Items changed after a total was typed: keep the tip, move the total with the subtotal.
      const delta = subtotal - money(row.dataset.lastSubtotal);
      if (Math.abs(delta) > 0.004) totalInput.value = Math.max(0, money(totalInput.value) + delta).toFixed(2);
    }
    row.dataset.lastSubtotal = subtotal;
    if (money(totalInput.value) < subtotal && !totalInput.matches(":focus")) totalInput.value = subtotal.toFixed(2);
    const splitTotal = money(totalInput.value);
    const splitTip = splitTotal - subtotal;
    const splitChange = Math.max(0, splitTendered(row) - splitTotal);
    tenderedInput.placeholder = splitTotal.toFixed(2);
    $(".split-due", row).textContent = fmt(subtotal);
    $(".split-tip", row).textContent = fmt(splitTip);
    $(".split-change", row).textContent = fmt(splitChange);
    $(".save-split", row).textContent = row.dataset.paymentId ? "Save changes" : "Done";
    const nothingSelected = subtotal <= 0.004;
    $(".save-split", row).disabled = nothingSelected;
    $(".save-split", row).title = nothingSelected ? (splitMode(row) === "percent" ? "Enter a percentage first" : "Select items first") : "";
    $(".remove-split", row).classList.toggle("hidden", splits.length < 2 && !row.dataset.paymentId);
    draftSubtotal += subtotal;
    tip += splitTip;
    totalWithTip += splitTotal;
  });
  $("#orderSubtotal").textContent = fmt(itemSub);
  $("#orderRemainingAfterDraft").textContent = fmt(Math.max(0, itemSub - draftSubtotal));
  $("#orderTips").textContent = fmt(tip);
  $("#orderTotal").textContent = fmt(totalWithTip);
  $("#paymentTotals").classList.toggle("hidden", splits.length < 2);
}

function draftBaseSubtotal() {
  const editedSubtotal = $$(".editable-split")
    .map((row) => row.dataset.paymentId ? savedPaymentSubtotal(row.dataset.paymentId) : 0)
    .reduce((sum, value) => sum + value, 0);
  return activeSubtotal() + editedSubtotal;
}

function savedPaymentSubtotal(paymentId) {
  const payment = state.currentTicket?.payments?.find((row) => Number(row.id) === Number(paymentId));
  return money(payment?.subtotal);
}

function orderPayload() {
  return {
    table_no: $("#tableNo").value.trim(),
    note: $("#orderNote").value.trim(),
    items: activeItems().map((item) => ({ menu_code: item.code, quantity: item.quantity })),
    payments: state.currentTicket ? paymentPayloads() : [],
  };
}

function paymentPayloads() {
  if (!state.currentTicket) return [];
  return $$(".editable-split")
    .filter((row) => row.dataset.touched)
    .map(splitData)
    .filter((payment) => payment.subtotal > 0 || payment.total_with_tip > 0);
}

function hasTicketDraft() {
  return $("#tableNo").value.trim() && activeItems().length > 0;
}

function validateTicketForSave() {
  const tableInput = $("#tableNo");
  clearFieldInvalid(tableInput);
  if (!tableInput.value.trim()) {
    setTableLocked(false);
    markFieldInvalid(tableInput, "Add a table or person before saving.");
    return false;
  }
  if (activeItems().length === 0) {
    setStatus("Add at least one item before saving.");
    return false;
  }
  return true;
}

function hasClearableNewOrderDraft() {
  return !state.currentTicket && (
    $("#tableNo").value.trim()
    || $("#orderNote").value.trim()
    || activeItems().length > 0
    || paymentPayloads().length > 0
  );
}

async function saveCurrentWork(
  { clearAfter, autosave = false, includePayments = true } = { clearAfter: true, autosave: false, includePayments: true }
) {
  if (state.autosaveInFlight) return true;
  stopAutosaveTimer();
  const payments = includePayments ? paymentPayloads() : [];
  const hasPayments = payments.length > 0;
  try {
    state.autosaveInFlight = true;
    if (state.currentTicket) {
      let ticket = await api(`/api/orders/${state.currentTicket.id}`, {
        method: "PUT",
        body: JSON.stringify({
          table_no: state.currentTicket.table_no,
          note: $("#orderNote").value.trim(),
          items: activeItems().map((item) => ({ menu_code: item.code, quantity: item.quantity })),
        }),
      });
      if (hasPayments) {
        ticket = await savePaymentPayloads(payments, ticket);
      }
      state.currentTicket = ticket;
      state.editingPaymentId = null;
      state.dirty = false;
      setStatus(`${autosave ? "Autosaved" : "Saved"} ticket #${ticket.id}`);
      upsertTicketTab(ticket);
      loadTicketIntoForm(ticket);
    } else {
      if (!hasTicketDraft()) {
        state.dirty = false;
        return true;
      }
      const order = await api("/api/orders", { method: "POST", body: JSON.stringify(orderPayload()) });
      setStatus(`${autosave ? "Autosaved" : "Saved"} ticket #${order.id} for ${order.table_no}`);
      state.dirty = false;
      if (clearAfter || hasPayments) {
        clearOrder();
      } else {
        upsertTicketTab(order);
        state.currentTicket = order;
        loadTicketIntoForm(order);
      }
    }
    await refreshAll();
    return true;
  } catch (error) {
    setStatus(error.message);
    return false;
  } finally {
    state.autosaveInFlight = false;
  }
}

async function savePaymentPayloads(payments, currentTicket) {
  let ticket = currentTicket;
  const updates = payments.filter((payment) => payment.payment_id);
  const additions = payments.filter((payment) => !payment.payment_id);
  for (const payment of updates) {
    ticket = await api(`/api/payments/${payment.payment_id}`, {
      method: "PUT",
      body: JSON.stringify(payment),
    });
  }
  if (additions.length) {
    ticket = await api(`/api/orders/${currentTicket.id}/payments`, {
      method: "POST",
      body: JSON.stringify({ payments: additions }),
    });
  }
  return ticket;
}

async function saveAction() {
  if (!validateTicketForSave()) return;
  await saveCurrentWork({ clearAfter: true, autosave: false });
}

function clearOrderAction() {
  if (hasClearableNewOrderDraft() && !confirm("Clear this new order?")) {
    return;
  }
  clearOrder();
}

async function flushAutosave() {
  if (!state.dirty && !hasTicketDraft() && !(state.currentTicket && paymentPayloads().length)) {
    return true;
  }
  return saveCurrentWork({ clearAfter: Boolean(state.currentTicket), autosave: true });
}

function clearOrder() {
  stopAutosaveTimer();
  state.currentTicket = null;
  state.ticketMode = "edit";
  state.ticketModeId = null;
  state.dirty = false;
  state.quantities = {};
  state.menu.forEach((item) => { state.quantities[item.code] = 0; });
  clearFieldInvalid($("#tableNo"));
  $("#tableNo").value = "";
  setTableLocked(false);
  $("#tableClash").classList.add("hidden");
  $("#orderNote").value = "";
  $("#menuSearch").value = "";
  $("#splits").innerHTML = "";
  state.splitCount = 0;
  renderMenuPicker();
  recalc();
  renderTicketTabs();
}

function loadTicketIntoForm(ticket) {
  const freshOpen = state.ticketModeId !== ticket.id;
  if (freshOpen) {
    state.ticketMode = "edit";
    state.ticketModeId = ticket.id;
    state.openedQuantities = Object.fromEntries(ticket.items.map((item) => [item.menu_code, money(item.quantity)]));
  }
  state.currentTicket = ticket;
  state.editingPaymentId = null;
  state.quantities = {};
  state.menu.forEach((item) => { state.quantities[item.code] = 0; });
  ticket.items.forEach((item) => { state.quantities[item.menu_code] = item.quantity; });
  // An autosave reload must not clobber a table edit in progress.
  if (freshOpen || document.activeElement !== $("#tableNo")) {
    $("#tableNo").value = ticket.table_no;
    setTableLocked(true);
  }
  $("#tableClash").classList.add("hidden");
  $("#orderNote").value = ticket.note || "";
  $("#splits").innerHTML = "";
  state.splitCount = 0;
  if (ticket.outstanding > 0.009) addSplit(false);
  renderMenuPicker();
  state.dirty = false;
  renderTicketTabs();
}

async function openTicketTab(id) {
  const activeView = $(".view.active")?.id.replace("view-", "");
  if (activeView === "order" && state.currentTicket?.id === Number(id)) {
    return;
  }
  if (activeView === "order" && state.currentTicket?.id !== Number(id)) {
    const saved = await flushAutosave();
    if (!saved) return;
  }
  const ticket = await api(`/api/orders/${id}`);
  upsertTicketTab(ticket);
  state.ticketModeId = null; // every open is a fresh visit: Edit mode, and earlier additions folded in
  loadTicketIntoForm(ticket);
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === "view-order"));
  $$(".tab[data-view]").forEach((tab) => tab.classList.remove("active"));
  renderTicketTabs();
}

function tableLabel(tableNo) {
  return /^\d+$/.test(String(tableNo).trim()) ? `Table ${String(tableNo).trim()}` : tableNo;
}

async function renderTickets() {
  const q = encodeURIComponent($("#ticketSearch").value.trim());
  const open = $("#openOnly").checked ? "1" : "0";
  const itemFilters = Object.entries(state.ticketFilters)
    .filter(([, quantity]) => quantity > 0)
    .map(([code, quantity]) => `item=${encodeURIComponent(`${code}:${quantity}`)}`)
    .join("&");
  const filterQuery = itemFilters ? `&${itemFilters}` : "";
  const tickets = await api(`/api/tickets?q=${q}&open=${open}${filterQuery}`);
  $("#ticketList").innerHTML = tickets.length ? tickets.map((ticket) => `
    <div class="ticket-row ${ticket.outstanding <= 0.009 ? "settled" : "open-ticket"}">
      <div>
        <strong>${tableLabel(ticket.table_no)}</strong>
        <span class="due">${ticket.outstanding <= 0.009 ? "Settled" : `${fmt(ticket.outstanding)} due`}</span>
      </div>
      <div class="row-actions">
        <button data-open-ticket="${ticket.id}" type="button">Open</button>
        <button class="danger" data-delete="${ticket.id}" type="button">Delete</button>
      </div>
    </div>
  `).join("") : `<div class="empty">No matching tickets</div>`;
  $$("[data-open-ticket]").forEach((button) => button.addEventListener("click", () => openTicketTab(button.dataset.openTicket)));
  $$("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Delete this ticket?")) return;
      await api(`/api/orders/${button.dataset.delete}`, { method: "DELETE" });
      closeTicketTab(button.dataset.delete);
      await refreshAll();
    });
  });
}

function renderMenuEditor() {
  $("#menuEditor").innerHTML = state.menu.map((item) => `
    <div class="editor-row ${item.category === "food" ? "food" : ""}" data-menu-row="${item.code}">
      <button class="drag-handle" type="button" title="Drag to reorder" aria-label="Reorder ${item.code}: drag, or press up and down arrows">
        <svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>
      </button>
      <input class="edit-code" value="${item.code}" autocomplete="off" aria-label="Code">
      <input class="edit-name" value="${item.name}">
      <select class="edit-category" aria-label="Type">
        <option value="food" ${item.category === "food" ? "selected" : ""}>Food</option>
        <option value="drink" ${item.category === "drink" ? "selected" : ""}>Drink</option>
      </select>
      <input class="edit-price" type="number" min="0" step="0.01" value="${item.price}">
      <button class="danger" data-delete-menu="${item.code}" type="button">Delete</button>
    </div>
  `).join("");
  $$(".edit-name, .edit-price").forEach((input) => {
    input.addEventListener("input", () => scheduleMenuItemSave(input.closest(".editor-row")));
    input.addEventListener("blur", () => saveMenuRow(input.closest(".editor-row")));
  });
  $$(".edit-category").forEach((select) => {
    select.addEventListener("change", () => {
      select.closest(".editor-row").classList.toggle("food", select.value === "food");
      saveMenuRow(select.closest(".editor-row"));
    });
  });
  $$(".edit-code").forEach((input) => {
    input.addEventListener("change", () => saveMenuRow(input.closest(".editor-row")));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  });
  $$(".drag-handle").forEach((handle) => {
    const row = handle.closest(".editor-row");
    handle.addEventListener("pointerdown", (event) => startMenuDrag(event, row));
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const sibling = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      row.parentElement.insertBefore(row, event.key === "ArrowUp" ? sibling : sibling.nextElementSibling);
      handle.focus();
      saveMenuOrder();
    });
  });
  $$("[data-delete-menu]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/menu/${encodeURIComponent(button.dataset.deleteMenu)}`, { method: "DELETE" });
      await loadMenu();
    });
  });
}

function menuOrderFromEditor() {
  return $$(".editor-row", $("#menuEditor")).map((row) => row.dataset.menuRow);
}

function startMenuDrag(event, row) {
  if (event.button !== 0) return;
  event.preventDefault();
  const list = row.parentElement;
  const before = menuOrderFromEditor().join("\n");
  let pointerY = event.clientY;
  let frame = null;
  row.classList.add("dragging");
  list.classList.add("sorting");

  const reposition = () => {
    const next = $$(".editor-row:not(.dragging)", list).find((other) => {
      const box = other.getBoundingClientRect();
      return pointerY < box.top + box.height / 2;
    });
    if (next) {
      if (row.nextElementSibling !== next) list.insertBefore(row, next);
    } else if (list.lastElementChild !== row) {
      list.appendChild(row);
    }
  };
  // Scroll while the pointer is held near the top or bottom edge, so long menus can be crossed.
  const autoScroll = () => {
    const edge = 60;
    const step = pointerY < edge ? -14 : pointerY > window.innerHeight - edge ? 14 : 0;
    if (step) {
      window.scrollBy(0, step);
      reposition();
    }
    frame = requestAnimationFrame(autoScroll);
  };
  const move = (moveEvent) => {
    pointerY = moveEvent.clientY;
    reposition();
  };
  const end = () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    row.classList.remove("dragging");
    list.classList.remove("sorting");
    if (menuOrderFromEditor().join("\n") !== before) saveMenuOrder();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
  frame = requestAnimationFrame(autoScroll);
}

function saveMenuOrder() {
  const codes = menuOrderFromEditor();
  // Chain saves so quick successive moves reach the server in order.
  state.menuOrderSave = (state.menuOrderSave || Promise.resolve()).then(async () => {
    try {
      state.menu = await api("/api/menu/reorder", { method: "POST", body: JSON.stringify({ codes }) });
      renderMenuPicker();
      renderTicketFilters();
      setStatus("Menu order saved");
    } catch (error) {
      setStatus(error.message);
      await loadMenu();
    }
  });
}

function scheduleMenuItemSave(row) {
  const code = row.dataset.menuRow;
  window.clearTimeout(state.menuSaveTimers[code]);
  state.menuSaveTimers[code] = window.setTimeout(() => saveMenuRow(row), 700);
  setStatus(`Saving ${code}...`);
}

async function saveMenuRow(row) {
  const code = row?.dataset.menuRow;
  if (!code) return;
  window.clearTimeout(state.menuSaveTimers[code]);
  delete state.menuSaveTimers[code];
  const codeInput = $(".edit-code", row);
  const newCode = codeInput.value.trim();
  const name = $(".edit-name", row).value.trim();
  const price = $(".edit-price", row).value;
  const category = $(".edit-category", row).value;
  if (!newCode || !name || price === "") return;
  try {
    const item = await api(`/api/menu/${encodeURIComponent(code)}`, {
      method: "PUT",
      body: JSON.stringify({ code: newCode, name, price, category }),
    });
    if (item.code !== code) {
      renameCodeInState(code, item.code);
      await loadMenu();
      setStatus(`Renamed ${code} to ${item.code}`);
      return;
    }
    const index = state.menu.findIndex((menuItem) => menuItem.code === code);
    if (index >= 0) state.menu[index] = item;
    renderTicketFilters();
    setStatus(`Saved ${code}`);
  } catch (error) {
    codeInput.value = code;
    setStatus(error.message);
  }
}

function renameCodeInState(oldCode, newCode) {
  [state.quantities, state.ticketFilters].forEach((values) => {
    if (oldCode in values) {
      values[newCode] = values[oldCode];
      delete values[oldCode];
    }
  });
}

async function addMenuItem() {
  try {
    await api("/api/menu", {
      method: "POST",
      body: JSON.stringify({
        code: $("#menuCode").value,
        name: $("#menuName").value,
        price: $("#menuPrice").value,
        category: $("#menuCategory").value,
      }),
    });
    $("#menuCode").value = "";
    $("#menuName").value = "";
    $("#menuPrice").value = "";
    await loadMenu();
    $("#menuCode").focus();
    setStatus("Menu item saved");
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadMenu() {
  applyMenu(await api("/api/menu"));
}

function applyMenu(menu) {
  state.menu = menu;
  state.menu.forEach((item) => {
    if (state.quantities[item.code] === undefined) state.quantities[item.code] = 0;
    if (state.ticketFilters[item.code] === undefined) state.ticketFilters[item.code] = 0;
  });
  renderMenuPicker();
  renderMenuEditor();
  renderTicketFilters();
}

function metric(label, value, className = "") {
  return `<div class="${className}"><span>${label}</span><strong>${value}</strong></div>`;
}

async function renderSummary() {
  const summary = await api("/api/summary");
  const sold = (summary.sold || []).map((item) => ({
    ...item,
    category: item.category || state.menu.find((menuItem) => menuItem.code === item.code)?.category || "food",
  }));
  const categoryTotals = Object.fromEntries(["food", "drink"].map((category) => {
    const items = sold.filter((item) => item.category === category);
    return [category, {
      quantity: items.reduce((sum, item) => sum + money(item.quantity), 0),
      revenue: items.reduce((sum, item) => sum + money(item.revenue), 0),
    }];
  }));
  $("#metrics").innerHTML = [
    metric("Orders", summary.order_count),
    metric("All tickets", fmt(summary.ticket_total)),
    metric("Food", fmt(categoryTotals.food.revenue)),
    metric("Drinks", fmt(categoryTotals.drink.revenue)),
    metric("Paid", fmt(summary.paid_total)),
    metric("Open", fmt(summary.open_total), summary.open_total ? "warn" : ""),
    metric("Paid incl. tips", fmt(summary.total)),
    metric("Tips", fmt(summary.tips)),
    metric("Cash", fmt(summary.cash_total)),
    metric("PayPal", fmt(summary.paypal_total)),
    metric("Expected cash", fmt(summary.expected_cash)),
    metric("Discrepancy", summary.cash_discrepancy === null ? "-" : fmt(summary.cash_discrepancy), summary.cash_discrepancy ? "warn" : ""),
  ].join("");
  $("#openingCash").value = summary.opening_cash.toFixed(2);
  $("#actualCash").value = summary.actual_cash === null ? "" : summary.actual_cash.toFixed(2);
  $("#soldList").innerHTML = [["food", "Food"], ["drink", "Drinks"]].map(([category, label]) => {
    const items = sold.filter((item) => item.category === category);
    if (!items.length) return "";
    const totals = categoryTotals[category];
    return `
      <div class="sold-group-head">
        <h3>${label}</h3>
        <span>${fmtQty(totals.quantity)} sold</span>
        <strong>${fmt(totals.revenue)}</strong>
      </div>
      ${items.map((item) => `
        <div class="sold-row ${category === "food" ? "food" : ""}">
          <div><strong>${item.name}</strong><span>${item.code} · ${fmtQty(item.quantity)} sold</span></div>
          <strong>${fmt(item.revenue)}</strong>
        </div>
      `).join("")}
    `;
  }).join("") || `<div class="empty">Nothing sold yet.</div>`;
}

async function saveSettings() {
  await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ opening_cash: $("#openingCash").value, actual_cash: $("#actualCash").value }),
  });
  setStatus("Cash settings saved");
  await renderSummary();
}

async function renderEvents() {
  const active = await api("/api/events/active");
  $("#activeEventName").value = active.name;
  $("#activeEventDate").value = active.event_date;
  $("#barExportActive").dataset.barExport = active.id;
  $("#foodExportActive").dataset.foodExport = active.id;
  const events = (await api("/api/events")).filter((event) => event.status === "archived");
  $("#eventList").innerHTML = events.length ? events.map((event) => {
    let menu = [];
    try {
      menu = JSON.parse(event.menu_snapshot || "[]");
    } catch {
      menu = [];
    }
    const menuText = menu.length
      ? menu.map((item) => `${item.code} ${fmt(item.price)}`).join(" · ")
      : "No menu snapshot";
    return `
      <div class="event-row">
        <div>
          <strong>${event.name} · ${event.event_date}</strong>
          <span>${event.status} · ${event.order_count} tickets · ${fmt(event.total)} total · ${fmt(event.tips)} tips</span>
          <small>${menuText}</small>
        </div>
        <div class="row-actions">
          <button data-bar-export="${event.id}" type="button">Drinks for bar</button>
          <button data-food-export="${event.id}" type="button">Food</button>
          <button data-export-event="${event.id}" type="button">Export</button>
        </div>
      </div>
    `;
  }).join("") : `<div class="empty">No past events yet</div>`;
  $$("[data-export-event]").forEach((button) => {
    button.addEventListener("click", () => {
      window.open(`/api/events/${button.dataset.exportEvent}/export`, "_blank");
    });
  });
  $$("#eventList [data-bar-export]").forEach((button) => button.addEventListener("click", openBarExport));
  $$("#eventList [data-food-export]").forEach((button) => button.addEventListener("click", openFoodExport));
}

function openBarExport(event) {
  const id = event.currentTarget.dataset.barExport;
  if (id) window.open(`/api/events/${id}/bar-export`, "_blank");
}

function openFoodExport(event) {
  const id = event.currentTarget.dataset.foodExport;
  if (id) window.open(`/api/events/${id}/food-export`, "_blank");
}

async function saveActiveEvent() {
  try {
    const event = await api("/api/events/active", {
      method: "POST",
      body: JSON.stringify({
        name: $("#activeEventName").value,
        event_date: $("#activeEventDate").value,
      }),
    });
    setStatus(`Saved event ${event.name}`);
    await refreshAll();
  } catch (error) {
    setStatus(error.message);
  }
}

async function closeEvent() {
  const name = $("#activeEventName").value.trim();
  const eventDate = $("#activeEventDate").value;
  if (!name || !eventDate) {
    setStatus("Name and date are required before closing the event.");
    return;
  }
  if (!confirm(`Close "${name}" and start a new empty event?`)) return;
  try {
    await api("/api/events/active", {
      method: "POST",
      body: JSON.stringify({ name, event_date: eventDate }),
    });
    const nextDate = new Date().toISOString().slice(0, 10);
    const next = await api("/api/events/start", {
      method: "POST",
      body: JSON.stringify({ name: `Mikuna ${nextDate}`, event_date: nextDate }),
    });
    state.currentTicket = null;
    state.openTickets = [];
    clearOrder();
    await loadMenu();
    await refreshAll();
    setStatus(`Closed ${name}. Started ${next.name}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function refreshAll() {
  await Promise.all([renderTickets(), renderSummary(), renderEvents()]);
}

async function start() {
  await loadMenu();
  await refreshAll();
  setStatus("Ready");
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
document.addEventListener("focusin", selectInputValue);
$("#saveAction").addEventListener("click", saveAction);
$("#clearOrder").addEventListener("click", clearOrderAction);
$("#payAction").addEventListener("click", () => setTicketMode("pay"));
$("#backToEdit").addEventListener("click", () => setTicketMode("edit"));
$("#tableNo").addEventListener("input", () => {
  clearFieldInvalid($("#tableNo"));
  // An open ticket's table only changes after confirmation (see the change handler).
  if (!state.currentTicket) markDirty();
});
$("#tableNo").addEventListener("change", () => {
  const ticket = state.currentTicket;
  if (!ticket) return;
  const input = $("#tableNo");
  const next = input.value.trim();
  if (next === ticket.table_no) return;
  if (next && confirm(`Move this ticket from ${tableLabel(ticket.table_no)} to ${tableLabel(next)}?`)) {
    ticket.table_no = next;
    markDirty({ schedule: true });
  } else {
    input.value = ticket.table_no;
  }
});
$("#tableNo").addEventListener("keydown", (event) => {
  const input = $("#tableNo");
  if (event.key === "Enter") {
    event.preventDefault();
    // Moving focus fires change (confirmation on open tickets) and blur (locks the label).
    if (input.value.trim()) $("#menuSearch").focus();
  } else if (event.key === "Escape" && state.currentTicket) {
    input.value = state.currentTicket.table_no;
    input.blur();
  }
});
$("#tableNo").addEventListener("blur", () => {
  setTableLocked(true);
  checkTableClash();
});
$("#openClash").addEventListener("click", openClashingTicket);
$("#editTable").addEventListener("click", editTable);
$("#orderNote").addEventListener("input", () => markDirty({ schedule: Boolean(state.currentTicket) }));
$("#addSplit").addEventListener("click", () => {
  if (state.currentTicket?.outstanding <= 0.009) return;
  addSplit(true);
});
$("#menuSearch").addEventListener("input", filterMenuPicker);
$("#ticketSearch").addEventListener("input", renderTickets);
$("#openOnly").addEventListener("change", renderTickets);
$("#clearTicketFilters").addEventListener("click", clearTicketFilters);
$("#toggleTicketFilters").addEventListener("click", () => {
  setTicketFiltersCollapsed(!$("#filterPanel").classList.contains("collapsed"));
});
try {
  if (localStorage.getItem("ticketFiltersCollapsed") === "1") setTicketFiltersCollapsed(true);
} catch {
  // Ignore unavailable storage.
}
$("#addMenuItem").addEventListener("click", addMenuItem);
$$(".menu-form input").forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addMenuItem();
  });
});
$("#refresh").addEventListener("click", refreshAll);
$("#saveSettings").addEventListener("click", saveSettings);
$("#saveActiveEvent").addEventListener("click", saveActiveEvent);
$("#closeEvent").addEventListener("click", closeEvent);
$("#barExportActive").addEventListener("click", openBarExport);
$("#foodExportActive").addEventListener("click", openFoodExport);

start().catch((error) => setStatus(error.message));
