# Feature: Claude Code Tabanlı Canlı Workflow Motoru

## Overview

Studio'nun bugünkü iki motorlu yapısını (Claude Code için `stream-json` canlı oturumu, diğer agent'lar için `prompt.md` yazıp her turda yeni süreç başlatan replay motoru) tek bir Claude Code motoruyla değiştirir. `bug-sweep` dışındaki tüm workflow'lar — `enhancement`, `feature`, `specIssue`, `merge` ve feature build — tek ve uzun ömürlü bir `claude -p` süreci üzerinde yürür; insan cevapları aynı stdin'e yeni kullanıcı mesajı olarak gider, `prompt.md` ve transkript replay'i tamamen kalkar. Model ve effort seçimi Studio arayüzüne taşınır ve her workflow için ayrı saklanır; provider kataloğu yoktur, Claude ortam değişkenleri Settings üzerinden yönetilir. Her oturum kendi git worktree'sinde çalıştığı için oturumlar sınırsız eşzamanlı olabilir; `bug-sweep` ana checkout'ta tek seferlik Claude çağrısı olarak kalır ama o da Claude-only olur ve model/effort seçimi sunar. `docs/sdd/features/acp-live-session/spec.md` bu spec ile deprecated sayılır.

## Specs

### Kapsam ve Ajan Desteği

**SP-1 — Tek desteklenen agent Claude Code'dur.** Studio'daki `Claude / Cursor / OpenCode / Codex / Antigravity / Custom` preset listesi, serbest `agentCmd` alanı ve `agentPreset` ayarı kaldırılır; tüm workflow'lar sabit `claude` çalıştırır. Özel komut kaçış kapısı yoktur.

**SP-2 — `bug-sweep` tek seferlik akışında kalır.** Canlı motora taşınmaz; Claude-only olur ve model/effort seçimi sunar.

**SP-3 — `bug-sweep` dışındaki tüm workflow'lar canlı motora taşınır:** `enhancement`, `feature`, `specIssue`, `merge` ve feature build.

**SP-4 — Mevcut `acp-live-session` spec'i deprecated'dır.** Bu spec, ACP/çoklu-harness planının yerine geçer.

### Canlı Oturum Motoru

**SP-5 — Her oturum tek ve uzun ömürlü bir `claude -p` sürecidir.** Süreç `--input-format stream-json`, `--output-format stream-json` ve `--include-partial-messages` ile başlatılır ve iş bitene kadar kapanmaz.

**SP-6 — Cevaplar aynı stdin'e yeni kullanıcı mesajı olarak yazılır.** Tur başına yeni süreç başlatılmaz; transkript hiçbir koşulda agent'a geri gönderilmez. `prompt.md` üretimi ve replay-per-turn motoru kaldırılır.

**SP-7 — Konuşma bağlamının sahibi Claude'dur.** Studio yalnızca insan tarafından okunabilen görüntü ve denetim kaydı tutar.

**SP-8 — Oturum Studio sürecine bağlıdır.** Tarayıcı yenilenmesi veya SSE kopması aynı oturuma yeniden bağlanır; `sdd studio` yeniden başlarsa oturum biter ve kaldığı yerden devam ettirilmez.

**SP-9 — Beklenmedik süreç çıkışı oturumu başarısız yapar.** Otomatik `--resume`, yeniden deneme veya transkript replay'i yoktur; worktree temizlenir.

**SP-10 — Mevcut izin davranışı korunur.** `Read`, `Grep`, `Glob` ön onaylıdır; diğer araçlar hook üzerinden Studio arayüzüne sorulur. Merge akışında deterministik merge-guard `allow`/`deny` kararları korunur; 50 saniye içinde yanıtlanmayan istek reddedilir.

### Model, Effort ve Claude Ortamı

**SP-11 — Model ve effort her workflow için ayrı seçilir.** Seçim workflow'un oturum başlangıç formunda yapılır; oturum başladıktan sonra kilitlenir. Model serbest metindir; boş bırakılırsa Claude ortamındaki model kullanılır.

**SP-12 — Formdaki değer workflow varsayılanıdır.** Değişiklik otomatik kaydedilir ve sonraki oturumlar aynı değerle açılır; oturum bazında sessiz sapma yoktur.

**SP-13 — Claude ortam değişkenleri Studio Settings'te yönetilir.** `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*` ve `CLOUD_ML_*` değerleri düz bir harita olarak saklanır ve yalnızca o oturumun `claude` sürecine verilir; Studio'nun kendi ortamı değişmez. Model id listesi koda gömülmez: öneriler Claude Code `/model` çıktısından ve ortam değişkenlerindeki model değerlerinden gelir.

