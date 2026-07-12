const state = {
  menu: [],
  quantities: {},
  ticketFilters: {},
  splitCount: 0,
  currentTicket: null,
  editingTicket: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = (value) => Number(value || 0);
const fmt = (value) => `$${money(value).toFixed(2)}`;

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

function selectInputValue(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.disabled || input.type !== "number") {
    return;
  }
  window.setTimeout(() => input.select(), 0);
}

function switchView(view) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `view-${view}`));
}

function activeItems() {
  if (state.currentTicket) {
    return state.currentTicket.remaining_items
      .filter((item) => item.remaining_quantity > 0)
      .map((item) => ({
        code: item.menu_code,
        name: item.name,
        price: item.unit_price,
        quantity: item.remaining_quantity,
      }));
  }
  return state.menu
    .map((item) => ({
      code: item.code,
      name: item.name,
      price: item.price,
      quantity: state.quantities[item.code] || 0,
    }))
    .filter((item) => item.quantity > 0);
}

function activeSubtotal() {
  return activeItems().reduce((sum, item) => sum + item.quantity * item.price, 0);
}

function renderMenuPicker() {
  const list = $("#menuList");
  list.innerHTML = "";
  if (state.currentTicket) {
    state.editingTicket = null;
    $("#orderTitle").textContent = `Ticket #${state.currentTicket.id}`;
    $("#paymentTitle").textContent = "Pay selected items";
    $("#saveAction").textContent = "Save payment";
    $("#ticketBanner").classList.remove("hidden");
    $("#ticketBanner").innerHTML = `<strong>${state.currentTicket.table_no}</strong> · ${fmt(state.currentTicket.outstanding)} remaining · ${state.currentTicket.note || "No note"}`;
    $$(".new-only").forEach((node) => node.classList.add("hidden"));
    $("#paymentSurface").classList.remove("hidden");
    const remaining = activeItems();
    list.innerHTML = remaining.length
      ? remaining.map((item) => `
        <div class="menu-row">
          <div><strong>${item.code} · ${item.name}</strong><span>${item.quantity} remaining at ${fmt(item.price)}</span></div>
          <strong>${fmt(item.quantity * item.price)}</strong>
        </div>
      `).join("")
      : `<div class="empty">This ticket is fully paid.</div>`;
    renderSplits();
    recalc();
    return;
  }

  $("#orderTitle").textContent = state.editingTicket ? `Edit ticket #${state.editingTicket.id}` : "New ticket";
  $("#paymentTitle").textContent = "Payment";
  $("#saveAction").textContent = state.editingTicket ? "Save correction" : "Save ticket";
  $("#ticketBanner").classList.add("hidden");
  $$(".new-only").forEach((node) => node.classList.remove("hidden"));
  $("#paymentSurface").classList.toggle("hidden", Boolean(state.editingTicket));
  state.menu.filter((item) => item.active).forEach((item) => {
    const row = document.createElement("div");
    row.className = "menu-row";
    row.innerHTML = `
      <div><strong>${item.code} · ${item.name}</strong><span>${fmt(item.price)}</span></div>
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
    });
    $$("button", row).forEach((button) => {
      button.addEventListener("click", () => {
        const next = Math.max(0, (state.quantities[item.code] || 0) + Number(button.dataset.step));
        state.quantities[item.code] = next;
        input.value = next;
        renderSplits();
        recalc();
      });
    });
    list.appendChild(row);
  });
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

function addSplit() {
  state.splitCount += 1;
  const node = $("#splitTemplate").content.firstElementChild.cloneNode(true);
  node.dataset.split = state.splitCount;
  $("strong", node).textContent = `Split ${state.splitCount}`;
  $(".remove-split", node).addEventListener("click", () => {
    node.remove();
    recalc();
  });
  $(".fill-split", node).addEventListener("click", () => {
    activeItems().forEach((item) => {
      const input = $(`.allocation input[data-code="${item.code}"]`, node);
      if (input) input.value = item.quantity;
    });
    recalc();
  });
  $("#splits").appendChild(node);
  renderAllocations(node);
  recalc();
}

function renderSplits() {
  const splits = $$(".split");
  if (splits.length === 0) addSplit();
  $$(".split").forEach(renderAllocations);
}

function renderAllocations(split) {
  const allocations = $(".allocations", split);
  const previous = Object.fromEntries(
    $$(".allocation input", split).map((input) => [input.dataset.code, input.value])
  );
  const items = activeItems();
  allocations.innerHTML = items.length
    ? items.map((item) => `
      <label class="allocation">
        <span>${item.code}</span>
        <input data-code="${item.code}" data-price="${item.price}" type="number" min="0" max="${item.quantity}" step="1" value="${previous[item.code] || 0}">
        <small>of ${item.quantity}</small>
      </label>
    `).join("")
    : `<div class="empty">Add items before taking payment.</div>`;
  $$("input", allocations).forEach((input) => input.addEventListener("input", recalc));
  $$("input, select", split).forEach((input) => input.addEventListener("input", recalc));
}

function splitData(row, index) {
  const allocations = $$(".allocation input", row)
    .map((input) => ({
      menu_code: input.dataset.code,
      quantity: Math.min(money(input.value), money(input.max)),
      amount: Math.min(money(input.value), money(input.max)) * money(input.dataset.price),
    }))
    .filter((item) => item.quantity > 0);
  return {
    split_no: index + 1,
    method: $(".method", row).value,
    subtotal: money($(".split-subtotal", row).value),
    total_with_tip: money($(".split-total", row).value),
    tendered: money($(".split-tendered", row).value),
    allocations,
  };
}

function recalc() {
  const itemSub = activeSubtotal();
  let tip = 0;
  let change = 0;
  let totalWithTip = 0;
  $$(".split").forEach((row, index) => {
    const subtotal = splitData(row, index).allocations.reduce((sum, item) => sum + item.amount, 0);
    const subtotalInput = $(".split-subtotal", row);
    const totalInput = $(".split-total", row);
    const tenderedInput = $(".split-tendered", row);
    if (!subtotalInput.matches(":focus")) subtotalInput.value = subtotal.toFixed(2);
    if (money(totalInput.value) < subtotal && !totalInput.matches(":focus")) totalInput.value = subtotal.toFixed(2);
    if (money(tenderedInput.value) < money(totalInput.value) && !tenderedInput.matches(":focus")) tenderedInput.value = money(totalInput.value).toFixed(2);
    const splitTotal = money(totalInput.value);
    const splitTip = splitTotal - subtotal;
    const splitChange = Math.max(0, money(tenderedInput.value) - splitTotal);
    $(".split-due", row).textContent = fmt(subtotal);
    $(".split-tip", row).textContent = fmt(splitTip);
    $(".split-change", row).textContent = fmt(splitChange);
    tip += splitTip;
    change += splitChange;
    totalWithTip += splitTotal;
  });
  $("#orderSubtotal").textContent = fmt(itemSub);
  $("#orderTips").textContent = fmt(tip);
  $("#orderTotal").textContent = fmt(totalWithTip);
  $("#orderChange").textContent = fmt(change);
}

function orderPayload() {
  return {
    table_no: $("#tableNo").value.trim(),
    note: $("#orderNote").value.trim(),
    items: activeItems().map((item) => ({ menu_code: item.code, quantity: item.quantity })),
    payments: $$(".split").map(splitData).filter((payment) => payment.subtotal > 0 || payment.total_with_tip > 0),
  };
}

async function saveAction() {
  try {
    if (state.currentTicket) {
      const payments = $$(".split").map(splitData).filter((payment) => payment.subtotal > 0 || payment.total_with_tip > 0);
      const ticket = await api(`/api/orders/${state.currentTicket.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ payments }),
      });
      setStatus(`Payment saved for ticket #${ticket.id}`);
      clearOrder();
    } else if (state.editingTicket) {
      const ticket = await api(`/api/orders/${state.editingTicket.id}`, {
        method: "PUT",
        body: JSON.stringify({
          table_no: $("#tableNo").value.trim(),
          note: $("#orderNote").value.trim(),
          items: activeItems().map((item) => ({ menu_code: item.code, quantity: item.quantity })),
        }),
      });
      setStatus(`Updated ticket #${ticket.id}`);
      clearOrder();
    } else {
      const order = await api("/api/orders", { method: "POST", body: JSON.stringify(orderPayload()) });
      setStatus(`Saved ticket #${order.id} for ${order.table_no}`);
      clearOrder();
    }
    await refreshAll();
  } catch (error) {
    setStatus(error.message);
  }
}

