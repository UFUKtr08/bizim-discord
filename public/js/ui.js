import {
    socket,
    ALLOWED_REACTIONS,
    state,
    $,
    escapeHTML,
    showToast,
    openModal,
    closeDrawers,
    getInitials,
    renderAvatarContent,
    copyText,
    canActOn,
    canManageRole,
    saveUserVolumes,
    compressImageFile
} from "./state.js";
import { setPeerAudioVolume } from "./audio.js";
import { joinVoiceChannel, refreshVoiceMembersCacheFrom } from "./webrtc.js";
import {
    formatMessageBody,
    renderReadyCheckBanner,
    renderPollsList,
    applyWatchState,
    applyBoardState,
    openDmWith
} from "./tools.js";

// Sürükle-bırak ses kanalı taşıma durumu
let draggedVoiceMember = null;

function clearVoiceDropHighlights() {
    document.querySelectorAll(".voice-drop-target").forEach((el) => el.classList.remove("voice-drop-target"));
    document.querySelectorAll(".voice-dragging").forEach((el) => el.classList.remove("voice-dragging"));
}

function canDragMemberBetweenVoice(m) {
    if (!state.me || !m || !m.online || !m.voiceChannel) return false;
    const isSelf = m.username === state.me.username;
    if (isSelf) return true;
    const canMovePerm = Boolean(state.myPermissions.administrator || state.myPermissions.moveMembers);
    return canMovePerm && canActOn(m);
}

function attachVoiceDragSource(el, m) {
    if (!canDragMemberBetweenVoice(m)) return;
    el.draggable = true;
    el.classList.add("voice-draggable");
    el.title = el.title
        ? `${el.title} • Başka ses kanalına sürükle-bırak`
        : "Başka ses kanalına taşımak için sürükle-bırak";

    el.addEventListener("dragstart", (e) => {
        draggedVoiceMember = {
            username: m.username,
            displayName: m.displayName || m.username,
            fromChannelId: m.voiceChannel
        };
        el.classList.add("voice-dragging");
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            try {
                e.dataTransfer.setData("text/plain", JSON.stringify(draggedVoiceMember));
            } catch { }
        }
    });

    el.addEventListener("dragend", () => {
        draggedVoiceMember = null;
        clearVoiceDropHighlights();
    });
}

function attachVoiceDropTarget(targetEl, highlightEl, destChannel) {
    targetEl.addEventListener("dragover", (e) => {
        if (!draggedVoiceMember) return;
        if (draggedVoiceMember.fromChannelId === destChannel.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        highlightEl.classList.add("voice-drop-target");
    });

    targetEl.addEventListener("dragleave", (e) => {
        if (!targetEl.contains(e.relatedTarget)) {
            highlightEl.classList.remove("voice-drop-target");
        }
    });

    targetEl.addEventListener("drop", (e) => {
        e.preventDefault();
        highlightEl.classList.remove("voice-drop-target");

        let payload = draggedVoiceMember;
        if (!payload && e.dataTransfer) {
            try {
                payload = JSON.parse(e.dataTransfer.getData("text/plain"));
            } catch { }
        }
        draggedVoiceMember = null;
        clearVoiceDropHighlights();

        if (!payload || !payload.username || payload.fromChannelId === destChannel.id) return;

        if (state.me && payload.username === state.me.username) {
            joinVoiceChannel(state.activeServerId, destChannel.id);
            return;
        }

        socket.emit(
            "member-move-voice",
            {
                serverId: state.activeServerId,
                targetUsername: payload.username,
                targetChannelId: destChannel.id
            },
            (res) => {
                if (!res?.ok) {
                    showToast(res?.error || "Üye taşınamadı.", "err");
                } else {
                    showToast(`${payload.displayName} → "${destChannel.name}" kanalına taşındı.`, "info");
                }
            }
        );
    });
}

// =========================================================================
// BAĞLAM MENÜSÜ, POPOVER, DURUM SEÇİCİ & AYAR SEKMELERİ
// =========================================================================
export function closeContextMenu() {
    $("context-menu")?.classList.remove("show");
}

export function closeToolsPopover() {
    $("tools-popover")?.classList.remove("show");
}

export function openContextMenu(x, y, items) {
    const menu = $("context-menu");
    if (!menu) return;
    menu.innerHTML = "";

    items.forEach((it) => {
        if (it.sep) {
            const sep = document.createElement("div");
            sep.className = "ctx-sep";
            menu.appendChild(sep);
            return;
        }
        const btn = document.createElement("button");
        btn.className = "ctx-item" + (it.danger ? " danger" : "");
        btn.innerHTML = `<span>${it.icon || ""}</span><span>${escapeHTML(it.label)}</span>`;
        btn.onclick = (e) => {
            e.stopPropagation();
            closeContextMenu();
            it.onClick?.();
        };
        menu.appendChild(btn);
    });

    menu.classList.add("show");
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 160;
    const left = Math.min(x, window.innerWidth - mw - 10);
    const top = Math.min(y, window.innerHeight - mh - 10);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
}

export function openPresenceMenu(x, y) {
    const pick = (presence, label) => {
        socket.emit("set-presence", { presence }, (res) => {
            if (!res?.ok) return showToast(res?.error || "Durum değiştirilemedi.", "err");
            if (state.me) state.me.presence = res.presence;
            applyMeUI();
            showToast(`Durumun "${label}" olarak ayarlandı.`, "ok", 2200);
        });
    };

    openContextMenu(x, y, [
        { label: "Çevrimiçi", icon: "🟢", onClick: () => pick("online", "Çevrimiçi") },
        { label: "Meşgul", icon: "🔴", onClick: () => pick("dnd", "Meşgul") },
        { label: "Çevrimdışı (Görünmez)", icon: "⚫", onClick: () => pick("offline", "Çevrimdışı") }
    ]);
}

export function activateSettingsTab(tabId) {
    document.querySelectorAll("#settings-modal .tab-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tab === tabId);
    });
    document.querySelectorAll("#settings-modal .tab-pane").forEach((p) => {
        p.classList.toggle("active", p.id === tabId);
    });
    if (tabId === "tab-server") populateServerSettingsForm();
}

export function showGeneratedRecoveryCode(code) {
    if ($("recovery-code-val")) $("recovery-code-val").textContent = code;
    if ($("recovery-code-box")) $("recovery-code-box").style.display = "flex";
}