**SP-14 — Effort seviyeleri `low`, `medium`, `high`, `xhigh`, `max`; model ve effort için `Default` seçeneği vardır.** `Default` seçildiğinde ilgili CLI bayrağı hiç gönderilmez ve Claude'un kendi yapılandırması kullanılır.

**SP-15 — Geçersiz effort seçimi süreç başlamadan reddedilir.** Model serbest metin olduğu için katalog doğrulaması yapılmaz; geçersiz effort için açıklayıcı hata döner ve sessiz fallback yapılmaz.

**SP-16 — `bug-sweep` de aynı model/effort seçimini ve Claude ortamını kullanır.** Seçim kendi başlangıç formunda yapılır, workflow bazında saklanır ve `claude` çağrısına uygulanır.

### Worktree ve Eşzamanlılık

**SP-17 — Her canlı oturum kendi git worktree'sinde çalışır.** Worktree `.sdd/worktrees/<session-id>` altında, seçilen base branch'ten yeni bir branch açılarak oluşturulur; ana checkout'a hiç dokunulmaz.

**SP-18 — Eşzamanlı oturum sayısı sınırsızdır.** Aynı workflow'da birden fazla canlı oturum çalışabilir; her biri kendi worktree'sine ve kendi Claude sürecine sahiptir.

**SP-19 — Worktree her durumda silinir.** Başarı, hata ve stop durumlarında worktree kaldırılır; yarım iş korunmaz, gerektiğinde oturum baştan başlatılır. Orphan worktree bırakılmaz.

**SP-20 — `bug-sweep` ana checkout'ta kalır ve tek aktif sweep kuralına uyar.** Canlı oturumlarla paralel çalışabilir; oturumlar worktree'lerde olduğu için çakışmaz.

### Feature: Spec → Build

**SP-21 — Feature oturumu spec interview'ı ve build'i aynı `claude` sürecinde yürütür.** Spec yazıldıktan sonra build için yeni süreç açılmaz.

**SP-22 — Spec geçişi yapısaldır.** Tur bittiğinde yeni veya değişmiş `spec.md` tespit edilir; agent metni yorumlanmaz. UI build seçim kartını açar ve Claude süreci idle bekler.

**SP-23 — Build yolu insan tarafından seçilir.** Kullanıcı `direct` veya `tdd` pipeline'ını ve `verify` seçeneğini belirler; "Start build" ile build skill çağrısı aynı stdin'e yazılır.

**SP-24 — Pipeline adımları aynı oturumda sırayla yürür.** Her adım ayrı bir tur olarak yazılır (`tdd`: `spec-to-task` → `feature-tdd`); adımlar UI'da ayrı işaretlenir ve hata hangi adımda oluştuysa o adımda raporlanır.

**SP-25 — Build aynı job ve aynı SSE akışıdır.** Ayrı `feature-build` job tipi ve `/api/features/:id/build/*` endpoint'leri kaldırılır.

### Publish ve Çıktı

**SP-26 — `enhancement` ve `feature` her zaman publish eder.** Worktree branch'i commit'lenir ve push edilir; merge request açmak opsiyonel bir checkbox'tır ve varsayılan olarak seçilidir.

**SP-27 — `specIssue` commit veya push yapmaz.** Spec yazıldığında `docs/sdd/features/<name>/spec.md` ana checkout'a kopyalanır, worktree silinir ve tracker issue bu dosyadan oluşturulur.

**SP-28 — Merge worktree'si target branch'ten açılır.** Agent merge'ü orada dry-run eder ve integration branch'ini üretir; target'ı güncellemek ayrı bir "land" eylemidir.

**SP-29 — Oturum bitişi yapısaldır.** Feature'da build tamamlanması, merge'de integration ref'in oluşması, `specIssue`'da tracker handoff'u, `enhancement`'ta insanın "Finish" kararı oturumu bitirir.

### Studio Arayüzü

**SP-30 — Her workflow sekmesinde oturum listesi vardır.** "New session" ile birlikte son 20 oturum; her satırda durum, model/effort ve branch gösterilir. Eylemler: aç, durdur (aktifse), geçmişten kaldır.

**SP-31 — Oturum başlangıç formunda model, effort ve MR checkbox'ı bulunur.** Agent veya provider seçimi yoktur; form workflow bazında hatırlanır.

