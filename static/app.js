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
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (value) => Number(value || 0);
const fmt = (value) => `$${money(value).toFixed(2)}`;
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
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `view-${view}`));
  renderTicketTabs();
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
  $("#paymentTitle").textContent = state.currentTicket ? "Edit or pay" : "Payment";
  $("#saveAction").textContent = state.currentTicket ? "Save ticket" : "Save ticket";
  $("#clearOrder").classList.toggle("hidden", Boolean(state.currentTicket));
  $("#paymentSurface").classList.toggle("hidden", !state.currentTicket);
  $("#addSplit").classList.toggle("hidden", Boolean(state.currentTicket && state.currentTicket.outstanding <= 0.009));
  $$(".new-only").forEach((node) => node.classList.remove("hidden"));
  if (state.currentTicket) {
    $("#ticketBanner").classList.remove("hidden");
    $("#ticketBanner").classList.toggle("settled", state.currentTicket.outstanding <= 0.009);
    $("#ticketBanner").classList.toggle("open-ticket", state.currentTicket.outstanding > 0.009);
    $("#ticketBanner").innerHTML = `<strong>${state.currentTicket.table_no}</strong> · ${fmt(state.currentTicket.outstanding)} remaining · ${state.currentTicket.outstanding <= 0.009 ? "Settled" : "Open"} · ${state.currentTicket.note || "No note"}`;
  } else {
    $("#ticketBanner").classList.add("hidden");
    $("#ticketBanner").classList.remove("settled", "open-ticket");
  }
  state.menu.filter((item) => item.active).forEach((item) => {
    const existing = ticketItemByCode(item.code);
    const row = document.createElement("div");
    row.className = "menu-row";
    row.innerHTML = `
      <div><strong>${item.code} · ${item.name}</strong><span>${fmt(existing?.unit_price || item.price)}</span></div>
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
  renderSplits();
  recalc();
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
      const status = ticket.outstanding <= 0.009 ? "settled" : "recorded";
      const row = document.createElement("div");
      row.className = "final-split";
      row.innerHTML = `
        <div class="final-split-main">
          <div>
            <strong>Split ${payment.split_no} · ${type} · ${payment.method}</strong>
            <span>${fmt(payment.subtotal)} due · ${fmt(payment.tip)} tip · ${fmt(payment.tendered)} tendered · ${fmt(payment.change)} change</span>
          </div>
          <div class="final-split-actions">
            <strong>${fmt(payment.total_with_tip)}</strong>
            <span class="status-pill ${status}">${status === "settled" ? "Settled" : "Recorded"}</span>
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
  state.menu.filter((item) => item.active).forEach((item) => {
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
      renderTickets();
    });
    $$("button", row).forEach((button) => {
      button.addEventListener("click", () => {
        const next = Math.max(0, (state.ticketFilters[item.code] || 0) + Number(button.dataset.step));
        state.ticketFilters[item.code] = next;
        input.value = next;
        renderTickets();
      });
    });
    root.appendChild(row);
  });
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
  $(".split-mode", node).addEventListener("change", () => {
    setSplitMode(node, $(".split-mode", node).value);
    syncSplitAmountsToDue(node);
    renderFollowingAllocations(node);
    recalc();
    markDirty();
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
  if (payment) {
    $(".method", node).value = payment.method;
    $(".split-percent", node).value = payment.split_percent || "";
    $(".split-total", node).value = money(payment.total_with_tip).toFixed(2);
    $(".split-tendered", node).value = money(payment.tendered).toFixed(2);
  }
  renderAllocations(node);
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

function setSplitMode(split, mode) {
  $(".split-mode", split).value = mode;
  split.dataset.mode = mode;
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
        <label class="allocation">
          <span>${item.code}</span>
          <input data-code="${item.code}" data-price="${item.price}" type="number" min="0" max="${item.quantity}" step="0.01" value="${fmtQty(value)}">
          <small class="allocation-status"></small>
        </label>
      `;
    }).join("")
    : `<div class="empty">Add items before taking payment.</div>`;
  $$("input", allocations).forEach((input) => {
    updateAllocationFeedback(input);
    input.addEventListener("input", () => {
      updateAllocationFeedback(input);
      renderFollowingAllocations(split);
      recalc();
      markDirty();
    });
  });
  $$(".split-grid input, .split-grid select", split).forEach((input) => {
    input.addEventListener("input", () => {
      recalc();
      markDirty();
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
  status.textContent = overBy > 0.009
    ? `${fmtQty(entered)} / ${fmtQty(available)} - over by ${fmtQty(overBy)}`
    : `${fmtQty(entered)} / ${fmtQty(available)} available`;
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
    tendered: money($(".split-tendered", row).value),
    allocations,
  };
}

async function saveSplit(row) {
  if (!state.currentTicket) return;
  if (!validateTicketForSave()) return;
  const payment = splitData(row, Number(row.dataset.splitNo || 1) - 1);
  if (payment.subtotal <= 0 && payment.total_with_tip <= 0) {
    setStatus("Add something to this split before saving.");
    return;
  }
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
    setStatus(error.message);
  }
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
  const subtotal = splitSubtotal(row).toFixed(2);
  $(".split-subtotal", row).value = subtotal;
  $(".split-total", row).value = subtotal;
  $(".split-tendered", row).value = subtotal;
}

function recalc() {
  const itemSub = draftBaseSubtotal();
  let draftSubtotal = 0;
  let tip = 0;
  let change = 0;
  let totalWithTip = 0;
  $$(".split").forEach((row, index) => {
    const subtotal = splitSubtotal(row);
    const subtotalInput = $(".split-subtotal", row);
    const totalInput = $(".split-total", row);
    const tenderedInput = $(".split-tendered", row);
    subtotalInput.value = subtotal.toFixed(2);
    if (money(totalInput.value) < subtotal && !totalInput.matches(":focus")) totalInput.value = subtotal.toFixed(2);
    if (money(tenderedInput.value) < money(totalInput.value) && !tenderedInput.matches(":focus")) tenderedInput.value = money(totalInput.value).toFixed(2);
    const splitTotal = money(totalInput.value);
    const splitTip = splitTotal - subtotal;
    const splitChange = Math.max(0, money(tenderedInput.value) - splitTotal);
    $(".split-due", row).textContent = fmt(subtotal);
    $(".split-tip", row).textContent = fmt(splitTip);
    $(".split-change", row).textContent = fmt(splitChange);
    draftSubtotal += subtotal;
    tip += splitTip;
    change += splitChange;
    totalWithTip += splitTotal;
  });
  $("#orderSubtotal").textContent = fmt(itemSub);
  $("#orderRemainingAfterDraft").textContent = fmt(Math.max(0, itemSub - draftSubtotal));
  $("#orderTips").textContent = fmt(tip);
  $("#orderTotal").textContent = fmt(totalWithTip);
  $("#orderChange").textContent = fmt(change);
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
          table_no: $("#tableNo").value.trim(),
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
  state.dirty = false;
  state.quantities = {};
  state.menu.forEach((item) => { state.quantities[item.code] = 0; });
  clearFieldInvalid($("#tableNo"));
  $("#tableNo").value = "";
  $("#orderNote").value = "";
  $("#splits").innerHTML = "";
  state.splitCount = 0;
  renderMenuPicker();
  recalc();
  renderTicketTabs();
}

function loadTicketIntoForm(ticket) {
  state.currentTicket = ticket;
  state.editingPaymentId = null;
  state.quantities = {};
  state.menu.forEach((item) => { state.quantities[item.code] = 0; });
  ticket.items.forEach((item) => { state.quantities[item.menu_code] = item.quantity; });
  $("#tableNo").value = ticket.table_no;
  $("#orderNote").value = ticket.note || "";
  $("#splits").innerHTML = "";
  state.splitCount = 0;
  addSplit(false);
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
  loadTicketIntoForm(ticket);
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === "view-order"));
  $$(".tab[data-view]").forEach((tab) => tab.classList.remove("active"));
  renderTicketTabs();
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
        <strong>#${ticket.id} · ${ticket.table_no} · ${fmt(ticket.outstanding)} due</strong>
        <span>${ticket.items || "No items"}${ticket.note ? ` · ${ticket.note}` : ""}</span>
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
  $("#menuEditor").innerHTML = state.menu.map((item, index) => `
    <div class="editor-row" data-menu-row="${item.code}">
      <input class="edit-code" value="${item.code}" disabled>
      <input class="edit-name" value="${item.name}">
      <input class="edit-price" type="number" min="0" step="0.01" value="${item.price}">
      <div class="order-actions">
        <button class="icon-button" data-move-menu-code="${item.code}" data-direction="-1" type="button" title="Move up" aria-label="Move item up" ${index === 0 ? "disabled" : ""}>&#9650;</button>
        <button class="icon-button" data-move-menu-code="${item.code}" data-direction="1" type="button" title="Move down" aria-label="Move item down" ${index === state.menu.length - 1 ? "disabled" : ""}>&#9660;</button>
      </div>
      <button class="danger" data-delete-menu="${item.code}" type="button">Delete</button>
    </div>
  `).join("");
  $$(".edit-name, .edit-price").forEach((input) => {
    input.addEventListener("input", () => scheduleMenuItemSave(input.closest(".editor-row")));
    input.addEventListener("blur", () => saveMenuRow(input.closest(".editor-row")));
  });
  $$("[data-move-menu-code]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const index = state.menu.findIndex((item) => item.code === button.dataset.moveMenuCode);
        const nextIndex = index + Number(button.dataset.direction);
        if (index < 0 || nextIndex < 0 || nextIndex >= state.menu.length) return;
        const nextMenu = [...state.menu];
        [nextMenu[index], nextMenu[nextIndex]] = [nextMenu[nextIndex], nextMenu[index]];
        const menu = await api("/api/menu/reorder", {
          method: "POST",
          body: JSON.stringify({ codes: nextMenu.map((item) => item.code) }),
        });
        applyMenu(menu);
        setStatus("Menu order saved");
      } catch (error) {
        setStatus(error.message);
      }
    });
  });
  $$("[data-delete-menu]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/menu/${button.dataset.deleteMenu}`, { method: "DELETE" });
      await loadMenu();
    });
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
  const name = $(".edit-name", row).value.trim();
  const price = $(".edit-price", row).value;
  if (!name || price === "") return;
  try {
    const item = await api(`/api/menu/${code}`, {
      method: "PUT",
      body: JSON.stringify({ name, price }),
    });
    const index = state.menu.findIndex((menuItem) => menuItem.code === code);
    if (index >= 0) state.menu[index] = item;
    setStatus(`Saved ${code}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function addMenuItem() {
  try {
    await api("/api/menu", {
      method: "POST",
      body: JSON.stringify({ code: $("#menuCode").value, name: $("#menuName").value, price: $("#menuPrice").value }),
    });
    $("#menuCode").value = "";
    $("#menuName").value = "";
    $("#menuPrice").value = "";
    await loadMenu();
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
  $("#metrics").innerHTML = [
    metric("Orders", summary.order_count),
    metric("All tickets", fmt(summary.ticket_total)),
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
  $("#soldList").innerHTML = summary.sold.map((item) => `
    <div class="sold-row">
      <div><strong>${item.code} · ${item.name}</strong><span>${item.quantity} sold</span></div>
      <strong>${fmt(item.revenue)}</strong>
    </div>
  `).join("");
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
$("#tableNo").addEventListener("input", () => {
  clearFieldInvalid($("#tableNo"));
  markDirty({ schedule: Boolean(state.currentTicket) });
});
$("#orderNote").addEventListener("input", () => markDirty({ schedule: Boolean(state.currentTicket) }));
$("#addSplit").addEventListener("click", () => {
  if (state.currentTicket?.outstanding <= 0.009) return;
  addSplit(true);
});
$("#ticketSearch").addEventListener("input", renderTickets);
$("#openOnly").addEventListener("change", renderTickets);
$("#clearTicketFilters").addEventListener("click", () => {
  state.ticketFilters = {};
  state.menu.forEach((item) => { state.ticketFilters[item.code] = 0; });
  $("#ticketSearch").value = "";
  renderTicketFilters();
  renderTickets();
});
$("#addMenuItem").addEventListener("click", addMenuItem);
$("#refresh").addEventListener("click", refreshAll);
$("#saveSettings").addEventListener("click", saveSettings);
$("#saveActiveEvent").addEventListener("click", saveActiveEvent);
$("#closeEvent").addEventListener("click", closeEvent);

start().catch((error) => setStatus(error.message));