// =========================================================================
// PROFİL & SUNUCU SNAPSHOT UYGULAMA
// =========================================================================
export function applyMeUI() {
    if (!state.me) return;
    if ($("me-name")) $("me-name").textContent = state.me.displayName || state.me.username;
    renderAvatarContent($("me-avatar"), state.me);

    const presence = state.me.presence || "online";
    const meAv = $("me-avatar");
    if (meAv) {
        meAv.style.position = "relative";
        meAv.style.overflow = "visible";
        let myDot = $("me-presence-dot");
        if (!myDot) {
            myDot = document.createElement("span");
            myDot.id = "me-presence-dot";
            meAv.appendChild(myDot);
        }
        myDot.className = "presence-dot " + presence;
        meAv.title = "Durumu değiştirmek için tıkla";
        meAv.style.cursor = "pointer";
        meAv.onclick = (e) => {
            e.stopPropagation();
            const r = meAv.getBoundingClientRect();
            openPresenceMenu(r.left, r.top - 125);
        };
    }

    const stLbl = $("me-status");
    if (stLbl) {
        const pMap = { online: "🟢 Çevrimiçi", dnd: "🔴 Meşgul", offline: "⚫ Çevrimdışı" };
        const pTxt = pMap[presence] || "🟢 Çevrimiçi";
        const customStatus = state.me.status && state.me.status !== "Çevrimiçi" ? ` • ${state.me.status}` : "";
        stLbl.textContent = pTxt + customStatus;
        stLbl.title = "Durumu değiştirmek için tıkla";
        stLbl.style.cursor = "pointer";
        stLbl.onclick = (e) => {
            e.stopPropagation();
            const r = stLbl.getBoundingClientRect();
            openPresenceMenu(r.left, r.top - 125);
        };
    }

    if ($("prof-display-name")) $("prof-display-name").value = state.me.displayName || state.me.username;
    if ($("prof-color")) $("prof-color").value = state.me.color || "#5865f2";
    if ($("prof-status")) $("prof-status").value = state.me.status || "Çevrimiçi";
    renderAvatarContent($("prof-avatar-preview"), state.me);
    state.pendingProfileAvatar = undefined;

    if ($("tab-db-btn")) $("tab-db-btn").style.display = state.me.isGlobalAdmin ? "" : "none";
}

export function updateServerPermissionsUI() {
    const canCh = Boolean(state.myPermissions.administrator || state.myPermissions.manageChannels);
    const canSrv = Boolean(state.myPermissions.administrator || state.myPermissions.manageServer);
    const canRole = Boolean(state.myPermissions.administrator || state.myPermissions.manageRoles);

    if ($("btn-quick-add-text")) $("btn-quick-add-text").style.display = canCh ? "" : "none";
    if ($("btn-quick-add-voice")) $("btn-quick-add-voice").style.display = canCh ? "" : "none";

    const showServerTab = canSrv || canRole || !state.isServerOwner;
    if ($("tab-server-btn")) $("tab-server-btn").style.display = showServerTab ? "" : "none";
    if ($("srv-general-section")) $("srv-general-section").style.display = canSrv ? "flex" : "none";
    if ($("srv-roles-section")) $("srv-roles-section").style.display = canRole ? "flex" : "none";

    if ($("btn-leave-server")) $("btn-leave-server").style.display = !state.isServerOwner ? "" : "none";
    if ($("btn-delete-server")) {
        $("btn-delete-server").style.display = (state.isServerOwner || state.me?.isGlobalAdmin) ? "" : "none";
    }
}

export function applyServerSnapshot(snap) {
    if (!snap) return;
    state.activeServerId = snap.serverId;
    state.serverSettings = snap.settings;
    state.channels = snap.channels || [];
    state.roles = snap.roles || [];
    state.members = snap.members || [];
    state.messagesByChannel = snap.messages || {};
    state.myPermissions = snap.myPermissions || {};
    state.myPower = snap.myPower || 0;
    state.isServerOwner = Boolean(snap.isOwner);
    state.activeReadyCheck = snap.readyCheck || null;
    state.serverPolls = snap.polls || [];
    state.watchState = snap.watch || { active: false };
    state.boardState = snap.board || { active: false, strokes: [] };

    if (!state.voiceServerId || state.voiceServerId === state.activeServerId) {
        if (snap.settings?.iceServers) state.voiceIceServers = snap.settings.iceServers;
        state.hasTurnConfigured = Boolean(snap.settings?.hasTurnConfigured);
    }

    if (state.voiceServerId === state.activeServerId) {
        refreshVoiceMembersCacheFrom(state.members);
    }

    const hasCurrentCh = state.channels.some((c) => c.id === state.activeChannelId && c.type === "text");
    if (!hasCurrentCh) {
        const firstText = state.channels.find((c) => c.type === "text");
        state.activeChannelId = firstText ? firstText.id : null;
    }

    if ($("server-name-lbl")) $("server-name-lbl").textContent = state.serverSettings?.name || "BizimDiscord";
    updateServerPermissionsUI();
    renderServerRail();
    renderChannels();
    renderMembers();
    renderActiveChannelHeader();
    renderMessages();
    renderReadyCheckBanner();
    renderPollsList();
    applyWatchState(state.watchState);
    applyBoardState(state.boardState);
    populateServerSettingsForm();
}

// =========================================================================
// ÇOKLU SUNUCU ŞERİDİ & SUNUCU İŞLEMLERİ
// =========================================================================
export function renderServerRail() {
    const listEl = $("server-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    state.myServers.forEach((s) => {
        const btn = document.createElement("button");
        btn.className = "rail-btn" + (s.id === state.activeServerId ? " active" : "");
        btn.title = `${s.name} (${s.onlineCount}/${s.memberCount} çevrimiçi)`;

        if (s.icon && s.icon.startsWith("data:image/")) {
            const img = document.createElement("img");
            img.src = s.icon;
            img.alt = s.name;
            btn.appendChild(img);
        } else {
            btn.textContent = getInitials(s.name);
        }

        if (state.voiceServerId === s.id && state.voiceChannelId) {
            const vInd = document.createElement("span");
            vInd.className = "rail-voice-ind";
            vInd.textContent = "🔊";
            btn.appendChild(vInd);
        }

        btn.onclick = () => selectServer(s.id);
        btn.oncontextmenu = (e) => {
            e.preventDefault();
            showServerContextMenu(e.clientX, e.clientY, s);
        };
        listEl.appendChild(btn);
    });

    if ($("dm-unread-dot")) $("dm-unread-dot").style.display = state.dmUnread ? "block" : "none";
}