**SP-32 — Build aşaması aynı transcript içinde görünür.** Aşama ayırıcıları ve adım işaretleri kullanılır; ayrı build paneli yoktur.

**SP-33 — Varsayılan görünüm yalnızca anlamlı olayları gösterir.** Agent metni, sorular, izin istekleri, artifact kilometre taşları, aşama/adım işaretleri ve hatalar görünür; tool çağrıları tek satırlık katlanabilir "working" özetine iner. Ham `stream-json` yalnızca Raw sekmesinde sunulur ve stderr transkripte karışmaz.

**SP-34 — "Stop" iki aşamalı onay ister.** Onaylanınca süreç sonlandırılır ve worktree silinir; oturum geçmişte `stopped` olarak kalır.

**SP-35 — Oturum başlığında kilitli model/effort görünür.** Kullanıcı oturum sırasında bu değerleri değiştiremez.

### Kayıt ve Geçmiş

**SP-36 — Oturum kaydı dosya tabanlıdır.** `.sdd/sessions/<flow>/<id>/session.json` meta veriyi, `session.md` ise her turda güncellenen okunabilir konuşma kaydını taşır.

**SP-37 — Studio yeniden başladığında geçmiş diskten yüklenir.** Geçmiş listesi salt-okunurdur; oturum devam ettirilemez, yalnızca incelenebilir.

**SP-38 — Eski agent ayarları kaldırılır.** Kayıtlı `agentPreset` ve `agentCmd` değerleri yok sayılır; Studio ayarları workflow bazlı model/effort ve Claude ortamı yapısına geçer.

## User Stories

| ID | User Story | Acceptance Criteria | Priority |
|----|------------|---------------------|----------|
| US-01 | Sürücü olarak, bir workflow boyunca tek Claude oturumunda konuşmak istiyorum; böylece her cevapta bağlam yeniden gönderilmez. | - AC-01.1 Oturum tek `claude -p` süreci olarak başlar ve iş bitene kadar kapanmaz.<br>- AC-01.2 İnsan cevapları aynı stdin'e yeni kullanıcı mesajı olarak gider; tur başına süreç başlatılmaz.<br>- AC-01.3 `prompt.md` üretilmez ve transkript agent'a geri gönderilmez. | Must have |
| US-02 | Operatör olarak, her workflow için model ve effort seçmek istiyorum; böylece doğru maliyet/kalite dengesini workflow bazında kurabilirim. | - AC-02.1 Seçim workflow setup formunda yapılır ve workflow bazında saklanır.<br>- AC-02.2 Oturum başladıktan sonra seçim kilitlenir ve başlıkta görünür.<br>- AC-02.3 `Default` seçilirse ilgili CLI bayrağı gönderilmez; geçersiz effort süreç başlamadan reddedilir. | Must have |
| US-03 | Operatör olarak, `feature` akışında spec ve build'i aynı oturumda yürütmek istiyorum; böylece spec bağlamı kaybolmaz. | - AC-03.1 Spec yazıldığında Studio build seçim kartını açar ve süreç idle bekler.<br>- AC-03.2 Seçilen pipeline adımları aynı oturumda sırayla yürür ve adım işaretleri görünür.<br>- AC-03.3 Build aynı job ve SSE akışında kalır; ayrı `feature-build` job'ı oluşmaz. | Must have |
| US-04 | Operatör olarak, birden fazla oturumu paralel çalıştırmak istiyorum; böylece uzun interview'lar diğer işleri kilitlemez. | - AC-04.1 Her canlı oturum `.sdd/worktrees/<session-id>` altında kendi worktree'sinde çalışır; ana checkout değişmez.<br>- AC-04.2 Aynı workflow'da birden fazla canlı oturum başlatılabilir.<br>- AC-04.3 `bug-sweep` ana checkout'ta tek aktif sweep olarak oturumlarla paralel çalışabilir. | Must have |
| US-05 | Operatör olarak, worktree'lerin birikmemesini istiyorum; böylece disk ve branch listesi temiz kalır. | - AC-05.1 Worktree başarı, hata ve stop durumlarında silinir.<br>- AC-05.2 "Stop" worktree'yi sileceğini açık bir onayla belirtir.<br>- AC-05.3 Yarım iş korunmaz; gerektiğinde oturum baştan başlatılır. | Must have |
| US-06 | Kullanıcı olarak, konuşmada yalnızca anlamlı olayları görmek istiyorum; böylece tool gürültüsü interview'ı boğmaz. | - AC-06.1 Varsayılan görünümde agent metni, sorular, izinler, artifact ve aşama/adım işaretleri görünür.<br>- AC-06.2 Tool çağrıları tek satırlık katlanabilir "working" özetine iner.<br>- AC-06.3 Ham akış yalnızca Raw sekmesinde sunulur ve stderr transkripte karışmaz. | Must have |
| US-07 | Sürücü olarak, tarayıcı yenilendiğinde oturuma geri dönmek istiyorum; böylece uzun iş akışı kesilmez. | - AC-07.1 Sayfa yenilenince çalışan oturum aynı SSE akışına yeniden bağlanır.<br>- AC-07.2 Studio yeniden başlarsa oturum biter; otomatik resume yapılmaz.<br>- AC-07.3 Geçmiş, `.sdd/sessions/<flow>/<id>` kayıtlarından salt-okunur yüklenir. | Should have |
| US-08 | Platform sahibi olarak, Studio'yu yalnızca Claude Code ile çalışacak şekilde sadeleştirmek istiyorum; böylece test edilmeyen agent yüzeyleri kalkar. | - AC-08.1 Agent preset listesi, `agentCmd` alanı ve `agentPreset` ayarı kaldırılır.<br>- AC-08.2 Tüm workflow'lar sabit `claude` çalıştırır; özel komut kaçış kapısı yoktur.<br>- AC-08.3 `bug-sweep` de Claude-only olur, canlı motora taşınmaz ve model/effort seçimi sunar. | Must have |
| US-09 | Operatör olarak, oturum çıktısının güvenli biçimde yayınlanmasını istiyorum; böylece değişiklikler doğru branch'e gider. | - AC-09.1 `enhancement` ve `feature` her zaman worktree branch'ini commit'ler ve push eder; MR checkbox'ı opsiyoneldir.<br>- AC-09.2 `specIssue` commit/push yapmaz; spec ana checkout'a kopyalanır ve tracker issue açılır.<br>- AC-09.3 Merge worktree'si target'tan açılır ve target yalnızca ayrı "land" eylemiyle güncellenir. | Must have |
| US-10 | Operatör olarak, bir hata olduğunda oturumun dürüst biçimde bitmesini istiyorum; böylece yarım bağlamla yanlış devam edilmez. | - AC-10.1 Beklenmedik süreç çıkışı oturumu `failed` yapar.<br>- AC-10.2 Otomatik resume, retry veya transkript replay'i yapılmaz.<br>- AC-10.3 Hata durumunda worktree silinir ve oturum geçmişte kayıtlı kalır. | Must have |