function clearOrder() {
  state.currentTicket = null;
  state.editingTicket = null;
  state.quantities = {};
  state.menu.forEach((item) => { state.quantities[item.code] = 0; });
  $("#tableNo").value = "";
  $("#orderNote").value = "";
  $("#splits").innerHTML = "";
  state.splitCount = 0;
  addSplit();
  renderMenuPicker();
  recalc();
}

async function loadTicket(id) {
  state.currentTicket = await api(`/api/orders/${id}`);
  state.editingTicket = null;
  $("#splits").innerHTML = "";
  state.splitCount = 0;
  addSplit();
  renderMenuPicker();
  switchView("order");
}

async function editTicket(id) {
  const ticket = await api(`/api/orders/${id}`);
  state.currentTicket = null;
  state.editingTicket = ticket;
  state.quantities = {};
  state.menu.forEach((item) => { state.quantities[item.code] = 0; });
  ticket.items.forEach((item) => { state.quantities[item.menu_code] = item.quantity; });
  $("#tableNo").value = ticket.table_no;
  $("#orderNote").value = ticket.note || "";
  $("#splits").innerHTML = "";
  state.splitCount = 0;
  renderMenuPicker();
  recalc();
  switchView("order");
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
    <div class="ticket-row">
      <div>
        <strong>#${ticket.id} · ${ticket.table_no} · ${fmt(ticket.outstanding)} due</strong>
        <span>${ticket.items || "No items"}${ticket.note ? ` · ${ticket.note}` : ""}</span>
      </div>
      <div class="row-actions">
        <button data-pay="${ticket.id}" type="button">Pay</button>
        <button data-edit="${ticket.id}" type="button">Edit</button>
        <button class="danger" data-delete="${ticket.id}" type="button">Delete</button>
      </div>
    </div>
  `).join("") : `<div class="empty">No matching tickets</div>`;
  $$("[data-pay]").forEach((button) => button.addEventListener("click", () => loadTicket(button.dataset.pay)));
  $$("[data-edit]").forEach((button) => button.addEventListener("click", () => editTicket(button.dataset.edit)));
  $$("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Delete this ticket?")) return;
      await api(`/api/orders/${button.dataset.delete}`, { method: "DELETE" });
      await refreshAll();
    });
  });
}

function renderMenuEditor() {
  $("#menuEditor").innerHTML = state.menu.map((item, index) => `
    <div class="editor-row">
      <input class="edit-code" value="${item.code}" disabled>
      <input class="edit-name" value="${item.name}">
      <input class="edit-price" type="number" min="0" step="0.01" value="${item.price}">
      <div class="order-actions">
        <button data-move-menu="${item.code}" data-direction="-1" type="button" ${index === 0 ? "disabled" : ""}>Up</button>
        <button data-move-menu="${item.code}" data-direction="1" type="button" ${index === state.menu.length - 1 ? "disabled" : ""}>Down</button>
      </div>
      <button data-save-menu="${item.code}" type="button">Save</button>
      <button class="danger" data-delete-menu="${item.code}" type="button">Delete</button>
    </div>
  `).join("");
  $$("[data-move-menu]").forEach((button) => {
    button.addEventListener("click", async () => {
      const index = state.menu.findIndex((item) => item.code === button.dataset.moveMenu);
      const nextIndex = index + Number(button.dataset.direction);
      if (index < 0 || nextIndex < 0 || nextIndex >= state.menu.length) return;
      const nextMenu = [...state.menu];
      [nextMenu[index], nextMenu[nextIndex]] = [nextMenu[nextIndex], nextMenu[index]];
      await api("/api/menu/reorder", {
        method: "POST",
        body: JSON.stringify({ codes: nextMenu.map((item) => item.code) }),
      });
      await loadMenu();
    });
  });
  $$("[data-save-menu]").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".editor-row");
      await api(`/api/menu/${button.dataset.saveMenu}`, {
        method: "PUT",
        body: JSON.stringify({ name: $(".edit-name", row).value, price: $(".edit-price", row).value }),
      });
      await loadMenu();
    });
  });
  $$("[data-delete-menu]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/menu/${button.dataset.deleteMenu}`, { method: "DELETE" });
      await loadMenu();
    });
  });
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
  state.menu = await api("/api/menu");
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
    metric("Total", fmt(summary.total)),
    metric("Cash", fmt(summary.cash_total)),
    metric("PayPal", fmt(summary.paypal_total)),
    metric("Tips", fmt(summary.tips)),
    metric("Expected cash", fmt(summary.expected_cash)),
    metric("Cash change", fmt(summary.cash_change)),
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
  const events = await api("/api/events");
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
      </div>
    `;
  }).join("") : `<div class="empty">No events yet</div>`;
}

async function refreshAll() {
  await Promise.all([renderTickets(), renderSummary(), renderEvents()]);
}

async function start() {
  await loadMenu();
  addSplit();
  await refreshAll();
  setStatus("Ready");
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
document.addEventListener("focusin", selectInputValue);
$("#saveAction").addEventListener("click", saveAction);
$("#clearOrder").addEventListener("click", clearOrder);
$("#addSplit").addEventListener("click", addSplit);
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

start().catch((error) => setStatus(error.message));