export function selectServer(serverId) {
    if (!serverId || serverId === state.activeServerId) return;
    socket.emit("server-select", { serverId }, (res) => {
        if (!res?.ok) {
            showToast(res?.error || "Sunucuya geçilemedi.", "err");
            return;
        }
        state.activeChannelId = null;
        clearReply();
        applyServerSnapshot(res.snapshot);
    });
}

export function showServerContextMenu(x, y, srvObj) {
    const items = [];
    if (srvObj.id === state.activeServerId && state.serverSettings?.inviteCode) {
        items.push({
            label: `Davet Kodunu Kopyala (${state.serverSettings.inviteCode})`,
            icon: "🔗",
            onClick: () =>
                copyText(
                    state.serverSettings.inviteCode,
                    `Davet kodu kopyalandı: ${state.serverSettings.inviteCode}`
                )
        });
    }
    if (
        srvObj.id === state.activeServerId &&
        (state.myPermissions.administrator || state.myPermissions.manageChannels)
    ) {
        items.push({
            label: "Yeni Kanal Oluştur",
            icon: "➕",
            onClick: () => openChannelModal(null, "text")
        });
    }
    if (
        srvObj.id === state.activeServerId &&
        (state.myPermissions.administrator || state.myPermissions.manageServer || state.myPermissions.manageRoles)
    ) {
        items.push({
            label: "Sunucu Ayarları & Roller",
            icon: "🛡️",
            onClick: () => {
                openModal("settings-modal");
                activateSettingsTab("tab-server");
            }
        });
    }
    if (!srvObj.isOwner) {
        items.push({ sep: true });
        items.push({
            label: "Sunucudan Ayrıl",
            icon: "🚪",
            danger: true,
            onClick: () => confirmLeaveServer(srvObj.id, srvObj.name)
        });
    }
    if (items.length) openContextMenu(x, y, items);
}

export function confirmLeaveServer(serverId, name) {
    if (!confirm(`"${name}" sunucusundan ayrılmak istediğine emin misin?`)) return;
    socket.emit("server-leave", { serverId }, (res) => {
        if (!res?.ok) return showToast(res?.error || "Ayrılamadı.", "err");
        state.myServers = res.servers || [];
        showToast(`"${name}" sunucusundan ayrıldın.`, "info");
        if (res.snapshot) applyServerSnapshot(res.snapshot);
        else renderServerRail();
    });
}

// =========================================================================
// KANAL LİSTESİ & SÜRÜKLE-BIRAK SES KANALI TAŞIMA
// =========================================================================
export function renderChannels() {
    const textUl = $("text-channels");
    const voiceUl = $("voice-channels");
    if (!textUl || !voiceUl) return;
    textUl.innerHTML = "";
    voiceUl.innerHTML = "";

    const canManageCh = Boolean(state.myPermissions.administrator || state.myPermissions.manageChannels);

    state.channels.forEach((ch) => {
        const li = document.createElement("li");
        const isActiveText = ch.type === "text" && ch.id === state.activeChannelId;
        const isJoinedVoice =
            ch.type === "voice" &&
            state.voiceServerId === state.activeServerId &&
            state.voiceChannelId === ch.id;

        li.className = "channel-item" + (isActiveText ? " active" : "") + (isJoinedVoice ? " voice-joined" : "");
        li.dataset.channelId = ch.id;

        const left = document.createElement("div");
        left.className = "ch-left";

        const hash = document.createElement("span");
        hash.className = "ch-hash";
        hash.textContent = ch.type === "voice" ? "🔊" : "#";

        const nameSpan = document.createElement("span");
        nameSpan.className = "ch-name";
        nameSpan.textContent = ch.name;

        left.appendChild(hash);
        left.appendChild(nameSpan);

        if (ch.type === "voice" && (ch.isAfk || state.serverSettings?.afkChannelId === ch.id)) {
            const afkTag = document.createElement("span");
            afkTag.className = "ch-afk-tag";
            afkTag.textContent = "AFK";
            left.appendChild(afkTag);
        }

        const right = document.createElement("div");
        right.className = "ch-right";

        if (ch.type === "text" && state.unreadChannels.has(`${state.activeServerId}:${ch.id}`)) {
            const dot = document.createElement("span");
            dot.className = "ch-unread";
            right.appendChild(dot);
        }

        const moreBtn = document.createElement("button");
        moreBtn.className = "ch-more-btn";
        moreBtn.title = "Kanal İşlemleri";
        moreBtn.textContent = "⋯";
        moreBtn.onclick = (e) => {
            e.stopPropagation();
            const rect = moreBtn.getBoundingClientRect();
            openChannelContextMenu(rect.left, rect.bottom + 4, ch, canManageCh);
        };
        right.appendChild(moreBtn);

        li.appendChild(left);
        li.appendChild(right);

        li.onclick = () => {
            if (ch.type === "text") {
                state.activeChannelId = ch.id;
                state.unreadChannels.delete(`${state.activeServerId}:${ch.id}`);
                clearReply();
                renderChannels();
                renderActiveChannelHeader();
                renderMessages();
                closeDrawers();
            } else {
                if (isJoinedVoice) return;
                joinVoiceChannel(state.activeServerId, ch.id);
                closeDrawers();
            }
        };

        li.oncontextmenu = (e) => {
            e.preventDefault();
            openChannelContextMenu(e.clientX, e.clientY, ch, canManageCh);
        };

        let pressTimer = null;
        li.addEventListener(
            "touchstart",
            (e) => {
                const touch = e.touches[0];
                pressTimer = setTimeout(() => {
                    openChannelContextMenu(touch.clientX, touch.clientY, ch, canManageCh);
                }, 550);
            },
            { passive: true }
        );
        li.addEventListener("touchend", () => clearTimeout(pressTimer));
        li.addEventListener("touchmove", () => clearTimeout(pressTimer));

        if (ch.type === "text") {
            textUl.appendChild(li);
        } else {
            // Ses kanalı bırakma hedefi
            attachVoiceDropTarget(li, li, ch);
            voiceUl.appendChild(li);

            const occupants = state.members.filter((m) => m.online && m.voiceChannel === ch.id);
            if (occupants.length) {
                const occUl = document.createElement("ul");
                occUl.className = "voice-occupants";
                // Kanal altındaki üye listesine bırakınca da bu ses kanalına taşı
                attachVoiceDropTarget(occUl, li, ch);

                occupants.forEach((m) => {
                    const occLi = document.createElement("li");
                    const isSpk = m.id && state.speakingMap.get(m.id);
                    occLi.className = "voice-occ-item" + (isSpk ? " speaking" : "");
                    occLi.dataset.voiceUid = m.id || "";

                    const av = document.createElement("div");
                    av.className = "avatar-circle xs";
                    renderAvatarContent(av, m);

                    const nm = document.createElement("span");
                    nm.className = "voice-occ-name";
                    nm.textContent = m.displayName || m.username;

                    const flags = document.createElement("span");
                    flags.className = "voice-occ-flags";
                    const fParts = [];
                    if (m.serverMuted) fParts.push("🔇");
                    else if (m.selfMuted) fParts.push("🎙️✕");
                    if (m.deafened) fParts.push("🎧✕");
                    if (m.camOn) fParts.push("📹");
                    if (m.screenSharing) fParts.push("🖥️");
                    flags.textContent = fParts.join(" ");

                    occLi.appendChild(av);
                    occLi.appendChild(nm);
                    if (fParts.length) occLi.appendChild(flags);

                    attachVoiceDragSource(occLi, m);

                    occLi.oncontextmenu = (e) => {
                        e.preventDefault();
                        openMemberContextMenu(e.clientX, e.clientY, m);
                    };
                    occUl.appendChild(occLi);
                });
                voiceUl.appendChild(occUl);
            }
        }
    });
}

