const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const ROOT = __dirname;
let passed = 0;
let failed = 0;

function pass(msg) {
    passed++;
    console.log(`  [PASS] ${msg}`);
}

function fail(msg) {
    failed++;
    console.error(`  [FAIL] ${msg}`);
}

console.log("\n=== BizimDiscord v5.2 Otomatik Tester ===\n");

// 1. Sözdizimi Kontrolü
const allJsFiles = [
    "server.js",
    "electron-main.js",
    "preload.js",
    "src/db.js",
    "src/auth.js",
    "src/servers.js",
    "src/tools.js",
    "src/voice.js",
    "public/sw.js",
    "public/js/state.js",
    "public/js/audio.js",
    "public/js/webrtc.js",
    "public/js/health.js",
    "public/js/tools.js",
    "public/js/ui.js",
    "public/js/app.js"
];

console.log("1) Sözdizimi Denetimi");
for (const rel of allJsFiles) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
        fail(`Dosya eksik: ${rel}`);
        continue;
    }
    try {
        execFileSync(process.execPath, ["-c", full], { stdio: "pipe" });
        pass(rel);
    } catch (err) {
        fail(`${rel}: ${err.stderr?.toString().trim() || err.message}`);
    }
}

// 2. HTML DOM ID Bütünlük Denetimi (#h-audio tipi null hatalarını yakalar)
console.log("\n2) HTML <-> JS DOM ID Eşleşme Denetimi");
const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsModuleFiles = allJsFiles.filter((f) => f.startsWith("public/js/"));
const missingIds = new Set();

for (const rel of jsModuleFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/\$\("([^"]+)"\)/g)) {
        const id = m[1];
        if (!htmlIds.has(id)) missingIds.add(`${rel} -> #${id}`);
    }
}

if (missingIds.size === 0) {
    pass("Tüm $('id') referansları public/index.html içinde mevcut.");
} else {
    for (const item of missingIds) fail(`Eksik DOM ID: ${item}`);
}

if (!html.includes('id="hidden-audio-sink" style="display:none;"')) {
    pass("#hidden-audio-sink display:none olmadan layout-aktif tanımlı.");
} else {
    fail("#hidden-audio-sink hâlâ display:none içeriyor.");
}

// 3. ES Modül Import / Export Sözleşme Denetimi
console.log("\n3) Frontend ES Modül Import/Export Denetimi");
const exportsByFile = new Map();
for (const rel of jsModuleFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const exps = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) {
        exps.add(m[1]);
    }
    exportsByFile.set(path.basename(rel), exps);
}

let importErrors = 0;
for (const rel of jsModuleFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from\s+"\.\/([^"]+)"/g)) {
        const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        const targetFile = m[2];
        const targetExports = exportsByFile.get(targetFile);
        if (!targetExports) {
            fail(`${rel}: hedef modül bulunamadı (${targetFile})`);
            importErrors++;
            continue;
        }
        for (const n of names) {
            if (!targetExports.has(n)) {
                fail(`${rel}: '${n}' sembolü ${targetFile} içinden export edilmiyor.`);
                importErrors++;
            }
        }
    }
}
if (importErrors === 0) pass("Tüm ES modül import/export bağları %100 uyumlu.");

// 4. DB v4->v5 Migrasyon & TURN Env Birim Testi
console.log("\n4) DB Migrasyon & TURN ICE Birim Testleri");
try {
    process.env.TURN_URL = "turn:test.relay.example:3478";
    process.env.TURN_USER = "tester";
    process.env.TURN_PASS = "secret";
    const dbMod = require("./src/db");

    const migrated = dbMod.normalizeDB({
        version: 4,
        users: {
            alice: { salt: "aa", hash: "bb", role: "admin", displayName: "Alice" }
        },
        settings: { serverName: "TestV4", inviteCode: "OLD123" },
        channels: [{ id: "genel", name: "genel", type: "text" }],
        messages: { genel: [{ id: "m1", text: "selam" }] }
    });

    if (migrated.version === 5 && migrated.servers["srv-main"]?.name === "TestV4" && migrated.servers["srv-main"]?.members?.alice) {
        pass("v4 -> v5 otomatik DB migrasyonu başarılı.");
    } else {
        fail("v4 -> v5 DB migrasyonu beklenen yapıyı üretmedi.");
    }

    const ice = dbMod.getServerIceServers(migrated.servers["srv-main"]);
    if (ice.some((x) => x.urls === "turn:test.relay.example:3478" && x.username === "tester")) {
        pass("Render TURN_URL/TURN_USER/TURN_PASS ortam değişkenleri ICE listesine eklendi.");
    } else {
        fail("TURN ortam değişkeni ICE listesinde bulunamadı.");
    }
} catch (err) {
    fail("src/db.js birim testi hata verdi: " + err.message);
}

// 5. Canlı HTTP /health & Modül Servisi Testi (Geçici Port 3999)
console.log("\n5) Canlı Sunucu Başlatma & /health CORS Testi");
const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: "3999" },
    stdio: "pipe"
});

function httpGet(urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:3999${urlPath}`, (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on("error", reject);
    });
}

setTimeout(async () => {
    try {
        const h = await httpGet("/health");
        const j = JSON.parse(h.body);
        if (h.status === 200 && j.ok === true && h.headers["access-control-allow-origin"] === "*") {
            pass(`/health 200 OK + CORS (*) + v${j.version}`);
        } else {
            fail(`/health beklenmeyen yanıt: ${h.status} ${h.body}`);
        }

        const appMod = await httpGet("/js/app.js");
        if (appMod.status === 200 && appMod.headers["content-type"]?.includes("javascript")) {
            pass("GET /js/app.js 200 OK (ES modül servis ediliyor).");
        } else {
            fail(`GET /js/app.js başarısız: ${appMod.status}`);
        }
    } catch (err) {
        fail("Sunucu erişim testi başarısız: " + err.message);
    } finally {
        child.kill();
        console.log(`\nSonuç: ${passed} geçti, ${failed} başarısız.\n`);
        process.exit(failed > 0 ? 1 : 0);
    }
}, 1500);