import {
    socket,
    isElectron,
    SOUNDBOARD_ITEMS,
    state,
    hooks,
    $,
    showToast,
    openModal,
    closeModal,
    closeDrawers,
    toggleDrawer,
    renderAvatarContent,
    copyText,
    compressImageFile
} from "./state.js";

import {
    resumeAudioOnGesture,
    applyOutputDevice,
    playTone,
    playSoundboardSynth,
    clearAllSpeakingVisuals,
    updateGameModeUI,
    updateGateMarkerUI,
    applyPreferences,
    pushOverlayState,
    updateOverlaySettings,
    initElectronSettingsUI,
    loadMediaDevices,
    applyLiveDspToggles,
    buildMicPipeline,
    applyMuteState,
    toggleMute,
    toggleDeafen
} from "./audio.js";

import {
    updateStageLayout,
    removeMediaTile,
    handleIncomingOffer,
    handleIncomingAnswer,
    handleIncomingIce,
    handlePeerJoinedVoice,
    closePeer,
    refreshVoiceMembersCacheFrom,
    updateVoicePanelUI,
    leaveVoiceCleanup,
    handleVoiceAfkMoved,
    toggleCamera,
    restartCameraTrack,
    flipCamera,
    openScreenShareFlow,
    startScreenCapture
} from "./webrtc.js";

import {
    updateHealthPill,
    startHealthPolling,
    stopHealthPolling,
    startPingLoop
} from "./health.js";

import {
    renderReadyCheckBanner,
    renderPollsList,
    applyWatchState,
    initSoundboardGrid,
    redrawBoard,
    applyBoardState,
    initTacticBoardEvents,
    renderDmConversations,
    appendDmBubble,
    openDmModal,
    openDmWith
} from "./tools.js";

import {
    closeContextMenu,
    closeToolsPopover,
    activateSettingsTab,
    showGeneratedRecoveryCode,
    applyMeUI,
    updateServerPermissionsUI,
    applyServerSnapshot,
    renderServerRail,
    selectServer,
    showServerContextMenu,
    confirmLeaveServer,
    renderChannels,
    openChannelModal,
    renderActiveChannelHeader,
    renderMembers,
    populateServerSettingsForm,
    fillRoleEditor,
    createMessageElement,
    renderMessages,
    clearReply,
    sendChatImage,
    sendChatFile
} from "./ui.js";

// =========================================================================
// SERVICE WORKER & MODÜL KANCALARI
// =========================================================================
if ("serviceWorker" in navigator && !window.electronAPI) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => { });
    });
}

hooks.renderServerRail = renderServerRail;
hooks.renderChannels = renderChannels;
hooks.renderMembers = renderMembers;
hooks.updateVoicePanelUI = updateVoicePanelUI;
hooks.updateHealthPill = updateHealthPill;
hooks.startHealthPolling = startHealthPolling;
hooks.stopHealthPolling = stopHealthPolling;
hooks.closeContextMenu = closeContextMenu;
hooks.closeToolsPopover = closeToolsPopover;
hooks.openDmWith = openDmWith;

// =========================================================================
// EKSİK HTML ÖĞELERİNİ OTOMATİK ENJEKTE ET (📎, GİRİŞ DURUMU, YENİ YETKİLER)
// =========================================================================
function ensureDynamicUIControls() {
    // 1) Dosya yükleme (📎) butonu yoksa #btn-img yanına otomatik oluştur
    if (!$("btn-file") && $("btn-img")) {
        const btnFile = document.createElement("button");
        btnFile.type = "button";
        btnFile.id = "btn-file";
        btnFile.className = $("btn-img").className || "icon-btn";
        btnFile.title = "Dosya Gönder (Maks 10 MB)";
        btnFile.textContent = "📎";
        $("btn-img").insertAdjacentElement("afterend", btnFile);
    }
    if (!$("file-input") && $("btn-file")) {
        const fInp = document.createElement("input");
        fInp.type = "file";
        fInp.id = "file-input";
        fInp.hidden = true;
        $("btn-file").insertAdjacentElement("afterend", fInp);
    }

    // 2) Beni Hatırla kutucuğunu varsayılan işaretli yap
    if ($("auth-remember")) {
        $("auth-remember").checked = true;
    }

    // 3) Giriş sekmesine varsayılanı Yeşil (Çevrimiçi) olan giriş durum seçicisi ekle
    if (!$("auth-presence") && $("btn-login")) {
        const wrap = document.createElement("div");
        wrap.className = "auth-presence-row";
        wrap.innerHTML = `
            <label for="auth-presence" style="font-size:12px;color:var(--text-muted);">Giriş Durumu:</label>
            <select id="auth-presence" class="auth-presence-select">
                <option value="online" selected>🟢 Çevrimiçi (Varsayılan)</option>
                <option value="dnd">🔴 Meşgul</option>
                <option value="offline">⚫ Çevrimdışı (Görünmez)</option>
            </select>
        `;
        const btnRow = $("btn-login").parentElement;
        if (btnRow?.parentElement) {
            btnRow.parentElement.insertBefore(wrap, btnRow);
        }
    }

    // 4) Rol düzenleyicisinde moveMembers ve manageNicknames kutucukları yoksa otomatik ekle
    const anyPermChk = document.querySelector(".role-perm-chk");
    const permContainer = anyPermChk?.closest("label")?.parentElement;
    if (permContainer) {
        const extras = [
            { key: "moveMembers", label: "Üyeleri Ses Kanalından Kanala Taşı (Sürükle-Bırak)" },
            { key: "manageNicknames", label: "Alt Yetkililere Sunucu Takma Adı Ver" }
        ];
        extras.forEach(({ key, label }) => {
            if (!document.querySelector(`.role-perm-chk[data-perm="${key}"]`)) {
                const lbl = document.createElement("label");
                lbl.className = "check-row";
                lbl.innerHTML = `<input type="checkbox" class="role-perm-chk" data-perm="${key}" /> <span>${label}</span>`;
                permContainer.appendChild(lbl);
            }
        });
    }
}

// =========================================================================
// YEREL MASTER DB OTOMATİK GERİ YÜKLEME & MANUEL GİRİŞ SONRASI SENKRON
// =========================================================================
let localDbSyncInProgress = false;

function summarizeLocalDB(localDB) {
    const localUsers = Object.keys(localDB?.users || {}).length;
    let localMessages = 0;
    for (const srv of Object.values(localDB?.servers || {})) {
        for (const arr of Object.values(srv?.messages || {})) {
            if (Array.isArray(arr)) localMessages += arr.length;
        }
    }
    return { localUsers, localMessages };
}