export function openChannelContextMenu(x, y, ch, canManageCh) {
    const items = [];

    items.push({
        label: ch.type === "voice" ? "Ses Kanalına Katıl" : "Kanalı Aç",
        icon: ch.type === "voice" ? "🔊" : "#",
        onClick: () => {
            if (ch.type === "voice") joinVoiceChannel(state.activeServerId, ch.id);
            else {
                state.activeChannelId = ch.id;
                renderChannels();
                renderActiveChannelHeader();
                renderMessages();
            }
        }
    });

    items.push({
        label: "Davet Kodunu Kopyala",
        icon: "🔗",
        onClick: () => {
            const code = state.serverSettings?.inviteCode || "";
            const shareTxt = `${state.serverSettings?.name || "BizimDiscord"} (#${ch.name}) — Davet Kodu: ${code}`;
            copyText(code || shareTxt, `Davet kodu kopyalandı: ${code}`);
        }
    });

    if (canManageCh) {
        items.push({ sep: true });
        items.push({
            label: "Kanalı Düzenle (Ad / Konu)",
            icon: "✏️",
            onClick: () => openChannelModal(ch, ch.type)
        });

        if (ch.type === "voice") {
            const isAlreadyAfk = Boolean(ch.isAfk || state.serverSettings?.afkChannelId === ch.id);
            items.push({
                label: isAlreadyAfk ? "AFK Kanalı İşaretini Kaldır" : "AFK Odası Olarak Ayarla",
                icon: "💤",
                onClick: () => {
                    socket.emit(
                        "channel-update",
                        {
                            serverId: state.activeServerId,
                            channelId: ch.id,
                            isAfk: !isAlreadyAfk
                        },
                        (res) => {
                            if (!res?.ok) showToast(res?.error || "Güncellenemedi.", "err");
                            else showToast(!isAlreadyAfk ? `"${ch.name}" AFK odası yapıldı.` : "AFK odası kaldırıldı.", "ok");
                        }
                    );
                }
            });
        }

        items.push({
            label: "Kanalı Kapat / Sil",
            icon: "🗑️",
            danger: true,
            onClick: () => {
                if (!confirm(`"${ch.name}" kanalı ve içindeki mesajlar kalıcı olarak silinsin mi?`)) return;
                socket.emit("channel-delete", { serverId: state.activeServerId, channelId: ch.id }, (res) => {
                    if (!res?.ok) showToast(res?.error || "Kanal silinemedi.", "err");
                    else showToast(`"${ch.name}" silindi.`, "info");
                });
            }
        });
    }

    openContextMenu(x, y, items);
}

export function openChannelModal(existingCh, defaultType = "text") {
    if ($("ch-modal-err")) $("ch-modal-err").textContent = "";
    if (existingCh) {
        $("ch-modal-title").textContent = "Kanalı Düzenle";
        $("ch-modal-id").value = existingCh.id;
        $("ch-modal-name").value = existingCh.name;
        $("ch-modal-type").value = existingCh.type;
        $("ch-modal-type-wrap").style.display = "none";
        $("ch-modal-topic").value = existingCh.topic || "";
        $("ch-modal-afk-wrap").style.display = existingCh.type === "voice" ? "inline-flex" : "none";
        $("ch-modal-afk").checked = Boolean(existingCh.isAfk || state.serverSettings?.afkChannelId === existingCh.id);
    } else {
        $("ch-modal-title").textContent = "Yeni Kanal Oluştur";
        $("ch-modal-id").value = "";
        $("ch-modal-name").value = "";
        $("ch-modal-type").value = defaultType;
        $("ch-modal-type-wrap").style.display = "block";
        $("ch-modal-topic").value = "";
        $("ch-modal-afk-wrap").style.display = defaultType === "voice" ? "inline-flex" : "none";
        $("ch-modal-afk").checked = false;
    }
    openModal("channel-modal");
    setTimeout(() => $("ch-modal-name")?.focus(), 40);
}

export function renderActiveChannelHeader() {
    const ch = state.channels.find((c) => c.id === state.activeChannelId);
    if ($("active-channel-title")) $("active-channel-title").textContent = ch ? `# ${ch.name}` : "# kanal";
    if ($("active-channel-topic")) $("active-channel-topic").textContent = ch?.topic || "";
}