## Visual Mock

### Topoloji

```
┌──────────────────────────── Studio (tek Node süreci) ────────────────────────────┐
│                                                                                  │
│  Web UI ──HTTP/SSE──▶ session registry (N eşzamanlı oturum)                       │
│                         │                                                        │
│                         ├─ worktree: .sdd/worktrees/<id> ──▶ claude -p (live)    │
│                         ├─ worktree: .sdd/worktrees/<id> ──▶ claude -p (live)    │
│                         └─ main checkout ──▶ bug-sweep (tek seferlik, max 1)      │
│                                                                                  │
│  settings: claude env · workflow model/effort · publish tercihleri                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Workflow sekmesi ve oturum listesi

```
Feature
┌──────────────────────────────────────────────────────────────────────────────┐
│ › New session                                                                │
│ ● saved-searches    sonnet/medium   sdd/feature/saved-searches-a1b2   live     │
│ ● retry-backoff     opus/high       sdd/feature/retry-backoff-c3d4    needs you│
│ ✓ dark-mode         haiku/low       sdd/feature/dark-mode-e5f6        done     │
│ ✕ import-csv        sonnet/medium   —                                 failed   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Oturum başlangıç formu

```
New feature session
  model [Default (environment) ▾]  effort [medium ▾]
  ☑ Open a merge request
  brief: ______________________________________________________
  [Start]
```

### Feature: aynı oturumda spec → build

```
Agent  ... birkaç şeyi netleştirelim ...
You    ...
       ── spec.md yazıldı ──
       [Direct] [TDD]  ☑ Verify each story   [Start build]
       ── build · TDD ──
         step 1/2  spec-to-task    ✓
         step 2/2  feature-tdd     running
         ▸ working — npm test
       ── build done · branch pushed ──
```

### Worktree yaşam döngüsü

```
create  .sdd/worktrees/<id>  (new branch from base)
run     claude -p  (interview → build)
done    commit → push (MR optional) → remove worktree
stop    confirm → kill → remove worktree
fail    kill → remove worktree → session failed
```