async function syncLocalDbWithServerIfNeeded({ silentIfDenied = false } = {}) {
    if (!isElectron || localDbSyncInProgress) return false;
    localDbSyncInProgress = true;

    try {
        const localDB = await window.electronAPI.dbLoad();
        if (!localDB || !localDB.users) return false;

        const { localUsers, localMessages } = summarizeLocalDB(localDB);
        if (localUsers === 0) return false;

        const checkInfo = await new Promise((resolve) => {
            socket.emit("check-db-needs-restore", { localUsers, localMessages }, (res) => {
                if (typeof res === "boolean") resolve({ needsRestore: res, requiresSecret: false });
                else resolve(res || { needsRestore: false, requiresSecret: false });
            });
        });

        if (!checkInfo.needsRestore) return false;

        const savedSecret = localStorage.getItem("bd_backup_secret") || "";
        const savedToken = localStorage.getItem("bd_token") || "";

        return await new Promise((resolve) => {
            socket.emit(
                "restore-db",
                { db: localDB, backupSecret: savedSecret, sessionToken: savedToken },
                (res) => {
                    if (res?.ok) {
                        showToast(
                            res.migratedFromV4
                                ? "v4.0 yerel veritabanınız v5.x formatına veri kaybı olmadan aktarıldı!"
                                : `Yerel PC veritabanı sunucuyla eşitlendi (${res.userCount || localUsers} üye).`,
                            "ok",
                            4500
                        );
                        resolve(true);
                    } else {
                        if (!silentIfDenied && checkInfo.requiresSecret && !savedSecret) {
                            showToast(
                                "Sunucu sıfırlanmış: Yönetici olarak giriş yapınca veya BACKUP_SECRET girince PC DB otomatik yüklenecek.",
                                "info",
                                5500
                            );
                        }
                        resolve(false);
                    }
                }
            );
        });
    } catch {
        return false;
    } finally {
        localDbSyncInProgress = false;
    }
}

function handleLoginSuccess(res) {
    state.me = res.me;
    state.myServers = res.servers || [];
    state.activeServerId = res.activeServerId;

    if (res.token) localStorage.setItem("bd_token", res.token);
    $("auth-overlay")?.classList.remove("show");
    if ($("auth-err")) $("auth-err").textContent = "";

    applyMeUI();
    renderServerRail();
    if (res.snapshot) applyServerSnapshot(res.snapshot);

    if (state.afkExempt) {
        socket.emit("update-profile", { afkExempt: true });
    }

    if (isElectron && state.me?.isGlobalAdmin) {
        syncLocalDbWithServerIfNeeded({ silentIfDenied: true });
    }

    loadMediaDevices().catch(() => { });
}

async function bootSequence() {
    await syncLocalDbWithServerIfNeeded({ silentIfDenied: false });

    const savedToken = localStorage.getItem("bd_token");
    if (savedToken) {
        // Otomatik girişte aksini seçmediği için her zaman yeşil (online) başlar
        socket.emit("login-token", { token: savedToken, initialPresence: "online" }, (res) => {
            if (res?.ok) {
                handleLoginSuccess(res);
            } else if (res && res.ok === false) {
                localStorage.removeItem("bd_token");
            }
        });
    }
}