// =========================================================================
// ÜYE LİSTESİ (DURUM IŞIKLARI, SUNUCU TAKMA AD, SÜRÜKLE-BIRAK & SES)
// =========================================================================
export function renderMembers() {
    const ul = $("user-list");
    if (!ul) return;
    ul.innerHTML = "";

    const onlineList = state.members.filter((m) => m.online && m.presence !== "offline");
    const offlineList = state.members.filter((m) => !m.online || m.presence === "offline");
    if ($("online-count")) $("online-count").textContent = String(onlineList.length);

    const renderSection = (title, list) => {
        if (!list.length) return;
        const hdr = document.createElement("li");
        hdr.className = "member-group-lbl";
        hdr.textContent = `${title} — ${list.length}`;
        ul.appendChild(hdr);

        list.forEach((m) => {
            const isVisibleOnline = m.online && m.presence !== "offline";
            const presenceClass = m.online ? (m.presence || "online") : "offline";

            const li = document.createElement("li");
            li.className = "member-card" + (isVisibleOnline ? "" : " offline");

            const mainRow = document.createElement("div");
            mainRow.className = "member-main";

            const avWrap = document.createElement("div");
            const isSpk = m.id && state.speakingMap.get(m.id);
            avWrap.className = "member-av-wrap" + (isSpk ? " speaking" : "");
            avWrap.dataset.memberUid = m.id || "";

            const av = document.createElement("div");
            av.className = "avatar-circle sm";
            renderAvatarContent(av, m);

            const pDot = document.createElement("span");
            pDot.className = "presence-dot " + presenceClass;
            pDot.title =
                presenceClass === "dnd"
                    ? "Meşgul"
                    : presenceClass === "online"
                        ? "Çevrimiçi"
                        : "Çevrimdışı";

            avWrap.appendChild(av);
            avWrap.appendChild(pDot);

            const info = document.createElement("div");
            info.className = "member-info";

            const nameRow = document.createElement("div");
            nameRow.className = "member-name-row";

            const nameEl = document.createElement("span");
            nameEl.className = "member-name";
            nameEl.textContent = m.displayName || m.username;
            nameEl.style.color = m.topRole?.color || m.color || "";
            nameEl.title = m.nickname
                ? `Sunucu Takma Adı • @${m.username} (${m.globalDisplayName || m.username})`
                : `@${m.username}`;
            nameRow.appendChild(nameEl);

            const flags = [];
            if (m.voiceChannel) flags.push("🔊");
            if (m.serverMuted) flags.push("🔇");
            else if (m.selfMuted) flags.push("🎙️✕");
            if (m.deafened) flags.push("🎧✕");
            if (m.camOn) flags.push("📹");
            if (m.screenSharing) flags.push("🖥️");
            if (flags.length) {
                const fEl = document.createElement("span");
                fEl.className = "member-flags";
                fEl.textContent = flags.join(" ");
                nameRow.appendChild(fEl);
            }

            info.appendChild(nameRow);

            if (m.topRole) {
                const roleBadge = document.createElement("span");
                roleBadge.className = "member-role-badge";
                const rColor = m.topRole.color || "#949ba4";
                roleBadge.style.color = rColor;
                roleBadge.style.borderColor = `${rColor}44`;
                roleBadge.style.background = `${rColor}14`;

                const rDot = document.createElement("span");
                rDot.className = "member-role-dot";
                rDot.style.background = rColor;

                const rTxt = document.createElement("span");
                rTxt.textContent = m.topRole.name;

                roleBadge.appendChild(rDot);
                roleBadge.appendChild(rTxt);
                info.appendChild(roleBadge);
            }

            if (isVisibleOnline && (presenceClass === "dnd" || (m.status && m.status !== "Çevrimiçi"))) {
                const stEl = document.createElement("div");
                stEl.className = "member-status-sub";
                if (presenceClass === "dnd") {
                    stEl.textContent = m.status && m.status !== "Çevrimiçi" ? `Meşgul • ${m.status}` : "Meşgul";
                } else {
                    stEl.textContent = m.status;
                }
                info.appendChild(stEl);
            }

            mainRow.appendChild(avWrap);
            mainRow.appendChild(info);
            li.appendChild(mainRow);

            // Ses kanalındaysa sağ üye listesinden de sürükleyip sol ses kanalına bırakılabilir
            if (m.online && m.voiceChannel) {
                attachVoiceDragSource(li, m);
            }

            const inSameVoice =
                m.online &&
                m.id &&
                state.me &&
                m.username !== state.me.username &&
                state.voiceServerId === state.activeServerId &&
                state.voiceChannelId &&
                m.voiceChannel === state.voiceChannelId;

            if (inSameVoice) {
                const curVol = state.userVolumes.has(m.username) ? state.userVolumes.get(m.username) : 1;
                const volRow = document.createElement("div");
                volRow.className = "member-vol-row";
                volRow.onclick = (e) => e.stopPropagation();

                const lbl = document.createElement("span");
                lbl.textContent = `${Math.round(curVol * 100)}%`;

                const slider = document.createElement("input");
                slider.type = "range";
                slider.min = "0";
                slider.max = "2";
                slider.step = "0.05";
                slider.value = String(curVol);
                slider.oninput = () => {
                    const v = parseFloat(slider.value);
                    lbl.textContent = `${Math.round(v * 100)}%`;
                    state.userVolumes.set(m.username, v);
                    saveUserVolumes();
                    setPeerAudioVolume(m.id, v);
                };

                volRow.appendChild(document.createTextNode("🔈"));
                volRow.appendChild(slider);
                volRow.appendChild(lbl);
                li.appendChild(volRow);
            }

            li.onclick = (e) => openMemberContextMenu(e.clientX, e.clientY, m);
            li.oncontextmenu = (e) => {
                e.preventDefault();
                openMemberContextMenu(e.clientX, e.clientY, m);
            };

            ul.appendChild(li);
        });
    };

    renderSection("Çevrimiçi", onlineList);
    renderSection("Çevrimdışı", offlineList);
}

