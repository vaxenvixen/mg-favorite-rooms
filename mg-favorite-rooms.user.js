// ==UserScript==
// @name         Magic Garden - Favorite Rooms
// @namespace    https://github.com/vaxenvixen/mg-favorite-rooms
// @version      1.0.0
// @description  Save your favorite rooms, and if they are public you can view which users are currently in the room.
// @author       Vaxen
// @match        https://1227719606223765687.discordsays.com/*
// @match        https://magiccircle.gg/r/*
// @match        https://magicgarden.gg/r/*
// @match        https://starweaver.org/r/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      ariedam.fr
// @connect      cdn.discordapp.com
// @connect      raw.githubusercontent.com
// @updateURL    https://github.com/vaxenvixen/mg-favorite-rooms/raw/refs/heads/main/mg-favorite-rooms.user.js
// @downloadURL  https://github.com/vaxenvixen/mg-favorite-rooms/raw/refs/heads/main/mg-favorite-rooms.user.js
// @run-at       document-idle

// ==/UserScript==
"use strict";
(() => {
  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  // ============================================================
  // Config
  // ============================================================
  const STORE_KEY = "roomFavorites.v1";
  const ROOMS_API = "https://ariesmod-api.ariedam.fr/rooms?limit=200";
  const STATUS_REFRESH_MS = 20000;
  const PANEL_ID = "room-favorites";
  const PAGE_SIZE = 5;
  const MAX_FAVORITES = 25; // curated shortlist, not a full room directory
  const SCRIPT_VERSION = "1.0.0";
  const VERSION_CHECK_URL = "https://github.com/vaxenvixen/mg-favorite-rooms/raw/refs/heads/main/mg-favorite-rooms.user.js";
  const VERSION_CHECK_INTERVAL_MS = 30 * 60 * 1000;

  function getPanelManager() {
    if (!page.__mgPanelManager) {
      const panels = new Map();
      const manager = {
        register(id, panelEl, buttonEl, onClose) {
          panels.set(id, { panelEl, buttonEl, onClose });
        },
        closeAllExcept(exceptId) {
          for (const [id, entry] of panels) if (id !== exceptId) entry.onClose();
        },
        closeAll() {
          for (const [, entry] of panels) entry.onClose();
        }
      };
      document.addEventListener("click", (event) => {
        const clickedInsideAny = [...panels.values()].some(
          ({ panelEl, buttonEl }) => panelEl.contains(event.target) || buttonEl?.contains(event.target)
        );
        if (!clickedInsideAny) manager.closeAll();
      }, true);
      page.__mgPanelManager = manager;
    }
    return page.__mgPanelManager;
  }

  function subscribeToRoomPatches(handler, attempt = 0) {
    const connection = page.MagicCircle_RoomConnection;
    if (typeof connection?.subscribeToPatches !== "function") {
      if (attempt < 60) setTimeout(() => subscribeToRoomPatches(handler, attempt + 1), 1000);
      return;
    }
    if (!connection.__mgListeners) {
      connection.__mgListeners = [];
      connection.subscribeToPatches((patches, fullState) => {
        for (const listener of connection.__mgListeners) {
          try {
            listener(patches, fullState);
          } catch (err) {
            console.error("[Magic Garden scripts] listener error:", err);
          }
        }
      });
    }
    connection.__mgListeners.push(handler);
  }

  // ============================================================
  // Persistence
  // ============================================================
  function loadFavorites() {
    try {
      const saved = GM_getValue(STORE_KEY, null);
      if (Array.isArray(saved)) return saved;
    } catch {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return [];
  }

  function saveFavorites(list) {
    try {
      GM_setValue(STORE_KEY, list);
    } catch {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(list));
      } catch {}
    }
  }

  // ============================================================
  // State
  // ============================================================
  let favorites = loadFavorites();
  let roomStatus = new Map(); // roomId -> { players_count, slots, is_private }
  let localRoom = { id: null, players: [] }; // the room this client is currently in, if any
  let lastFetchError = "";
  let fetching = false;
  let currentPage = 0;
  let addError = "";
  let dragSourceIndex = null;

  // ============================================================
  // Helpers
  // ============================================================
  function currentRoomId() {
    const match = location.pathname.match(/\/r\/([a-zA-Z0-9_-]{1,64})/);
    return match ? match[1] : null;
  }

  function isValidRoomId(id) {
    return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[c]);
  }

  function joinRoom(id) {
    if (isValidRoomId(id)) location.href = `/r/${id}`;
  }

  function compareVersions(a, b) {
    const partsA = String(a).split(".").map(Number);
    const partsB = String(b).split(".").map(Number);
    const len = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < len; i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  let remoteVersion = null;
  let versionCheckError = "";
  let hasConnectedOnce = false;

  function checkForUpdate() {
    GM_xmlhttpRequest({
      method: "GET",
      url: VERSION_CHECK_URL,
      onload: (response) => {
        if (response.status < 200 || response.status >= 300) {
          versionCheckError = `Check failed (${response.status})`;
          render();
          return;
        }
        const match = response.responseText.match(/@version\s+([\d.]+)/);
        if (match) {
          remoteVersion = match[1];
          versionCheckError = "";
        } else {
          versionCheckError = "Version not found in remote file";
        }
        render();
      },
      onerror: () => {
        versionCheckError = "Could not reach update check URL";
        render();
      }
    });
  }

  function totalPages() {
    return Math.max(1, Math.ceil(favorites.length / PAGE_SIZE));
  }

  function clampCurrentPage() {
    currentPage = Math.min(Math.max(currentPage, 0), totalPages() - 1);
  }

  function avatarUrlFor(slot) {
    if (!slot) return null;
    if (slot.avatar_url) return slot.avatar_url;
    if (slot.avatarUrl) return slot.avatarUrl;
    const discordId = slot.discord_id || slot.discordId || slot.user_id || slot.userId;
    const hash = slot.avatar_hash || slot.avatarHash || slot.avatar;
    if (discordId && hash) {
      const ext = String(hash).startsWith("a_") ? "gif" : "png";
      return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.${ext}?size=32`;
    }
    return null;
  }

  function readLocalPlayers(roomData) {
    const players = roomData?.players || roomData?.userSlots || [];
    return players
      .map((p) => (p?.data ? { ...p.data, name: p.data?.name || p?.name } : p))
      .filter((p) => p?.name);
  }

  // ============================================================
  // Favorites mutation
  // ============================================================
  function addFavorite(id) {
    if (!isValidRoomId(id) || favorites.includes(id)) return;
    if (favorites.length >= MAX_FAVORITES) {
      addError = `Limit reached (${MAX_FAVORITES} max). Remove one to add another.`;
      render();
      return;
    }
    addError = "";
    favorites = [...favorites, id];
    saveFavorites(favorites);
    currentPage = totalPages() - 1; // jump to the page the new entry landed on
    render();
  }

  function removeFavorite(id) {
    favorites = favorites.filter((f) => f !== id);
    roomStatus.delete(id);
    saveFavorites(favorites);
    clampCurrentPage();
    render();
  }

  function reorderFavorites(sourceIndex, targetIndex) {
    if (sourceIndex === targetIndex) return;
    const next = [...favorites];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    favorites = next;
    saveFavorites(favorites);
    render();
  }

  // ============================================================
  // Remote room status (public room list)
  // ============================================================
  function fetchRoomStatus() {
    if (fetching) return;
    fetching = true;
    GM_xmlhttpRequest({
      method: "GET",
      url: ROOMS_API,
      onload: (response) => {
        fetching = false;
        try {
          if (response.status < 200 || response.status >= 300) {
            lastFetchError = `Request failed (${response.status})`;
            render();
            return;
          }
          const rows = JSON.parse(response.responseText);
          const next = new Map();
          if (Array.isArray(rows)) {
            for (const row of rows) {
              if (!row?.id) continue;
              next.set(row.id, {
                players_count: Number(row.players_count || 0),
                slots: Array.isArray(row.user_slots) ? row.user_slots : [],
                is_private: !!row.is_private
              });
            }
          }
          roomStatus = next;
          lastFetchError = "";
        } catch {
          lastFetchError = "Bad response from rooms API";
        }
        render();
      },
      onerror: () => {
        fetching = false;
        lastFetchError = "Network request failed";
        render();
      }
    });
  }

  // ============================================================
  // Rendering
  // ============================================================
  function initialsAvatarHtml(name) {
    const letter = escapeHtml((name || "?").trim().charAt(0).toUpperCase() || "?");
    return `<span class="rf-avatar rf-avatar-fallback">${letter}</span>`;
  }

  function avatarsHtml(slots) {
    return slots.slice(0, 6).map((slot) => {
      const url = avatarUrlFor(slot);
      const name = escapeHtml(slot?.name || "Player");
      return url
        ? `<img class="rf-avatar" src="${escapeHtml(url)}" alt="${name}" title="${name}" loading="lazy">`
        : `<span title="${name}">${initialsAvatarHtml(slot?.name)}</span>`;
    }).join("");
  }

  function statusHtml(roomId) {
    if (localRoom.id === roomId) {
      const count = localRoom.players.length || 1;
      return `
        <div class="rf-status-row">
          <div class="rf-avatars">${avatarsHtml(localRoom.players)}</div>
          <small class="rf-status rf-you-here">You're here &mdash; ${count}/6</small>
        </div>
      `;
    }
    const info = roomStatus.get(roomId);
    if (!info) return `<small class="rf-status rf-private">Private</small>`;
    const badgeClass = info.players_count > 0 ? "rf-online" : "rf-empty-badge";
    return `
      <div class="rf-status-row">
        <div class="rf-avatars">${avatarsHtml(info.slots)}</div>
        <small class="rf-status ${badgeClass}">${info.players_count}/6${info.is_private ? " (private)" : ""}</small>
      </div>
    `;
  }

  function favoriteRowHtml(roomId, globalIndex) {
    const isHere = localRoom.id === roomId;
    const actionButton = isHere
      ? `<button disabled class="rf-here-badge">Here</button>`
      : `<button data-join="${escapeHtml(roomId)}">Join</button>`;
    return `
      <div class="rf-row${isHere ? " rf-row-current" : ""}" draggable="true" data-drag-index="${globalIndex}">
        <div class="rf-drag-handle" title="Drag to reorder">\u22EE\u22EE</div>
        <div class="rf-info">
          <span class="rf-id" title="${escapeHtml(roomId)}">${escapeHtml(roomId)}</span>
          ${statusHtml(roomId)}
        </div>
        ${actionButton}
        <button data-remove="${escapeHtml(roomId)}" class="rf-danger">&times;</button>
      </div>
    `;
  }

  function render() {
    const panel = document.getElementById("rf-panel");
    if (!panel) return;

    const activeRoomId = currentRoomId();
    const isCurrentRoomFavorited = activeRoomId && favorites.includes(activeRoomId);

    clampCurrentPage();
    const pageStart = currentPage * PAGE_SIZE;
    const pageItems = favorites.slice(pageStart, pageStart + PAGE_SIZE);

    panel.querySelector(".rf-list").innerHTML = favorites.length
      ? pageItems.map((id, i) => favoriteRowHtml(id, pageStart + i)).join("")
      : `<p class="rf-empty">No favorites yet.</p>`;

    const pager = panel.querySelector(".rf-pager");
    const pageCount = totalPages();
    pager.style.display = favorites.length > PAGE_SIZE ? "flex" : "none";
    if (favorites.length > PAGE_SIZE) {
      pager.querySelector(".rf-page-label").textContent = `Page ${currentPage + 1} of ${pageCount}`;
      pager.querySelector("[data-page-prev]").disabled = currentPage === 0;
      pager.querySelector("[data-page-next]").disabled = currentPage >= pageCount - 1;
    }

    const addCurrentButton = panel.querySelector("[data-add-current]");
    addCurrentButton.disabled = !activeRoomId || isCurrentRoomFavorited;
    addCurrentButton.textContent = isCurrentRoomFavorited
      ? "Current room favorited"
      : activeRoomId
        ? `Favorite current room (${activeRoomId})`
        : "Not in a room";

    panel.querySelector(".rf-count").textContent = `${favorites.length} / ${MAX_FAVORITES} favorites`;

    const addErrorEl = panel.querySelector(".rf-add-error");
    addErrorEl.textContent = addError;
    addErrorEl.style.display = addError ? "block" : "none";

    panel.querySelector(".rf-footer").textContent = lastFetchError
      ? `Status error: ${lastFetchError}`
      : fetching
        ? "Refreshing status..."
        : "Status updates automatically";

    const connectionDot = panel.querySelector(".rf-connection-dot");
    const connectionLabel = panel.querySelector(".rf-connection-label");
    connectionDot.classList.toggle("rf-dot-online", hasConnectedOnce);
    connectionLabel.textContent = hasConnectedOnce ? "Connected" : "Connecting...";

    const versionEl = panel.querySelector(".rf-version");
    const isOutdated = remoteVersion && compareVersions(remoteVersion, SCRIPT_VERSION) > 0;
    versionEl.classList.toggle("rf-version-outdated", !!isOutdated);
    versionEl.textContent = isOutdated
      ? `Update available (v${remoteVersion})`
      : remoteVersion
        ? `v${SCRIPT_VERSION} \u2014 Up to date`
        : versionCheckError
          ? `v${SCRIPT_VERSION}`
          : `v${SCRIPT_VERSION} \u2014 Checking...`;
    versionEl.title = versionCheckError || "";

    panel.querySelectorAll("[data-join]").forEach((b) => (b.onclick = () => joinRoom(b.dataset.join)));
    panel.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => removeFavorite(b.dataset.remove)));

    panel.querySelectorAll("[data-drag-index]").forEach((row) => {
      row.addEventListener("dragstart", () => {
        dragSourceIndex = Number(row.dataset.dragIndex);
        row.classList.add("rf-dragging");
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("rf-dragging");
        dragSourceIndex = null;
      });
      row.addEventListener("dragover", (e) => e.preventDefault());
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        if (dragSourceIndex != null) reorderFavorites(dragSourceIndex, Number(row.dataset.dragIndex));
      });
    });
  }

  // ============================================================
  // Mount
  // ============================================================
  function mount() {
    const style = document.createElement("style");
    style.textContent = `
      #rf-button{position:fixed;left:10px;bottom:56px;z-index:2147483647;width:32px;height:32px;padding:0;display:grid;place-items:center;border:1px solid #3a3320;border-radius:8px;background:rgba(20,17,8,.85);color:#ffd76a;font-size:16px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45)}
      #rf-panel{position:fixed;left:48px;bottom:56px;z-index:2147483647;width:320px;max-height:65vh;display:flex;flex-direction:column;overflow:hidden;background:#0c0c11;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 18px 55px rgba(0,0,0,.6);color:#e4e4e7;font:12px/1.4 system-ui,sans-serif}
      #rf-panel[hidden]{display:none}
      #rf-panel header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:700}
      #rf-panel header button{background:none;border:0;color:#999;cursor:pointer;font-size:14px}
      .rf-body{overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px}
      .rf-count{color:#888;font-size:10px;text-align:right}
      .rf-list{display:flex;flex-direction:column;gap:6px}
      .rf-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:6px;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:rgba(255,255,255,.03);cursor:grab}
      .rf-row.rf-dragging{opacity:.4}
      .rf-drag-handle{color:#555;font-size:12px;line-height:1;letter-spacing:-2px;padding:0 2px}
      .rf-row-current{border-color:rgba(74,222,128,.4);background:rgba(74,222,128,.06)}
      .rf-info{min-width:0;display:flex;flex-direction:column;gap:4px}
      .rf-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
      .rf-status-row{display:flex;align-items:center;gap:6px}
      .rf-avatars{display:flex;align-items:center}
      .rf-avatar{width:18px;height:18px;border-radius:50%;object-fit:cover;margin-right:-6px;border:1px solid #0c0c11;background:#333}
      .rf-avatar-fallback{display:grid;place-items:center;font-size:9px;font-weight:700;color:#ddd;background:#3a3a44}
      .rf-avatars img.rf-avatar:last-child,.rf-avatars span.rf-avatar-fallback:last-child{margin-right:0}
      .rf-status{color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .rf-status.rf-online{color:#4ade80}
      .rf-status.rf-empty-badge{color:#888}
      .rf-status.rf-private{color:#f59e0b}
      .rf-status.rf-you-here{color:#4ade80;font-weight:600}
      .rf-empty{color:#888;text-align:center;padding:10px 0}
      #rf-panel button{padding:5px 8px;border:1px solid rgba(255,255,255,.1);border-radius:6px;color:#ddd;background:rgba(255,255,255,.05);cursor:pointer;font:600 11px system-ui,sans-serif}
      #rf-panel button:hover{color:#fff;border-color:rgba(255,215,106,.4)}
      #rf-panel button:disabled{opacity:.35;cursor:default}
      .rf-here-badge{color:#4ade80;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.08)}
      .rf-danger{color:#f87171}
      .rf-add-row{display:flex;gap:6px}
      .rf-add-row input{flex:1;min-width:0;padding:5px 8px;border:1px solid rgba(255,255,255,.1);border-radius:6px;background:#08080c;color:#eee;outline:none}
      .rf-add-error{color:#f87171;font-size:10.5px;display:none}
      .rf-pager{display:none;align-items:center;justify-content:space-between;gap:6px;padding-top:2px}
      .rf-page-label{color:#999;font-size:10.5px}
      .rf-footer{color:#666;font-size:10px;text-align:center;padding-top:2px}
      .rf-footer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06);font-size:10px}
      .rf-connection{display:flex;align-items:center;gap:5px;color:#888}
      .rf-connection-dot{width:7px;height:7px;border-radius:50%;background:#555}
      .rf-connection-dot.rf-dot-online{background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,.6)}
      .rf-version{color:#888}
      .rf-version.rf-version-outdated{color:#f87171;font-weight:700}
    `;
    document.head.appendChild(style);

    const button = document.createElement("button");
    button.id = "rf-button";
    button.textContent = "\u2605";
    button.title = "Saved Rooms";
    document.body.appendChild(button);

    const panel = document.createElement("div");
    panel.id = "rf-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <header><span>Room Favorites</span><button data-close>&times;</button></header>
      <div class="rf-body">
        <button data-add-current></button>
        <div class="rf-add-row">
          <input data-add-input placeholder="Add room by ID">
          <button data-add>Add</button>
        </div>
        <div class="rf-add-error"></div>
        <div class="rf-count"></div>
        <div class="rf-list"></div>
        <div class="rf-pager">
          <button data-page-prev>&larr; Prev</button>
          <span class="rf-page-label"></span>
          <button data-page-next>Next &rarr;</button>
        </div>
        <div class="rf-footer"></div>
        <div class="rf-footer-row">
          <span class="rf-connection"><span class="rf-connection-dot"></span><span class="rf-connection-label">Connecting...</span></span>
          <span class="rf-version"></span>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const panelManager = getPanelManager();
    panelManager.register(PANEL_ID, panel, button, () => { panel.hidden = true; });

    button.onclick = (e) => {
      e.stopPropagation();
      if (panel.hidden) {
        panelManager.closeAllExcept(PANEL_ID);
        panel.hidden = false;
        render();
        fetchRoomStatus();
      } else {
        panel.hidden = true;
      }
    };
    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.querySelector("[data-close]").onclick = () => (panel.hidden = true);
    panel.querySelector("[data-add-current]").onclick = () => {
      const roomId = currentRoomId();
      if (roomId) addFavorite(roomId);
    };
    panel.querySelector("[data-add]").onclick = () => {
      const input = panel.querySelector("[data-add-input]");
      addFavorite(input.value.trim());
      input.value = "";
    };
    panel.querySelector("[data-add-input]").addEventListener("keydown", (e) => {
      if (e.key === "Enter") panel.querySelector("[data-add]").click();
    });
    panel.querySelector("[data-page-prev]").onclick = () => { currentPage -= 1; render(); };
    panel.querySelector("[data-page-next]").onclick = () => { currentPage += 1; render(); };

    render();
    fetchRoomStatus();
    subscribeToRoomPatches((_patches, fullState) => {
      hasConnectedOnce = true;
      localRoom = { id: currentRoomId(), players: readLocalPlayers(fullState?.data) };
      render();
    });
    checkForUpdate();
    setInterval(checkForUpdate, VERSION_CHECK_INTERVAL_MS);
    setInterval(() => {
      if (!panel.hidden) fetchRoomStatus();
    }, STATUS_REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();