// =========================================================================
// TÜM ARAYÜZ OLAY BAĞLANTILARI
// =========================================================================
function bindAllUIEvents() {
    ensureDynamicUIControls();

    document.addEventListener("pointerdown", resumeAudioOnGesture, { passive: true });
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#context-menu")) closeContextMenu();
        if (!e.target.closest(".tools-wrap")) closeToolsPopover();
    });

    document.querySelectorAll("[data-close]").forEach((btn) => {
        btn.onclick = () => closeModal(btn.getAttribute("data-close"));
    });
    $("lightbox").onclick = () => $("lightbox").classList.remove("show");
    $("drawer-backdrop").onclick = closeDrawers;
    $("btn-mobile-left").onclick = () => toggleDrawer("left");
    $("btn-mobile-right").onclick = () => toggleDrawer("right");
    $("btn-mobile-right-close").onclick = closeDrawers;

    // Auth 3 sekmeli geçiş (Giriş / Kayıt / Şifre Kurtarma)
    const switchAuthTab = (target) => {
        const tabs = [
            { key: "login", btn: $("auth-tab-login"), pane: $("auth-pane-login") },
            { key: "register", btn: $("auth-tab-register"), pane: $("auth-pane-register") },
            { key: "recover", btn: $("auth-tab-recover"), pane: $("auth-pane-recover") }
        ];
        tabs.forEach(({ key, btn, pane }) => {
            btn?.classList.toggle("active", key === target);
            pane?.classList.toggle("active", key === target);
        });
        if ($("auth-err")) $("auth-err").textContent = "";
    };

    if ($("auth-tab-login")) $("auth-tab-login").onclick = () => switchAuthTab("login");
    if ($("auth-tab-register")) $("auth-tab-register").onclick = () => switchAuthTab("register");
    if ($("auth-tab-recover")) $("auth-tab-recover").onclick = () => switchAuthTab("recover");

    $("btn-copy-rec-code").onclick = () => {
        const val = $("recovery-code-val").textContent.trim();
        if (val) copyText(val, "Kişisel kurtarma kodu kopyalandı.");
    };

    $("btn-dismiss-rec-code").onclick = () => {
        $("recovery-code-box").style.display = "none";
        $("recovery-code-val").textContent = "";
    };

    $("btn-do-recover").onclick = () => {
        const username = $("rec-user").value.trim();
        const recoveryCode = $("rec-code").value.trim();
        const newPassword = $("rec-new-pass").value;
        $("auth-err").textContent = "";

        socket.emit("reset-password-recovery", { username, recoveryCode, newPassword }, (res) => {
            if (!res?.ok) {
                $("auth-err").textContent = res?.error || "Kurtarma başarısız.";
                return;
            }
            $("rec-code").value = "";
            $("rec-new-pass").value = "";
            $("auth-user").value = username;
            $("auth-pass").value = "";
            switchAuthTab("login");
            showGeneratedRecoveryCode(res.newRecoveryCode);
            showToast("Şifren yenilendi! Yeni kurtarma kodunu kaydet.", "ok", 5000);
        });
    };

    $("btn-regen-my-recovery").onclick = () => {
        socket.emit("regenerate-recovery-code", {}, (res) => {
            if (!res?.ok) return showToast(res?.error || "Kod üretilemedi.", "err");
            $("my-recovery-display").style.display = "block";
            $("my-recovery-display").textContent = `Yeni Kurtarma Kodun: ${res.recoveryCode}`;
            copyText(res.recoveryCode, "Yeni kurtarma kodu üretildi ve kopyalandı.");
        });
    };

    // Ayarlar & Sunucu Ekle sekmeleri
    document.querySelectorAll("#settings-modal .tab-btn").forEach((btn) => {
        btn.onclick = () => activateSettingsTab(btn.dataset.tab);
    });

    document.querySelectorAll("#server-add-modal .tab-btn").forEach((btn) => {
        btn.onclick = () => {
            const target = btn.dataset.mtab;
            document.querySelectorAll("#server-add-modal .tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
            document.querySelectorAll("#server-add-modal .tab-pane").forEach((p) => p.classList.toggle("active", p.id === target));
        };
    });

    // Giriş
    const doLogin = () => {
        const username = $("auth-user").value.trim();
        const password = $("auth-pass").value;
        const remember = $("auth-remember").checked;
        const initialPresence = $("auth-presence")?.value || "online";
        $("auth-err").textContent = "";
        socket.emit("login", { username, password, remember, initialPresence }, (res) => {
            if (!res?.ok) $("auth-err").textContent = res?.error || "Giriş başarısız.";
            else handleLoginSuccess(res);
        });
    };

    $("btn-login").onclick = doLogin;
    $("auth-pass").addEventListener("keydown", (e) => {
        if (e.key === "Enter") doLogin();
    });

    // Kayıt (Davet Kodu Zorunlu)
    const doRegister = () => {
        const username = ($("reg-user")?.value || "").trim();
        const password = $("reg-pass")?.value || "";
        const inviteCode = ($("reg-invite")?.value || "").trim();
        $("auth-err").textContent = "";

        if (!inviteCode) {
            $("auth-err").textContent = "Kayıt olmak için geçerli bir sunucu davet kodu gerekli.";
            $("reg-invite")?.focus();
            return;
        }

        socket.emit("register", { username, password, inviteCode }, (res) => {
            if (!res?.ok) {
                $("auth-err").textContent = res?.error || "Kayıt başarısız.";
                return;
            }
            if ($("reg-pass")) $("reg-pass").value = "";
            if ($("reg-invite")) $("reg-invite").value = "";
            if ($("auth-user")) $("auth-user").value = username;
            if ($("auth-pass")) $("auth-pass").value = "";
            switchAuthTab("login");
            if (res.recoveryCode) showGeneratedRecoveryCode(res.recoveryCode);
            showToast("Hesap oluşturuldu! Kurtarma kodunu kaydettikten sonra giriş yapabilirsin.", "ok", 5000);
        });
    };

    $("btn-register").onclick = doRegister;
    $("reg-invite")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doRegister();
    });

    $("btn-logout").onclick = () => {
        if (!confirm("Hesaptan çıkış yapmak istiyor musun?")) return;
        const tok = localStorage.getItem("bd_token");
        socket.emit("logout", tok);
        localStorage.removeItem("bd_token");
        leaveVoiceCleanup(true);
        location.reload();
    };

    // Sunucu Şeridi & Başlık
    $("btn-dm-rail").onclick = openDmModal;
    $("btn-add-server").onclick = () => {
        $("join-server-code").value = "";
        $("join-server-err").textContent = "";
        $("create-server-name").value = "";
        $("create-server-err").textContent = "";
        openModal("server-add-modal");
    };

    $("btn-server-menu").onclick = (e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        const cur = state.myServers.find((s) => s.id === state.activeServerId);
        if (cur) showServerContextMenu(rect.left, rect.bottom + 6, cur);
    };

    $("btn-confirm-join-server").onclick = () => {
        const code = $("join-server-code").value.trim();
        $("join-server-err").textContent = "";
        socket.emit("server-join", { inviteCode: code }, (res) => {
            if (!res?.ok) {
                $("join-server-err").textContent = res?.error || "Katılınamadı.";
                return;
            }
            state.myServers = res.servers || [];
            closeModal("server-add-modal");
            applyServerSnapshot(res.snapshot);
            showToast(`"${res.snapshot.settings.name}" sunucusuna katıldın!`, "ok");
        });
    };

    $("btn-confirm-create-server").onclick = () => {
        const name = $("create-server-name").value.trim();
        $("create-server-err").textContent = "";
        socket.emit("server-create", { name }, (res) => {
            if (!res?.ok) {
                $("create-server-err").textContent = res?.error || "Oluşturulamadı.";
                return;
            }
            state.myServers = res.servers || [];
            closeModal("server-add-modal");
            applyServerSnapshot(res.snapshot);
            showToast(`"${name}" oluşturuldu! Davet kodu: ${res.snapshot.settings.inviteCode}`, "ok", 4500);
        });
    };

    // Kanal oluşturma / düzenleme
    $("btn-quick-add-text").onclick = () => openChannelModal(null, "text");
    $("btn-quick-add-voice").onclick = () => openChannelModal(null, "voice");
    $("ch-modal-type").onchange = () => {
        $("ch-modal-afk-wrap").style.display = $("ch-modal-type").value === "voice" ? "inline-flex" : "none";
    };

    $("btn-save-channel").onclick = () => {
        const chId = $("ch-modal-id").value;
        const name = $("ch-modal-name").value.trim();
        const type = $("ch-modal-type").value;
        const topic = $("ch-modal-topic").value.trim();
        const isAfk = $("ch-modal-afk").checked;
        $("ch-modal-err").textContent = "";

        if (!name) {
            $("ch-modal-err").textContent = "Kanal adı boş olamaz.";
            return;
        }

        if (chId) {
            socket.emit("channel-update", { serverId: state.activeServerId, channelId: chId, name, topic, isAfk }, (res) => {
                if (!res?.ok) $("ch-modal-err").textContent = res?.error || "Güncellenemedi.";
                else {
                    closeModal("channel-modal");
                    showToast("Kanal güncellendi.", "ok");
                }
            });
        } else {
            socket.emit("channel-create", { serverId: state.activeServerId, name, type, topic, isAfk }, (res) => {
                if (!res?.ok) $("ch-modal-err").textContent = res?.error || "Oluşturulamadı.";
                else {
                    closeModal("channel-modal");
                    showToast(`"${name}" kanalı oluşturuldu.`, "ok");
                }
            });
        }
    };

    // Roller & Sunucu Ayarları
    $("btn-save-member-roles").onclick = () => {
        if (!state.editingMemberUsername) return;
        const checkedIds = Array.from(document.querySelectorAll("#mr-roles-list input[type='checkbox']:checked")).map(
            (c) => c.value
        );
        $("mr-err").textContent = "";
        socket.emit(
            "member-set-roles",
            {
                serverId: state.activeServerId,
                targetUsername: state.editingMemberUsername,
                roleIds: checkedIds
            },
            (res) => {
                if (!res?.ok) $("mr-err").textContent = res?.error || "Roller güncellenemedi.";
                else {
                    closeModal("member-roles-modal");
                    showToast("Üye rolleri güncellendi.", "ok");
                }
            }
        );
    };

    $("btn-copy-invite").onclick = () => {
        const code = $("adm-invite-code").value.trim();
        if (code) copyText(code, `Davet kodu kopyalandı: ${code}`);
    };

    $("btn-regen-invite").onclick = () => {
        socket.emit("server-update-settings", { serverId: state.activeServerId, regenerateInvite: true }, (res) => {
            if (!res?.ok) return showToast(res?.error || "Yenilenemedi.", "err");
            $("adm-invite-code").value = res.inviteCode;
            showToast(`Yeni davet kodu: ${res.inviteCode}`, "ok");
        });
    };

    $("btn-save-server-settings").onclick = () => {
        socket.emit(
            "server-update-settings",
            {
                serverId: state.activeServerId,
                name: $("adm-server-name").value.trim(),
                inviteCode: $("adm-invite-code").value.trim(),
                afkChannelId: $("adm-afk-channel").value || "",
                afkTimeoutSec: parseInt($("adm-afk-timeout").value, 10) || 0,
                turnUrl: $("adm-turn-url").value.trim(),
                turnUser: $("adm-turn-user").value.trim(),
                turnPass: $("adm-turn-pass").value.trim()
            },
            (res) => {
                if (!res?.ok) showToast(res?.error || "Kaydedilemedi.", "err");
                else showToast("Sunucu ayarları kaydedildi.", "ok");
            }
        );
    };

    $("btn-leave-server").onclick = () => {
        closeModal("settings-modal");
        confirmLeaveServer(state.activeServerId, state.serverSettings?.name || "Sunucu");
    };

    $("btn-delete-server").onclick = () => {
        if (!confirm(`"${state.serverSettings?.name}" sunucusunu kalıcı olarak silmek istediğine emin misin?`)) return;
        socket.emit("server-delete", { serverId: state.activeServerId }, (res) => {
            if (!res?.ok) return showToast(res?.error || "Silinemedi.", "err");
            state.myServers = res.servers || [];
            closeModal("settings-modal");
            showToast("Sunucu silindi.", "info");
            if (res.snapshot) applyServerSnapshot(res.snapshot);
        });
    };

    $("btn-new-role").onclick = () => {
        $("edit-role-id").value = "";
        fillRoleEditor(null);
        document.querySelectorAll("#roles-list .role-list-item").forEach((el) => el.classList.remove("active"));
        $("edit-role-name").focus();
    };

    $("btn-save-role").onclick = () => {
        const roleId = $("edit-role-id").value;
        const name = $("edit-role-name").value.trim();
        const color = $("edit-role-color").value;
        const priority = parseInt($("edit-role-priority").value, 10) || 10;
        const permissions = {};
        document.querySelectorAll(".role-perm-chk").forEach((chk) => {
            permissions[chk.getAttribute("data-perm")] = chk.checked;
        });
        $("role-editor-err").textContent = "";

        const evt = roleId ? "role-update" : "role-create";
        socket.emit(evt, { serverId: state.activeServerId, roleId, name, color, priority, permissions }, (res) => {
            if (!res?.ok) {
                $("role-editor-err").textContent = res?.error || "Kaydedilemedi.";
                return;
            }
            if (res.role?.id) $("edit-role-id").value = res.role.id;
            showToast(roleId ? "Rol güncellendi." : `"${name}" rolü oluşturuldu.`, "ok");
        });
    };

    $("btn-delete-role").onclick = () => {
        const roleId = $("edit-role-id").value;
        if (!roleId || !confirm("Bu rolü silmek istediğine emin misin?")) return;
        socket.emit("role-delete", { serverId: state.activeServerId, roleId }, (res) => {
            if (!res?.ok) $("role-editor-err").textContent = res?.error || "Silinemedi.";
            else {
                $("edit-role-id").value = "";
                showToast("Rol silindi.", "info");
            }
        });
    };

    // Ekip Araçları
    $("btn-tools-menu").onclick = (e) => {
        e.stopPropagation();
        $("tools-popover").classList.toggle("show");
    };

    document.querySelectorAll("#tools-popover .pop-item").forEach((btn) => {
        btn.onclick = () => {
            const tool = btn.dataset.tool;
            closeToolsPopover();
            if (tool === "ready-check") {
                const title = prompt("Hazır kontrolü başlığı:", "Maça hazır mısınız?");
                if (title === null) return;
                socket.emit("ready-check-start", { serverId: state.activeServerId, title });
            } else if (tool === "poll") {
                $("poll-err").textContent = "";
                renderPollsList();
                openModal("poll-modal");
            } else if (tool === "watch") {
                $("watch-err").textContent = "";
                openModal("watch-modal");
                setTimeout(() => $("watch-url-input").focus(), 40);
            } else if (tool === "soundboard") {
                openModal("soundboard-modal");
            } else if (tool === "board") {
                socket.emit("board-toggle", { serverId: state.activeServerId, active: !state.boardState.active });
            } else if (tool === "dm") {
                openDmModal();
            }
        };
    });

    $("btn-game-mode").onclick = () => {
        state.gameMode = !state.gameMode;
        localStorage.setItem("bd_gamemode", state.gameMode ? "1" : "0");
        updateGameModeUI();
    };

    $("health-pill").onclick = () => openModal("health-modal");
    $("btn-open-health-top").onclick = () => openModal("health-modal");
    $("btn-open-settings").onclick = () => openModal("settings-modal");
    $("btn-profile-quick").onclick = () => {
        openModal("settings-modal");
        activateSettingsTab("tab-overlay");
    };

    $("btn-pins").onclick = () => {
        const list = (state.messagesByChannel[state.activeChannelId] || []).filter((m) => m.pinned);
        const container = $("pins-list");
        container.innerHTML = "";
        if (!list.length) {
            container.innerHTML = '<div class="muted-note center">Bu kanalda sabitlenmiş mesaj yok.</div>';
        } else {
            list.forEach((m) => container.appendChild(createMessageElement(m)));
        }
        openModal("pins-modal");
    };

    $("search-input").oninput = renderMessages;

    document.querySelectorAll("[data-rc-status]").forEach((btn) => {
        btn.onclick = () => {
            if (!state.activeReadyCheck) return;
            socket.emit("ready-check-respond", {
                serverId: state.activeServerId,
                checkId: state.activeReadyCheck.id,
                status: btn.dataset.rcStatus
            });
        };
    });
    $("btn-rc-close").onclick = () => socket.emit("ready-check-close", { serverId: state.activeServerId });

    $("btn-create-poll").onclick = () => {
        const question = $("poll-question").value.trim();
        const options = Array.from(document.querySelectorAll(".poll-opt-inp"))
            .map((i) => i.value.trim())
            .filter(Boolean);
        $("poll-err").textContent = "";
        socket.emit("poll-create", { serverId: state.activeServerId, question, options }, (res) => {
            if (!res?.ok) {
                $("poll-err").textContent = res?.error || "Anket oluşturulamadı.";
                return;
            }
            $("poll-question").value = "";
            document.querySelectorAll(".poll-opt-inp").forEach((i) => { i.value = ""; });
            showToast("Anket yayınlandı!", "ok");
        });
    };

    $("btn-start-watch").onclick = () => {
        const url = $("watch-url-input").value.trim();
        const title = $("watch-title-input").value.trim();
        $("watch-err").textContent = "";
        socket.emit("watch-start", { serverId: state.activeServerId, url, title }, (res) => {
            if (!res?.ok) {
                $("watch-err").textContent = res?.error || "Video başlatılamadı.";
                return;
            }
            $("watch-url-input").value = "";
            $("watch-title-input").value = "";
            closeModal("watch-modal");
        });
    };

    $("btn-watch-play").onclick = () => {
        const cur =
            state.ytPlayer && typeof state.ytPlayer.getCurrentTime === "function"
                ? state.ytPlayer.getCurrentTime()
                : (state.watchState.currentTime || 0);
        socket.emit("watch-sync", { serverId: state.activeServerId, action: "play", currentTime: cur });
    };
    $("btn-watch-pause").onclick = () => {
        const cur =
            state.ytPlayer && typeof state.ytPlayer.getCurrentTime === "function"
                ? state.ytPlayer.getCurrentTime()
                : (state.watchState.currentTime || 0);
        socket.emit("watch-sync", { serverId: state.activeServerId, action: "pause", currentTime: cur });
    };
    $("btn-watch-resync").onclick = () => applyWatchState(state.watchState);
    $("btn-watch-change").onclick = () => openModal("watch-modal");
    $("btn-watch-stop").onclick = () => socket.emit("watch-stop", { serverId: state.activeServerId });

    $("sb-vol-slider").oninput = () => {
        state.soundboardVolume = parseInt($("sb-vol-slider").value, 10);
        $("sb-vol-val").textContent = `${state.soundboardVolume}%`;
        localStorage.setItem("bd_sb_vol", String(state.soundboardVolume));
    };

    document.querySelectorAll("[data-btool]").forEach((btn) => {
        btn.onclick = () => {
            state.boardTool = btn.dataset.btool;
            document.querySelectorAll("[data-btool]").forEach((b) => b.classList.toggle("active", b === btn));
        };
    });
    $("btn-board-undo").onclick = () => socket.emit("board-undo", { serverId: state.activeServerId });
    $("btn-board-clear").onclick = () => socket.emit("board-clear", { serverId: state.activeServerId });
    $("btn-board-close").onclick = () => socket.emit("board-toggle", { serverId: state.activeServerId, active: false });

    $("dm-form").onsubmit = (e) => {
        e.preventDefault();
        if (!state.activeDmPeer) return;
        const text = $("dm-input").value.trim();
        if (!text) return;
        $("dm-input").value = "";
        socket.emit("dm-send", { toUsername: state.activeDmPeer.username, text }, (res) => {
            if (!res?.ok) showToast(res?.error || "Gönderilemedi.", "err");
        });
    };

    // Mesaj, Görsel & Dosya Gönderme
    $("btn-cancel-reply").onclick = clearReply;
    $("btn-img").onclick = () => $("img-input").click();
    $("img-input").onchange = (e) => {
        const file = e.target.files?.[0];
        if (file) sendChatImage(file);
        e.target.value = "";
    };

    if ($("btn-file") && $("file-input")) {
        $("btn-file").onclick = () => $("file-input").click();
        $("file-input").onchange = (e) => {
            const file = e.target.files?.[0];
            if (file) sendChatFile(file);
            e.target.value = "";
        };
    }

    $("chat-input").addEventListener("paste", (e) => {
        const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
        if (item) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) sendChatImage(file);
        }
    });

    $("chat-input").addEventListener("input", () => {
        if (!state.activeServerId || !state.activeChannelId) return;
        if (!state.isCurrentlyTyping) {
            state.isCurrentlyTyping = true;
            socket.emit("typing", { serverId: state.activeServerId, channelId: state.activeChannelId, isTyping: true });
        }
        clearTimeout(state.typingTimeout);
        state.typingTimeout = setTimeout(() => {
            state.isCurrentlyTyping = false;
            socket.emit("typing", { serverId: state.activeServerId, channelId: state.activeChannelId, isTyping: false });
        }, 1800);
    });

    $("chat-form").onsubmit = (e) => {
        e.preventDefault();
        const text = $("chat-input").value.trim();
        if (!text || !state.activeServerId || !state.activeChannelId) return;
        socket.emit("chat-message", {
            serverId: state.activeServerId,
            channelId: state.activeChannelId,
            text,
            replyTo: state.replyTarget
        });
        $("chat-input").value = "";
        clearReply();
        if (state.isCurrentlyTyping) {
            state.isCurrentlyTyping = false;
            socket.emit("typing", { serverId: state.activeServerId, channelId: state.activeChannelId, isTyping: false });
        }
    };

    // Ses / Kamera / Ekran Kontrolleri
    $("btn-mute").onclick = toggleMute;
    $("m-btn-mute").onclick = toggleMute;
    $("btn-deafen").onclick = toggleDeafen;
    $("m-btn-deafen").onclick = toggleDeafen;
    $("btn-cam").onclick = toggleCamera;
    $("m-btn-cam").onclick = toggleCamera;
    $("btn-flip-cam").onclick = flipCamera;
    $("m-btn-flip").onclick = flipCamera;
    $("btn-screen").onclick = openScreenShareFlow;
    $("btn-start-share").onclick = startScreenCapture;
    $("btn-leave-voice").onclick = () => leaveVoiceCleanup(true);
    $("m-btn-leave").onclick = () => leaveVoiceCleanup(true);
    $("btn-exit-spotlight").onclick = () => {
        state.spotlightTileId = null;
        updateStageLayout();
    };
    $("btn-expand-stage").onclick = () => {
        const expanded = $("media-stage").classList.toggle("expanded");
        $("btn-expand-stage").textContent = expanded ? "Küçült" : "Genişlet";
        updateStageLayout();
    };

    // Ses DSP, Tema & Overlay Ayarları
    $("mic-select").onchange = () => { if (state.voiceChannelId) buildMicPipeline().catch(() => { }); };
    $("spk-select").onchange = applyOutputDevice;
    $("cam-select").onchange = () => { if (state.camStream) restartCameraTrack(); };
    $("cam-quality").onchange = () => { if (state.camStream) restartCameraTrack(); };
    $("chk-ns").onchange = () => { if (state.voiceChannelId) buildMicPipeline().catch(() => { }); };
    $("chk-aec").onchange = () => { if (state.voiceChannelId) buildMicPipeline().catch(() => { }); };
    $("chk-agc").onchange = () => { if (state.voiceChannelId) buildMicPipeline().catch(() => { }); };
    $("chk-hpf").onchange = applyLiveDspToggles;
    $("chk-comp").onchange = applyLiveDspToggles;

    $("gate-slider").oninput = () => {
        state.gateThreshold = parseInt($("gate-slider").value, 10);
        localStorage.setItem("bd_gate", String(state.gateThreshold));
        updateGateMarkerUI();
    };

    $("mic-gain").oninput = () => {
        const v = parseFloat($("mic-gain").value);
        $("mic-gain-val").textContent = `${Math.round(v * 100)}%`;
        if (state.micGainNode) state.micGainNode.gain.value = v;
    };

    $("chk-mirror").onchange = () => {
        state.mirrorCam = $("chk-mirror").checked;
        localStorage.setItem("bd_mirror", state.mirrorCam ? "1" : "0");
        const v = document.querySelector("#tile-cam-local video");
        if (v) v.classList.toggle("mirrored", state.mirrorCam);
    };

    $("chk-ptt").onchange = () => {
        state.pttEnabled = $("chk-ptt").checked;
        localStorage.setItem("bd_ptt", state.pttEnabled ? "1" : "0");
        state.pttPressed = false;
        applyMuteState();
    };

    $("btn-ptt-key").onclick = () => {
        state.awaitingPttKey = true;
        $("btn-ptt-key").textContent = "Tuşa bas...";
    };

    $("theme-select").onchange = () => {
        const t = $("theme-select").value;
        localStorage.setItem("bd_theme", t);
        document.body.setAttribute("data-theme", t);
    };
    $("accent-picker").oninput = () => {
        const c = $("accent-picker").value;
        localStorage.setItem("bd_accent", c);
        document.documentElement.style.setProperty("--accent", c);
    };
    $("font-size-select").onchange = () => {
        const sz = $("font-size-select").value;
        localStorage.setItem("bd_fontsize", sz);
        document.documentElement.style.setProperty("--font-size", sz);
    };
    $("chk-afk-exempt").onchange = () => {
        state.afkExempt = $("chk-afk-exempt").checked;
        localStorage.setItem("bd_afk_exempt", state.afkExempt ? "1" : "0");
        socket.emit("update-profile", { afkExempt: state.afkExempt });
    };

    if (isElectron) {
        $("chk-overlay-enabled").onchange = () => updateOverlaySettings({ enabled: $("chk-overlay-enabled").checked });
        $("overlay-pos-select").onchange = () => updateOverlaySettings({ position: $("overlay-pos-select").value });
        $("overlay-size-select").onchange = () => updateOverlaySettings({ size: $("overlay-size-select").value });
        $("btn-overlay-restart").onclick = () => window.electronAPI.relaunchApp();
        $("chk-disable-gpu").onchange = () => {
            if (confirm("GPU donanım hızlandırma ayarı için uygulama yeniden başlatılacak. Devam edilsin mi?")) {
                window.electronAPI.setGpuMode($("chk-disable-gpu").checked);
            } else {
                $("chk-disable-gpu").checked = !$("chk-disable-gpu").checked;
            }
        };
    }

    // Profil & Avatar
    $("btn-pick-avatar").onclick = () => $("prof-avatar-file").click();
    $("prof-avatar-file").onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await compressImageFile(file, 160, 0.85);
            state.pendingProfileAvatar = dataUrl;
            renderAvatarContent($("prof-avatar-preview"), {
                avatar: dataUrl,
                displayName: $("prof-display-name").value,
                username: state.me?.username,
                color: $("prof-color").value
            });
        } catch {
            showToast("Avatar yüklenemedi.", "err");
        }
        e.target.value = "";
    };

    $("btn-clear-avatar").onclick = () => {
        state.pendingProfileAvatar = "";
        renderAvatarContent($("prof-avatar-preview"), {
            avatar: "",
            displayName: $("prof-display-name").value,
            username: state.me?.username,
            color: $("prof-color").value
        });
    };

    $("btn-save-profile").onclick = () => {
        const payload = {
            displayName: $("prof-display-name").value.trim(),
            color: $("prof-color").value,
            status: $("prof-status").value.trim(),
            afkExempt: state.afkExempt
        };
        if (state.pendingProfileAvatar !== undefined) payload.avatar = state.pendingProfileAvatar;

        socket.emit("update-profile", payload, (res) => {
            if (!res?.ok) return showToast("Profil kaydedilemedi.", "err");
            state.me = { ...state.me, ...res.me };
            applyMeUI();
            showToast("Profil güncellendi.", "ok");
            pushOverlayState(true);
        });
    };

    // Veritabanı Yedekleme & Geri Yükleme
    $("db-backup-secret-inp").oninput = () => {
        localStorage.setItem("bd_backup_secret", $("db-backup-secret-inp").value.trim());
    };
    $("db-backup-secret-inp").value = localStorage.getItem("bd_backup_secret") || "";

    $("btn-restore-pc-db").onclick = async () => {
        if (!isElectron) return showToast("Bu özellik masaüstü (Electron) sürümünde çalışır.", "info");
        const data = await window.electronAPI.dbLoad();
        if (!data) return showToast("Bilgisayarda kayıtlı DB dosyası bulunamadı.", "err");
        const secret = $("db-backup-secret-inp").value.trim();
        const savedToken = localStorage.getItem("bd_token") || "";
        socket.emit("restore-db", { db: data, backupSecret: secret, sessionToken: savedToken }, (res) => {
            if (res?.ok) {
                showToast(
                    res.migratedFromV4
                        ? "v4.0 PC veritabanı v5.x'e dönüştürülerek yüklendi!"
                        : `PC veritabanı sunucuya yüklendi (${res.userCount || Object.keys(data.users || {}).length} üye).`,
                    "ok"
                );
            } else {
                showToast(res?.error || "Yüklenemedi.", "err");
            }
        });
    };

    $("btn-export-db").onclick = () => {
        if (!state.latestServerDB) return showToast("Yedek verisi henüz hazır değil.", "err");
        const blob = new Blob([JSON.stringify(state.latestServerDB, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `bizim_discord_v5_db_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    $("btn-import-db").onclick = () => $("db-file-input").click();
    $("db-file-input").onchange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result);
                const secret = $("db-backup-secret-inp").value.trim();
                const savedToken = localStorage.getItem("bd_token") || "";
                socket.emit("restore-db", { db: parsed, backupSecret: secret, sessionToken: savedToken }, (res) => {
                    if (res?.ok) {
                        showToast(
                            res.migratedFromV4
                                ? "v4.0 JSON yedeği v5.x formatına dönüştürülerek geri yüklendi!"
                                : `JSON veritabanı geri yüklendi (${res.userCount || Object.keys(parsed.users || {}).length} üye).`,
                            "ok"
                        );
                    } else {
                        showToast(res?.error || "Geçersiz yedek dosyası.", "err");
                    }
                });
            } catch {
                showToast("JSON dosyası okunamadı.", "err");
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    };

    // Klavye Kısayolları (Web Alt+M / Alt+D + Bas-Konuş) & Sekme Görünürlüğü
    window.addEventListener("keydown", (e) => {
        if (state.awaitingPttKey) {
            e.preventDefault();
            state.awaitingPttKey = false;
            state.pttKey = e.code;
            localStorage.setItem("bd_ptt_key", state.pttKey);
            $("btn-ptt-key").textContent = state.pttKey;
            applyMuteState();
            return;
        }
        if (e.key === "Escape") {
            closeContextMenu();
            closeToolsPopover();
            document.querySelectorAll(".overlay.show").forEach((ov) => {
                if (ov.id !== "auth-overlay") closeModal(ov.id);
            });
            return;
        }
        if (!isElectron && state.voiceChannelId && e.altKey && !e.ctrlKey && !e.metaKey) {
            if (e.code === "KeyM") {
                e.preventDefault();
                toggleMute();
                return;
            }
            if (e.code === "KeyD") {
                e.preventDefault();
                toggleDeafen();
                return;
            }
        }
        if (state.pttEnabled && state.voiceChannelId && e.code === state.pttKey && !state.pttPressed) {
            const tag = document.activeElement?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            state.pttPressed = true;
            applyMuteState();
        }
    });

    window.addEventListener("keyup", (e) => {
        if (state.pttEnabled && e.code === state.pttKey && state.pttPressed) {
            state.pttPressed = false;
            applyMuteState();
        }
    });

    window.addEventListener("blur", () => {
        if (state.pttPressed) {
            state.pttPressed = false;
            applyMuteState();
        }
    });

    document.addEventListener("visibilitychange", () => {
        const videos = document.querySelectorAll("#stage-tiles video");
        if (document.hidden) {
            videos.forEach((v) => v.pause());
            clearAllSpeakingVisuals();
        } else {
            videos.forEach((v) => v.play().catch(() => { }));
            resumeAudioOnGesture();
        }
    });
}

// =========================================================================
// SOCKET.IO OLAY DİNLEYİCİLERİ
// =========================================================================
socket.on("connect", () => {
    bootSequence();
});

socket.on("server-info", (info) => {
    if (!info) return;
    if ($("auth-title")) $("auth-title").textContent = info.serverName || "BizimDiscord";
});

socket.on("db-sync", (fullDB) => {
    if (!fullDB || fullDB.meta?.seededOnly) return;
    state.latestServerDB = fullDB;
    if (isElectron && state.me?.isGlobalAdmin) {
        window.electronAPI.dbSave(fullDB).catch(() => { });
    }
});

socket.on("my-servers-update", (list) => {
    state.myServers = Array.isArray(list) ? list : [];
    renderServerRail();
});

socket.on("server-snapshot-refresh", (snap) => {
    if (snap) applyServerSnapshot(snap);
});

socket.on("server-state-update", (srvState) => {
    if (!srvState) return;

    if (srvState.serverId === state.voiceServerId) {
        if (srvState.settings?.iceServers) state.voiceIceServers = srvState.settings.iceServers;
        state.hasTurnConfigured = Boolean(srvState.settings?.hasTurnConfigured);
        refreshVoiceMembersCacheFrom(srvState.members || []);
        updateVoicePanelUI();
    }

    if (srvState.serverId !== state.activeServerId) return;

    state.serverSettings = srvState.settings;
    state.channels = srvState.channels || [];
    state.roles = srvState.roles || [];
    state.members = srvState.members || [];
    state.myPermissions = srvState.myPermissions || {};
    state.myPower = srvState.myPower || 0;
    state.isServerOwner = Boolean(srvState.isOwner);

    if (!state.voiceServerId) {
        state.hasTurnConfigured = Boolean(srvState.settings?.hasTurnConfigured);
    }

    if (!state.channels.some((c) => c.id === state.activeChannelId && c.type === "text")) {
        const firstText = state.channels.find((c) => c.type === "text");
        state.activeChannelId = firstText ? firstText.id : null;
        renderMessages();
    }

    if ($("server-name-lbl")) $("server-name-lbl").textContent = state.serverSettings?.name || "BizimDiscord";
    updateServerPermissionsUI();
    renderChannels();
    renderMembers();
    renderActiveChannelHeader();

    if ($("settings-modal")?.classList.contains("show") && $("tab-server")?.classList.contains("active")) {
        populateServerSettingsForm();
    }
});

socket.on("server-removed", ({ serverId }) => {
    state.myServers = state.myServers.filter((s) => s.id !== serverId);
    renderServerRail();
    if (state.activeServerId === serverId && state.myServers.length) {
        selectServer(state.myServers[0].id);
    }
});

socket.on("server-kicked", ({ serverId, serverName, by }) => {
    showToast(`${by} tarafından "${serverName}" sunucusundan atıldınız.`, "err", 5000);
    state.myServers = state.myServers.filter((s) => s.id !== serverId);
    renderServerRail();
    if (state.activeServerId === serverId && state.myServers.length) {
        selectServer(state.myServers[0].id);
    }
});

socket.on("kicked", (reason) => {
    leaveVoiceCleanup(false);
    alert(reason || "Bağlantınız sonlandırıldı.");
    location.reload();
});

socket.on("chat-message", (msg) => {
    if (!msg || msg.serverId !== state.activeServerId) return;
    if (!state.messagesByChannel[msg.channelId]) state.messagesByChannel[msg.channelId] = [];
    state.messagesByChannel[msg.channelId].push(msg);

    if (msg.channelId === state.activeChannelId) {
        const box = $("messages");
        const empty = box.querySelector(".sys-msg");
        if (empty) empty.remove();
        box.appendChild(createMessageElement(msg));
        box.scrollTop = box.scrollHeight;
    } else {
        state.unreadChannels.add(`${msg.serverId}:${msg.channelId}`);
        renderChannels();
    }

    if (state.me && msg.sender !== state.me.username) {
        const mentioned = msg.text && new RegExp(`@${state.me.username}\\b`, "i").test(msg.text);
        if (mentioned) playTone(880, 0.11, "triangle", 0.08);
    }
});

socket.on("message-updated", (msg) => {
    if (!msg || msg.serverId !== state.activeServerId) return;
    const arr = state.messagesByChannel[msg.channelId];
    if (!arr) return;
    const idx = arr.findIndex((m) => m.id === msg.id);
    if (idx !== -1) arr[idx] = msg;
    if (msg.channelId === state.activeChannelId) renderMessages();
});

socket.on("message-deleted", ({ serverId, channelId, msgId }) => {
    if (serverId !== state.activeServerId || !state.messagesByChannel[channelId]) return;
    state.messagesByChannel[channelId] = state.messagesByChannel[channelId].filter((m) => m.id !== msgId);
    if (channelId === state.activeChannelId) renderMessages();
});

socket.on("user-typing", ({ serverId, channelId, username, displayName, isTyping }) => {
    if (serverId !== state.activeServerId) return;
    if (!state.typingUsers.has(channelId)) state.typingUsers.set(channelId, new Map());
    const map = state.typingUsers.get(channelId);
    if (isTyping) map.set(username, displayName || username);
    else map.delete(username);

    if (channelId === state.activeChannelId) {
        const names = Array.from(map.values());
        if ($("typing-bar")) $("typing-bar").textContent = names.length ? `${names.join(", ")} yazıyor...` : "";
    }
});

socket.on("dm-message", (msg) => {
    if (!msg || !state.me) return;
    const other = msg.from === state.me.username ? msg.to : msg.from;
    const dmOpen = $("dm-modal")?.classList.contains("show");

    if (dmOpen && state.activeDmPeer?.username === other) {
        appendDmBubble(msg);
    } else if (msg.from !== state.me.username) {
        state.dmUnread = true;
        renderServerRail();
        playTone(760, 0.09, "sine", 0.07);
        showToast(`💬 ${msg.fromDisplayName || msg.from}: ${(msg.text || "[Görsel]").slice(0, 60)}`, "info", 4000);
    }

    if (dmOpen) {
        socket.emit("dm-list", (convs) => {
            state.dmConversations = convs || [];
            renderDmConversations();
        });
    }
});

socket.on("voice-event", ({ type, serverId, channelId }) => {
    if (serverId === state.voiceServerId && channelId === state.voiceChannelId) {
        playTone(type === "join" ? 720 : 420, 0.06, "sine", 0.05);
    }
});

socket.on("voice-peer-joined", (payload) => {
    handlePeerJoinedVoice(payload);
});

socket.on("server-mute-status", (muted) => {
    state.serverMuted = Boolean(muted);
    applyMuteState();
    showToast(
        state.serverMuted ? "Yönetici tarafından susturuldunuz." : "Sunucu susturmanız kaldırıldı.",
        state.serverMuted ? "err" : "ok"
    );
});

socket.on("force-leave-voice", () => {
    leaveVoiceCleanup(false);
    showToast("Bulunduğunuz ses kanalı kapatıldı.", "info");
});

socket.on("voice-afk-moved", (payload) => {
    handleVoiceAfkMoved(payload);
});

socket.on("user-left-voice", (peerId) => {
    closePeer(peerId);
    state.voiceMembersCache.delete(peerId);
    pushOverlayState();
});

socket.on("screen-share-stopped", (peerId) => {
    const cached = state.voiceMembersCache.get(peerId);
    if (cached) {
        cached.screenSharing = false;
        cached.screenStreamId = null;
    }
    const mem = state.members.find((m) => m.id === peerId);
    if (mem) {
        mem.screenSharing = false;
        mem.screenStreamId = null;
    }
    removeMediaTile("screen-" + peerId);
    renderChannels();
    renderMembers();
});

socket.on("cam-stopped", (peerId) => {
    const cached = state.voiceMembersCache.get(peerId);
    if (cached) {
        cached.camOn = false;
        cached.camStreamId = null;
    }
    const mem = state.members.find((m) => m.id === peerId);
    if (mem) {
        mem.camOn = false;
        mem.camStreamId = null;
    }
    removeMediaTile("cam-" + peerId);
    renderChannels();
    renderMembers();
});

socket.on("webrtc-offer", ({ from, offer }) => {
    handleIncomingOffer(from, offer);
});

socket.on("webrtc-answer", ({ from, answer }) => {
    handleIncomingAnswer(from, answer);
});

socket.on("webrtc-ice", ({ from, candidate }) => {
    handleIncomingIce(from, candidate);
});

socket.on("ready-check-update", ({ serverId, readyCheck, isNew }) => {
    if (serverId !== state.activeServerId) return;
    state.activeReadyCheck = readyCheck;
    renderReadyCheckBanner();
    if (isNew && readyCheck) {
        playTone(740, 0.1, "triangle", 0.08);
        setTimeout(() => playTone(980, 0.14, "triangle", 0.08), 110);
        showToast(`✅ ${readyCheck.initiatorName}: ${readyCheck.title}`, "info", 4000);
    }
});

socket.on("poll-update", ({ serverId, polls }) => {
    if (serverId !== state.activeServerId) return;
    state.serverPolls = polls || [];
    renderPollsList();
});

socket.on("watch-state", ({ serverId, watch }) => {
    if (serverId !== state.activeServerId) return;
    applyWatchState(watch);
});

socket.on("soundboard-play", ({ soundId, sender }) => {
    playSoundboardSynth(soundId);
    const item = SOUNDBOARD_ITEMS.find((i) => i.id === soundId);
    if (item) showToast(`${item.icon} ${sender}: ${item.label}`, "info", 1800);
});

socket.on("board-state", ({ serverId, board }) => {
    if (serverId !== state.activeServerId) return;
    applyBoardState(board);
});

socket.on("board-stroke", ({ serverId, stroke }) => {
    if (serverId !== state.activeServerId || !stroke) return;
    state.boardState.active = true;
    state.boardState.strokes.push(stroke);
    if ($("board-stage").style.display === "none") {
        applyBoardState(state.boardState);
    } else {
        redrawBoard();
    }
});

// =========================================================================
// BAŞLAT
// =========================================================================
applyPreferences();
initSoundboardGrid();
initTacticBoardEvents();
bindAllUIEvents();
initElectronSettingsUI();
startPingLoop();