export function openMemberContextMenu(x, y, m) {
    if (!state.me || !m) return;
    const items = [];

    if (m.username !== state.me.username) {
        items.push({
            label: `Fısıltı Gönder (@${m.username})`,
            icon: "💬",
            onClick: () => openDmWith(m.username)
        });
    } else {
        items.push({
            label: "Durumunu Değiştir (🟢/🔴/⚫)",
            icon: "🟢",
            onClick: () => openPresenceMenu(x, y)
        });
    }

    const canManageRoles = Boolean(state.myPermissions.administrator || state.myPermissions.manageRoles);
    const canEditTargetRoles =
        canManageRoles && (canActOn(m) || (state.isServerOwner && m.username === state.me.username));
    if (canEditTargetRoles) {
        items.push({
            label: "Rollerini Yönet",
            icon: "🏷️",
            onClick: () => openMemberRolesModal(m)
        });
    }

    const canNickPerm = Boolean(
        state.myPermissions.administrator ||
        state.myPermissions.manageNicknames ||
        state.myPermissions.manageServer
    );
    const canSetNick =
        (canNickPerm && canActOn(m)) ||
        (state.isServerOwner && m.username === state.me.username);
    if (canSetNick) {
        items.push({
            label: m.nickname ? `Sunucu Takma Adını Düzenle (${m.nickname})` : "Sunucu Takma Adı Ver",
            icon: "✏️",
            onClick: () => {
                const nextNick = prompt(
                    `${m.globalDisplayName || m.username} için bu sunucudaki takma adı gir (sıfırlamak için boş bırak):`,
                    m.nickname || ""
                );
                if (nextNick === null) return;
                socket.emit(
                    "member-set-nickname",
                    {
                        serverId: state.activeServerId,
                        targetUsername: m.username,
                        nickname: nextNick.trim()
                    },
                    (res) => {
                        if (!res?.ok) showToast(res?.error || "Takma ad güncellenemedi.", "err");
                        else showToast(res.nickname ? `Takma ad "${res.nickname}" yapıldı.` : "Sunucu takma adı sıfırlandı.", "ok");
                    }
                );
            }
        });
    }

    const canMute = Boolean(state.myPermissions.administrator || state.myPermissions.muteMembers) && canActOn(m);
    if (canMute && m.online) {
        items.push({ sep: true });
        items.push({
            label: m.serverMuted ? "Sunucu Susturmasını Kaldır" : "Sunucuda Sustur",
            icon: m.serverMuted ? "🔊" : "🔇",
            onClick: () => {
                socket.emit("member-toggle-mute", { serverId: state.activeServerId, targetUsername: m.username }, (res) => {
                    if (!res?.ok) showToast(res?.error || "İşlem başarısız.", "err");
                });
            }
        });

        if (m.voiceChannel && state.serverSettings?.afkChannelId && m.voiceChannel !== state.serverSettings.afkChannelId) {
            items.push({
                label: "AFK Odasına Taşı",
                icon: "💤",
                onClick: () => {
                    socket.emit("member-move-afk", { serverId: state.activeServerId, targetUsername: m.username }, (res) => {
                        if (!res?.ok) showToast(res?.error || "Taşınamadı.", "err");
                        else showToast(`${m.displayName || m.username} AFK odasına taşındı.`, "info");
                    });
                }
            });
        }
    }

    const canKick = Boolean(state.myPermissions.administrator || state.myPermissions.kickMembers) && canActOn(m);
    if (canKick) {
        items.push({ sep: true });
        items.push({
            label: "Sunucudan At",
            icon: "⛔",
            danger: true,
            onClick: () => {
                if (!confirm(`${m.displayName || m.username} bu sunucudan atılsın mı?`)) return;
                socket.emit("member-kick", { serverId: state.activeServerId, targetUsername: m.username }, (res) => {
                    if (!res?.ok) showToast(res?.error || "Atılamadı.", "err");
                    else showToast(`${m.displayName || m.username} sunucudan atıldı.`, "info");
                });
            }
        });
    }

    if (items.length) openContextMenu(x, y, items);
}

