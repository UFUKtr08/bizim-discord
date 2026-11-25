import { socket, state, $, escapeHTML, showToast } from "./state.js";
import { sendOfferToPeer } from "./webrtc.js";

function setText(id, val) {
    const el = $(id);
    if (el) el.textContent = val;
}

export function updateHealthPill(ms) {
    if (typeof ms === "number") state.lastPingMs = ms;
    const badge = $("ping-badge");
    const dot = $("health-dot");
    if (!badge || !dot) return;

    let anyBad = false;
    let anyWarn = false;
    for (const p of state.peers.values()) {
        const st = p.pc.connectionState;
        const ice = p.pc.iceConnectionState;
        if (st === "failed" || st === "disconnected" || ice === "failed" || ice === "disconnected") {
            anyBad = true;
        } else if (st === "connecting" || st === "new" || ice === "checking" || ice === "new") {
            anyWarn = true;
        }
    }

    badge.textContent = state.lastPingMs !== null ? `${state.lastPingMs} ms` : "-- ms";
    dot.className = "dot-ind";
    if (anyBad || (state.lastPingMs !== null && state.lastPingMs > 180)) dot.classList.add("bad");
    else if (anyWarn || (state.lastPingMs !== null && state.lastPingMs > 90)) dot.classList.add("warn");
}

function formatCandidatePath(lc, rc) {
    if (!lc && !rc) return "Aday aranıyor...";
    const lt = lc?.candidateType || "?";
    const rt = rc?.candidateType || "?";
    if (lt === "relay" || rt === "relay") return `TURN (${lt} ↔ ${rt})`;
    if (lt === "srflx" || rt === "srflx") return `STUN (${lt} ↔ ${rt})`;
    if (lt === "prflx" || rt === "prflx") return `NAT-Refl (${lt} ↔ ${rt})`;
    return `Yerel (${lt} ↔ ${rt})`;
}

export async function refreshHealthModal() {
    const t0 = Date.now();
    socket.emit("health-info", (info) => {
        if (!info || !info.ok) return;
        const ms = Date.now() - t0;
        updateHealthPill(ms);

        setText("h-ping", `${ms} ms`);
        setText("h-ram", `${info.memRssMB} MB (${info.ramPct}%)`);
        setText("h-mesh-links", `${info.totalMeshLinks} (Odada maks ${info.maxRoomVoice})`);
        setText("h-cpu-db", `%${info.processCpuPct} / ${info.dbSizeKB} KB`);

        const score = info.strainScore || 0;
        setText("h-strain-level", info.level || "Rahat");
        setText("h-strain-score", `${score} / 100`);
        setText("h-scale-advice", info.recommendation || "");

        const bar = $("h-strain-bar");
        if (bar) {
            bar.style.width = `${score}%`;
            if (score >= 75) bar.style.background = "var(--danger)";
            else if (score >= 45) bar.style.background = "var(--warning)";
            else bar.style.background = "var(--success)";
        }
    });

    setText("h-audio", state.sharedAudioCtx ? state.sharedAudioCtx.state : "Hazır");
    const hasTurn = Boolean(state.hasTurnConfigured || state.serverSettings?.hasTurnConfigured);
    setText("h-turn-state", hasTurn ? "Tanımlı" : "Yok (Yalnız STUN)");

    const parts = [];
    parts.push(state.voiceChannelId ? "Ses: Bağlı" : "Ses: Bağlı değil");
    if (state.camStream) {
        const s = state.camStream.getVideoTracks()[0]?.getSettings();
        parts.push(`Kamera: ${s?.width || "?"}x${s?.height || "?"} @${Math.round(s?.frameRate || 0)}fps`);
    }
    if (state.screenStream) {
        const s = state.screenStream.getVideoTracks()[0]?.getSettings();
        parts.push(`Ekran: ${s?.width || "?"}x${s?.height || "?"} @${Math.round(s?.frameRate || 0)}fps`);
    }
    parts.push(`Noise Gate: ${state.gateThreshold > 0 ? state.gateThreshold + "%" : "Kapalı"}`);
    parts.push(`Oyun Modu: ${state.gameMode ? "AÇIK" : "Kapalı"}`);
    setText("h-local-summary", parts.join("  •  "));

    const tbody = $("h-peers-body");
    const turnBanner = $("h-turn-banner");
    const turnBannerMsg = $("h-turn-banner-msg");
    if (!tbody) return;

    if (state.peers.size === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="center muted-note">Aktif P2P bağlantısı yok.</td></tr>';
        if (turnBanner) turnBanner.style.display = "none";
        return;
    }

    const rows = [];
    let needsTurnWarning = false;
    let sameIpLoopbackSuspected = false;

    for (const [peerId, peer] of state.peers.entries()) {
        const m = state.voiceMembersCache.get(peerId) || state.members.find((x) => x.id === peerId);
        const name = escapeHTML(m?.displayName || m?.username || peerId.slice(0, 6));

        const iceState = peer.pc.iceConnectionState || "new";
        const connState = peer.pc.connectionState || "new";
        const ageSec = (Date.now() - (peer.createdAt || Date.now())) / 1000;

        let pathType = "Bekleniyor...";
        let rttStr = "--";
        let pktSummary = "0 / 0";
        let upKbps = 0;
        let downKbps = 0;
        let packetsRecv = 0;
        let packetsSent = 0;

        try {
            const stats = await peer.pc.getStats();
            let bytesSent = 0;
            let bytesRecv = 0;
            let packetsLost = 0;
            let framesDecoded = 0;
            let activePair = null;
            const candidates = new Map();

            stats.forEach((r) => {
                if (r.type === "local-candidate" || r.type === "remote-candidate") {
                    candidates.set(r.id, r);
                }
                if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded")) {
                    if (!activePair || r.nominated) activePair = r;
                }
                if (r.type === "outbound-rtp" && !r.isRemote) {
                    bytesSent += r.bytesSent || 0;
                    packetsSent += r.packetsSent || 0;
                }
                if (r.type === "inbound-rtp" && !r.isRemote) {
                    bytesRecv += r.bytesReceived || 0;
                    packetsRecv += r.packetsReceived || 0;
                    packetsLost += r.packetsLost || 0;
                    if (r.kind === "video") framesDecoded += r.framesDecoded || 0;
                }
            });

            if (activePair) {
                if (typeof activePair.currentRoundTripTime === "number") {
                    rttStr = `${Math.round(activePair.currentRoundTripTime * 1000)} ms`;
                }
                const lc = candidates.get(activePair.localCandidateId);
                const rc = candidates.get(activePair.remoteCandidateId);
                pathType = formatCandidatePath(lc, rc);
                if (lc?.candidateType === "srflx" && rc?.candidateType === "srflx" && lc.address && lc.address === rc.address) {
                    sameIpLoopbackSuspected = true;
                }
            }

            const totalPkt = packetsLost + packetsRecv;
            const lossPct = totalPkt > 0 ? `${((packetsLost / totalPkt) * 100).toFixed(1)}%` : "0%";
            pktSummary = framesDecoded > 0
                ? `${packetsRecv} pkt • ${framesDecoded} kare (${lossPct})`
                : `${packetsRecv}↓ / ${packetsSent}↑ (${lossPct})`;

            const now = Date.now();
            if (peer.lastStats) {
                const dt = Math.max(0.2, (now - peer.lastStats.ts) / 1000);
                upKbps = Math.max(0, Math.round(((bytesSent - peer.lastStats.bytesSent) * 8) / (dt * 1000)));
                downKbps = Math.max(0, Math.round(((bytesRecv - peer.lastStats.bytesRecv) * 8) / (dt * 1000)));
            }
            peer.lastStats = { ts: now, bytesSent, bytesRecv };
        } catch { }

        const stuckNoMedia =
            iceState === "failed" ||
            connState === "failed" ||
            (ageSec > 6 && (iceState === "checking" || iceState === "new" || connState === "connecting")) ||
            (ageSec > 7 && packetsRecv === 0);

        if (stuckNoMedia) needsTurnWarning = true;

        const stateColor =
            iceState === "failed" || connState === "failed"
                ? "var(--danger)"
                : (iceState === "connected" || iceState === "completed") && packetsRecv > 0
                    ? "var(--success)"
                    : "var(--warning)";

        rows.push(`
            <tr>
                <td>${name}</td>
                <td>${escapeHTML(pathType)}</td>
                <td style="color:${stateColor}; font-weight:600;">${escapeHTML(iceState)} / ${escapeHTML(connState)}</td>
                <td>${rttStr}</td>
                <td>${escapeHTML(pktSummary)}</td>
                <td>${upKbps} / ${downKbps} kbps</td>
                <td><button class="btn xs secondary" data-ice-restart="${escapeHTML(peerId)}">Yenile</button></td>
            </tr>
        `);
    }

    tbody.innerHTML = rows.join("");
    tbody.querySelectorAll("[data-ice-restart]").forEach((btn) => {
        btn.onclick = () => {
            const pid = btn.getAttribute("data-ice-restart");
            sendOfferToPeer(pid, true);
            showToast("ICE bağlantısı yenileniyor...", "info", 1800);
        };
    });

    if (turnBanner && turnBannerMsg) {
        if (needsTurnWarning) {
            turnBanner.style.display = "flex";
            turnBanner.className = hasTurn ? "info-banner warn" : "info-banner danger";
            if (!hasTurn) {
                turnBannerMsg.textContent = sameIpLoopbackSuspected
                    ? "Aynı ağda NAT Hairpinning / Güvenlik Duvarı engeli tespit edildi — TURN sunucusu gerekli! (Ayarlar → Sunucu & Roller → TURN veya Render ortam değişkeni: TURN_URL / TURN_USER / TURN_PASS)"
                    : "CGNAT / Simetrik NAT veya güvenlik duvarı yüzünden P2P medya akışı kurulamadı — TURN sunucusu gerekli! (Ayarlar → Sunucu & Roller → TURN veya Render env: TURN_URL / TURN_USER / TURN_PASS)";
            } else {
                turnBannerMsg.textContent = "TURN tanımlı ancak medya paketi akmıyor. TURN adresini/kimlik bilgilerini kontrol edin veya 'Yenile' ile ICE Restart deneyin.";
            }
        } else {
            turnBanner.style.display = "none";
        }
    }
}

export function startHealthPolling() {
    refreshHealthModal();
    stopHealthPolling();
    state.healthPollTimer = setInterval(refreshHealthModal, 1000);
}

export function stopHealthPolling() {
    if (state.healthPollTimer) {
        clearInterval(state.healthPollTimer);
        state.healthPollTimer = null;
    }
}

export function startPingLoop() {
    setInterval(() => {
        if (!socket.connected) return;
        const t0 = Date.now();
        socket.emit("ping-check", () => updateHealthPill(Date.now() - t0));
    }, 6000);
}