// =========================================================================
// ÜYE ROLLERİ & SUNUCU ROL YÖNETİCİSİ
// =========================================================================
export function openMemberRolesModal(m) {
    state.editingMemberUsername = m.username;
    if ($("mr-title")) $("mr-title").textContent = `Roller — ${m.displayName || m.username}`;
    if ($("mr-err")) $("mr-err").textContent = "";

    const listEl = $("mr-roles-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    const assigned = new Set(m.roleIds || []);

    state.roles.forEach((r) => {
        const manageable = canManageRole(r);
        const row = document.createElement("label");
        row.className = "role-check-item" + (manageable ? "" : " locked");

        const left = document.createElement("span");
        left.className = "check-row";

        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.value = r.id;
        chk.checked = assigned.has(r.id);
        chk.disabled = !manageable;

        const dot = document.createElement("span");
        dot.className = "member-role-dot";
        dot.style.background = r.color;

        const nm = document.createElement("span");
        nm.textContent = r.name;
        nm.style.color = r.color;

        left.appendChild(chk);
        left.appendChild(dot);
        left.appendChild(nm);

        const prio = document.createElement("span");
        prio.className = "role-prio-tag";
        prio.textContent = manageable ? `P:${r.priority}` : `🔒 P:${r.priority}`;

        row.appendChild(left);
        row.appendChild(prio);
        listEl.appendChild(row);
    });

    openModal("member-roles-modal");
}

export function populateServerSettingsForm() {
    if (!state.serverSettings) return;
    if ($("adm-server-name")) $("adm-server-name").value = state.serverSettings.name || "";
    if ($("adm-invite-code")) $("adm-invite-code").value = state.serverSettings.inviteCode || "";
    if (state.serverSettings.turnServer) {
        if ($("adm-turn-url")) $("adm-turn-url").value = state.serverSettings.turnServer.url || "";
        if ($("adm-turn-user")) $("adm-turn-user").value = state.serverSettings.turnServer.username || "";
        if ($("adm-turn-pass")) $("adm-turn-pass").value = state.serverSettings.turnServer.credential || "";
    }

    const afkSel = $("adm-afk-channel");
    if (afkSel) {
        afkSel.innerHTML = '<option value="">Devre Dışı</option>';
        state.channels
            .filter((c) => c.type === "voice")
            .forEach((c) => {
                const opt = document.createElement("option");
                opt.value = c.id;
                opt.textContent = c.name;
                afkSel.appendChild(opt);
            });
        afkSel.value = state.serverSettings.afkChannelId || "";
    }
    if ($("adm-afk-timeout")) $("adm-afk-timeout").value = String(state.serverSettings.afkTimeoutSec ?? 300);

    renderRolesManager();
}

export function renderRolesManager() {
    const listEl = $("roles-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    const selectedId = $("edit-role-id")?.value || "";

    state.roles.forEach((r) => {
        const li = document.createElement("li");
        li.className = "role-list-item" + (r.id === selectedId ? " active" : "");

        const left = document.createElement("span");
        left.style.display = "inline-flex";
        left.style.alignItems = "center";
        left.style.gap = "7px";
        left.innerHTML = `<span class="member-role-dot" style="background:${escapeHTML(r.color)}"></span><span>${escapeHTML(r.name)}</span>`;

        const prio = document.createElement("span");
        prio.className = "role-prio-tag";
        prio.textContent = canManageRole(r) ? `${r.priority}` : `🔒 ${r.priority}`;

        li.appendChild(left);
        li.appendChild(prio);
        li.onclick = () => selectRoleInEditor(r);
        listEl.appendChild(li);
    });

    if (!selectedId && state.roles.length) {
        const editable = state.roles.find((r) => canManageRole(r)) || state.roles[0];
        selectRoleInEditor(editable);
    } else if (selectedId) {
        const current = state.roles.find((r) => r.id === selectedId);
        if (current) fillRoleEditor(current);
    }
}

export function selectRoleInEditor(role) {
    if ($("edit-role-id")) $("edit-role-id").value = role ? role.id : "";
    fillRoleEditor(role);
    renderRolesManager();
}

export function fillRoleEditor(role) {
    if ($("role-editor-err")) $("role-editor-err").textContent = "";
    const editable = !role || canManageRole(role);

    if ($("edit-role-name")) {
        $("edit-role-name").value = role ? role.name : "";
        $("edit-role-name").disabled = !editable;
    }
    if ($("edit-role-color")) {
        $("edit-role-color").value = role ? role.color : "#5865f2";
        $("edit-role-color").disabled = !editable;
    }
    if ($("edit-role-priority")) {
        $("edit-role-priority").value = role ? role.priority : Math.max(1, Math.min(40, state.myPower - 1));
        $("edit-role-priority").disabled = !editable;
    }

    document.querySelectorAll(".role-perm-chk").forEach((chk) => {
        const key = chk.getAttribute("data-perm");
        chk.checked = Boolean(role?.permissions?.[key]);
        const lockAdmin = key === "administrator" && !state.isServerOwner && !state.myPermissions.administrator;
        chk.disabled = !editable || lockAdmin;
    });

    if ($("btn-save-role")) $("btn-save-role").disabled = !editable;
    if ($("btn-delete-role")) {
        $("btn-delete-role").style.display = role && editable && state.roles.length > 1 ? "" : "none";
    }
    if (!editable && $("role-editor-err")) {
        $("role-editor-err").textContent = "Bu rol kendi yetki seviyenize eşit veya üstünde olduğu için kilitli.";
    }
}

// =========================================================================
// METİN SOHBETİ (GÖRSEL + DOSYA KARTI DESTEKLİ)
// =========================================================================
export function createMessageElement(msg) {
    const isMentioned = state.me && msg.text && new RegExp(`@${state.me.username}\\b`, "i").test(msg.text);
    const row = document.createElement("div");
    row.className = "msg-row" + (isMentioned ? " mentioned" : "") + (msg.pinned ? " pinned-msg" : "");
    row.dataset.msgId = msg.id;

    const av = document.createElement("div");
    av.className = "avatar-circle md";
    renderAvatarContent(av, {
        avatar: msg.avatar,
        displayName: msg.displayName,
        username: msg.sender,
        color: msg.color
    });

    const body = document.createElement("div");
    body.className = "msg-body";

    if (msg.replyTo) {
        const rep = document.createElement("div");
        rep.className = "msg-reply-ref";
        rep.textContent = `↪ ${msg.replyTo.sender}: ${msg.replyTo.text || (msg.replyTo.hasFile ? "[Dosya]" : "[Görsel]")}`;
        body.appendChild(rep);
    }

    const head = document.createElement("div");
    head.className = "msg-head";

    const senderEl = document.createElement("span");
    senderEl.className = "msg-sender";
    senderEl.textContent = msg.displayName || msg.sender;
    senderEl.style.color = msg.topRole?.color || msg.color || "var(--text-bright)";
    senderEl.onclick = () => {
        if (state.me && msg.sender !== state.me.username) openDmWith(msg.sender);
    };
    head.appendChild(senderEl);

    if (msg.topRole?.name) {
        const rTag = document.createElement("span");
        rTag.className = "msg-role-tag";
        rTag.style.color = msg.topRole.color || "#949ba4";
        rTag.textContent = msg.topRole.name;
        head.appendChild(rTag);
    }

    const timeEl = document.createElement("span");
    timeEl.className = "msg-time";
    timeEl.textContent = msg.time || "";
    head.appendChild(timeEl);

    if (msg.pinned) {
        const pinEl = document.createElement("span");
        pinEl.className = "msg-pin-flag";
        pinEl.textContent = "📌 Sabitli";
        head.appendChild(pinEl);
    }

    body.appendChild(head);

    if (msg.text) {
        const txtEl = document.createElement("div");
        txtEl.className = "msg-text";
        txtEl.innerHTML = formatMessageBody(msg.text);
        body.appendChild(txtEl);
    }

    if (msg.image) {
        const img = document.createElement("img");
        img.className = "msg-img";
        img.src = msg.image;
        img.alt = "Görsel";
        img.onclick = () => {
            if ($("lightbox-img")) $("lightbox-img").src = msg.image;
            $("lightbox")?.classList.add("show");
        };
        body.appendChild(img);
    }

    if (msg.file && msg.file.url) {
        const card = document.createElement("a");
        card.className = "msg-file-card";
        card.href = msg.file.url;
        card.download = msg.file.name || "dosya";
        card.target = "_blank";
        card.rel = "noopener noreferrer";

        const sz = msg.file.size || 0;
        const sizeTxt = sz >= 1024 * 1024
            ? `${(sz / (1024 * 1024)).toFixed(2)} MB`
            : `${Math.max(1, Math.round(sz / 1024))} KB`;

        card.innerHTML = `
            <span class="msg-file-ico">📄</span>
            <span class="msg-file-meta">
                <strong>${escapeHTML(msg.file.name || "dosya")}</strong>
                <small>${sizeTxt} • İndirmek için tıkla</small>
            </span>
        `;
        body.appendChild(card);
    }

    if (msg.reactions && Object.keys(msg.reactions).length) {
        const rWrap = document.createElement("div");
        rWrap.className = "msg-reactions";
        for (const [emoji, usersArr] of Object.entries(msg.reactions)) {
            const pill = document.createElement("button");
            const isMine = state.me && usersArr.includes(state.me.username);
            pill.className = "react-pill" + (isMine ? " mine" : "");
            pill.title = usersArr.join(", ");
            pill.textContent = `${emoji} ${usersArr.length}`;
            pill.onclick = () => {
                socket.emit("toggle-reaction", {
                    serverId: state.activeServerId,
                    channelId: state.activeChannelId,
                    msgId: msg.id,
                    emoji
                });
            };
            rWrap.appendChild(pill);
        }
        body.appendChild(rWrap);
    }

    const actions = document.createElement("div");
    actions.className = "msg-actions";

    ALLOWED_REACTIONS.slice(0, 3).forEach((emoji) => {
        const b = document.createElement("button");
        b.className = "msg-act-btn";
        b.textContent = emoji;
        b.onclick = () => {
            socket.emit("toggle-reaction", {
                serverId: state.activeServerId,
                channelId: state.activeChannelId,
                msgId: msg.id,
                emoji
            });
        };
        actions.appendChild(b);
    });

    const repBtn = document.createElement("button");
    repBtn.className = "msg-act-btn";
    repBtn.title = "Yanıtla";
    repBtn.textContent = "↩";
    repBtn.onclick = () => setReplyTarget(msg);
    actions.appendChild(repBtn);

    if (state.myPermissions.administrator || state.myPermissions.pinMessages) {
        const pinBtn = document.createElement("button");
        pinBtn.className = "msg-act-btn";
        pinBtn.title = msg.pinned ? "Sabitlemeyi Kaldır" : "Sabitle";
        pinBtn.textContent = "📌";
        pinBtn.onclick = () => {
            socket.emit("toggle-pin", {
                serverId: state.activeServerId,
                channelId: state.activeChannelId,
                msgId: msg.id
            });
        };
        actions.appendChild(pinBtn);
    }

    const isMine = state.me && msg.sender === state.me.username;
    const targetMem = state.members.find((x) => x.username === msg.sender);
    const canDel =
        isMine ||
        ((state.myPermissions.administrator || state.myPermissions.deleteMessages) &&
            (!targetMem || canActOn(targetMem)));
    if (canDel) {
        const delBtn = document.createElement("button");
        delBtn.className = "msg-act-btn";
        delBtn.title = "Sil";
        delBtn.textContent = "🗑️";
        delBtn.onclick = () => {
            socket.emit("delete-message", {
                serverId: state.activeServerId,
                channelId: state.activeChannelId,
                msgId: msg.id
            });
        };
        actions.appendChild(delBtn);
    }

    row.appendChild(av);
    row.appendChild(body);
    row.appendChild(actions);
    return row;
}

export function renderMessages() {
    const box = $("messages");
    if (!box) return;
    box.innerHTML = "";
    const q = ($("search-input")?.value || "").trim().toLowerCase();
    const list = state.messagesByChannel[state.activeChannelId] || [];

    const filtered = q
        ? list.filter(
            (m) =>
                (m.text || "").toLowerCase().includes(q) ||
                (m.sender || "").toLowerCase().includes(q) ||
                (m.file?.name || "").toLowerCase().includes(q)
        )
        : list;

    if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "sys-msg";
        empty.textContent = q ? "Aramanla eşleşen mesaj bulunamadı." : "Henüz mesaj yok. İlk mesajı yaz!";
        box.appendChild(empty);
        return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((m) => frag.appendChild(createMessageElement(m)));
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
}

export function setReplyTarget(msg) {
    state.replyTarget = {
        id: msg.id,
        sender: msg.displayName || msg.sender,
        text: msg.text || "",
        hasImage: Boolean(msg.image),
        hasFile: Boolean(msg.file)
    };
    if ($("reply-text")) {
        const fallback = state.replyTarget.hasFile ? "[Dosya]" : "[Görsel]";
        $("reply-text").textContent = `Yanıtlanıyor: ${state.replyTarget.sender} — ${state.replyTarget.text || fallback}`;
    }
    $("reply-banner")?.classList.add("show");
    $("chat-input")?.focus();
}

export function clearReply() {
    state.replyTarget = null;
    $("reply-banner")?.classList.remove("show");
}

export async function sendChatImage(file) {
    if (!state.activeServerId || !state.activeChannelId) return;
    try {
        const dataUrl = await compressImageFile(file, 1280, 0.8);
        socket.emit("chat-message", {
            serverId: state.activeServerId,
            channelId: state.activeChannelId,
            text: $("chat-input")?.value.trim() || "",
            image: dataUrl,
            replyTo: state.replyTarget
        });
        if ($("chat-input")) $("chat-input").value = "";
        clearReply();
    } catch {
        showToast("Görsel işlenemedi.", "err");
    }
}

export async function sendChatFile(file) {
    if (!state.activeServerId || !state.activeChannelId || !file) return;
    if (file.size > 10 * 1024 * 1024) {
        return showToast("Dosya en fazla 10 MB olabilir.", "err");
    }
    showToast(`Yükleniyor: ${file.name}...`, "info", 2000);
    try {
        const res = await fetch("/api/upload", {
            method: "POST",
            headers: {
                "x-socket-id": socket.id,
                "x-file-name": encodeURIComponent(file.name),
                "x-file-mime": file.type || "application/octet-stream"
            },
            body: file
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) {
            return showToast(data?.error || "Dosya yüklenemedi.", "err");
        }
        socket.emit("chat-message", {
            serverId: state.activeServerId,
            channelId: state.activeChannelId,
            text: $("chat-input")?.value.trim() || "",
            file: data.file,
            replyTo: state.replyTarget
        });
        if ($("chat-input")) $("chat-input").value = "";
        clearReply();
    } catch {
        showToast("Dosya yükleme başarısız.", "err");
    }
}